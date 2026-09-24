/**
 * Live models.dev lab badges for the model list: the disk-cached store behind
 * the `labBadges` endpoint.
 *
 * ## Why this exists
 *
 * The vendored set in `client/lab-badges.ts` is a snapshot taken when the plugin
 * was built, and a model list must show a lab's mark as soon as models.dev has
 * one — including for a lab that had none at build time. So the client asks this
 * store for the labs it has no mark for, and this store answers with a real
 * models.dev logo: the vendored copy when there is one, else the disk cache, else
 * one live fetch that is then cached.
 *
 * ## What it refuses to do
 *
 * - **Never invent a mark.** A lab models.dev has no logo for answers HTTP 200
 *   with a generic placeholder (see `lab-logo.ts`), so this store asks what "no
 *   logo" looks like RIGHT NOW — via a slug that cannot exist — and compares.
 *   When the answer is "no logo", the lab is simply absent from the result and
 *   the row draws nothing. There is no letter, no monogram, no borrowed mark.
 * - **Never cache an absence.** A lab with no logo today may have one
 *   tomorrow, so "no logo" is remembered in memory for this process only. The
 *   next start re-asks, which is what keeps a newly published logo appearing
 *   without a code change; persisting the absence would silently freeze it.
 * - **Never latch a failure.** A network error or an unreadable cache is "could
 *   not tell", not "no logo": nothing is recorded, and the attempt is retried
 *   after {@link PROBE_COOLDOWN_MS} rather than on every render.
 *
 * @module dsh-subscription-hub/lab-badge-store
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { LAB_BADGES, LAB_BADGE_SOURCE } from './client/lab-badges.js'
import {
  IMPOSSIBLE_LAB_SLUG,
  LAB_SLUG_PATTERN,
  isRealLabLogo,
  isRenderableLabLogo,
  labLogoUrl,
  normalizeLabLogo,
} from './lab-logo.js'

/**
 * How long a failed probe suspends further probing.
 *
 * A failure is not a fact, so it must not be cached — but an offline host would
 * otherwise spend two requests per lab on every visibility load. Within the
 * window nothing is served and nothing is recorded; after it the store tries
 * again.
 */
export const PROBE_COOLDOWN_MS = 60_000

/** Per-request ceiling: a badge is a nicety, and the row may draw nothing. */
const REQUEST_TIMEOUT_MS = 20_000

/** Where the fetched badges are cached. */
export function labBadgesPath(): string {
  return dshHomePath('plugins', 'subscriptions', 'lab-badges.json')
}

/** The badge store the `labBadges` endpoint answers from. */
export interface LabBadgeStore {
  /**
   * The real models.dev logos for these labs, keyed by slug.
   *
   * A lab with no logo is ABSENT from the result rather than mapped to
   * something drawable, so a caller cannot mistake the answer for a mark.
   * @param labs - the slugs to resolve.
   * @returns one entry per lab a real logo is known for.
   */
  badgesFor(labs: readonly string[]): Promise<Record<string, string>>
}

/** Wiring seams; every one of them defaults to production behaviour. */
export interface LabBadgeStoreOptions {
  /** HTTP client; defaults to the platform `fetch`. */
  fetchImpl?: typeof fetch
  /** Cache file; defaults to {@link labBadgesPath}. */
  path?: string
  /** Clock, for the file's timestamp and the failure cooldown. */
  now?: () => number
}

/** The cache file's shape. */
interface LabBadgeFile {
  source: string
  at: string
  badges: Record<string, string>
}

/**
 * Read one cache file into a slug → logo map.
 *
 * Every entry is re-validated on the way in: this file lives in the user's home
 * directory and its values are injected into the page as HTML, so a hand-edited
 * or truncated file must degrade to "no mark" rather than to a mangled one.
 */
function parseCache(text: string): Map<string, string> {
  const parsed: unknown = JSON.parse(text)
  const out = new Map<string, string>()
  if (typeof parsed !== 'object' || parsed === null) return out
  const entry: unknown = (parsed as { badges?: unknown }).badges
  if (typeof entry !== 'object' || entry === null) return out
  for (const [lab, markup] of Object.entries(entry as Record<string, unknown>)) {
    if (!LAB_SLUG_PATTERN.test(lab)) continue
    if (typeof markup !== 'string' || !isRenderableLabLogo(markup)) continue
    out.set(lab, markup)
  }
  return out
}

/**
 * Build a badge store.
 *
 * @param options - test seams (HTTP client, cache path, clock).
 * @returns the store the endpoint delegates to.
 */
export function createLabBadgeStore(options: LabBadgeStoreOptions = {}): LabBadgeStore {
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? Date.now
  const cachePath = options.path ?? labBadgesPath()
  /** Loaded once per process; the file is written only by this store. */
  let cache: Promise<Map<string, string>> | undefined
  /** Lab slugs models.dev has no logo for — this process only (see the header). */
  const absent = new Set<string>()
  /** Calls already asking models.dev for one lab, so a burst makes one request. */
  const inflight = new Map<string, Promise<string | undefined>>()
  let placeholder: string | undefined
  let probeFailedAt = 0

  /** GET one URL; undefined when the answer cannot be read as a body. */
  async function request(url: string): Promise<string | undefined> {
    try {
      const response = await fetchImpl(url, {
        headers: { accept: 'image/svg+xml' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      return response.ok ? await response.text() : undefined
    } catch {
      return undefined
    }
  }

  /**
   * What models.dev serves for a logo it does not have, live.
   *
   * Fetched rather than hardcoded: a byte length or a hash would pin the store to
   * today's placeholder, and the comparison is the whole availability test.
   * @returns the placeholder body, or undefined when it could not be read.
   */
  async function placeholderBody(): Promise<string | undefined> {
    if (placeholder !== undefined) return placeholder
    if (probeFailedAt !== 0 && now() - probeFailedAt < PROBE_COOLDOWN_MS) return undefined
    const body = await request(labLogoUrl(IMPOSSIBLE_LAB_SLUG))
    if (body === undefined || !isRenderableLabLogo(body)) {
      // Without this, "no logo" and "has a logo" cannot be told apart, so
      // nothing is served until the probe can be read.
      probeFailedAt = now()
      console.warn('subscriptions lab badges: models.dev placeholder probe unavailable; no badge is served')
      return undefined
    }
    placeholder = body
    return placeholder
  }

  /** Read the cache file once; an unreadable file is reported and treated as empty. */
  async function loadCache(): Promise<Map<string, string>> {
    if (cache !== undefined) return cache
    cache = (async () => {
      try {
        return parseCache(await readFile(cachePath, 'utf8'))
      } catch (error) {
        // A missing file is the normal first-run state; anything else is worth
        // saying out loud, because it silently costs a refetch of every badge.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn(`subscriptions lab badges: could not read ${cachePath}; badges will be refetched — ${String(error)}`)
        }
        return new Map<string, string>()
      }
    })()
    return cache
  }

  /** Rewrite the cache file: random-named temp then rename, so a reader never sees a partial file. */
  async function persist(badges: Map<string, string>): Promise<void> {
    const payload: LabBadgeFile = {
      source: LAB_BADGE_SOURCE,
      at: new Date(now()).toISOString(),
      badges: Object.fromEntries(badges),
    }
    await mkdir(dirname(cachePath), { recursive: true })
    // A pid-only name is shared by two writers in one process, which is why the
    // suffix is random — the same reason `startup-diagnostics.ts` does this.
    const tmp = `${cachePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    try {
      await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(tmp, cachePath)
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined)
      throw error
    }
  }

  /** Fetch one lab's logo, verify it, and cache it. */
  function startFetch(lab: string): Promise<string | undefined> {
    const started = (async () => {
      try {
        const placeholderText = await placeholderBody()
        // No probe means no way to tell a real logo from the placeholder, and
        // guessing is exactly what this module refuses to do.
        if (placeholderText === undefined) return undefined
        const body = await request(labLogoUrl(lab))
        // A transport failure is "could not tell": nothing is recorded, so the
        // next call retries instead of the lab staying dark for the session.
        if (body === undefined) return undefined
        if (!isRealLabLogo(body, placeholderText)) {
          absent.add(lab)
          return undefined
        }
        const markup = normalizeLabLogo(body)
        // Unreachable for a body that passed `isRealLabLogo`; returning keeps the
        // narrowing honest rather than asserting.
        if (markup === undefined) return undefined
        const badges = await loadCache()
        badges.set(lab, markup)
        await persist(badges).catch((error: unknown) => {
          // The mark is still correct and still served; only the cache is stale.
          console.warn(`subscriptions lab badges: could not write ${cachePath} — ${String(error)}`)
        })
        return markup
      } catch (error) {
        console.warn(`subscriptions lab badges: could not resolve ${lab} — ${String(error)}`)
        return undefined
      } finally {
        inflight.delete(lab)
      }
    })()
    inflight.set(lab, started)
    return started
  }

  return {
    async badgesFor(labs) {
      // Only slug-shaped requests: anything else names no lab, and a lab that
      // does not exist has no mark to fetch.
      const wanted = [...new Set(labs)].filter(lab => LAB_SLUG_PATTERN.test(lab))
      const badges: Record<string, string> = {}
      const pending: string[] = []
      for (const lab of wanted) {
        const vendored = LAB_BADGES[lab]
        if (vendored === undefined) {
          pending.push(lab)
          continue
        }
        // The vendored copy wins over the disk cache: it is the copy the running
        // build ships, so serving a cached older mark would be a regression.
        badges[lab] = vendored
      }
      if (pending.length === 0) return badges
      const cached = await loadCache()
      for (const lab of pending) {
        const hit = cached.get(lab)
        if (hit !== undefined) {
          badges[lab] = hit
          continue
        }
        if (absent.has(lab)) continue
        const markup = await (inflight.get(lab) ?? startFetch(lab))
        if (markup !== undefined) badges[lab] = markup
      }
      return badges
    },
  }
}