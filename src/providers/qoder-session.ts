/**
 * Qoder login: turn a pasted Personal Access Token into a stored session.
 *
 * Qoder has no OAuth and no device flow — the credential is a PAT the user mints
 * on the Qoder website — so this is the whole login path, and it doubles as the
 * validation step: nothing is persisted until the upstream has accepted the token
 * and named the account.
 *
 * ## Why the region is discovered rather than asked for
 *
 * Qoder runs two independent deployments (`qoder.com` and `qoder.com.cn`), and a
 * token minted on one is refused by the other. The hub serves both from ONE
 * `qoder` route, so the region has to be established before the session exists.
 *
 * The obvious design — make the user pick a region — is worse than it looks: the
 * two deployment names are not written on the token, users routinely have
 * accounts on both, and picking wrong produces an `AUTH` rejection that reads as
 * "your token is bad" rather than "you chose the wrong server". So the token is
 * simply tried against both deployments and the region is recorded from whichever
 * one accepted it.
 *
 * An explicit `region:` prefix still wins when the user knows, which also makes
 * the whole thing testable without a network.
 *
 * @module dsh-subscription-hub/providers/qoder-session
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import type { QoderRegion } from './qoder/index.js'
import { probeQoderPat } from './qoder/index.js'
import type { QoderSession } from '../auth/store.js'

/** Both deployments, in the order they are tried when no region is given. */
export const QODER_REGIONS: readonly QoderRegion[] = ['global', 'china']

/** A pasted token together with an explicitly requested region, if any. */
export interface QoderPasteInput {
  /** The token itself, trimmed. */
  pat: string
  /** The region the paste named, when it named one. */
  region?: QoderRegion
}

/**
 * Split an optional `<region>:` prefix off a pasted token.
 *
 * Accepts `global:`, `china:`, `intl:` and `cn:` (the last two are the words a
 * user is more likely to reach for), case-insensitively, with or without spaces.
 * Anything else is treated as the token itself — including a bare token that
 * happens to contain a colon, which is why only these four prefixes are stripped.
 * @param input - the raw pasted text.
 * @returns the token and the named region, when there was one.
 */
export function parseQoderPaste(input: string): QoderPasteInput {
  const trimmed = input.trim()
  // The token part is allowed to be EMPTY: `china:` is a user pinning a region
  // and then pasting nothing, which must be reported as a missing credential
  // rather than sent to the network as the literal string "china:".
  const prefixed = /^(global|intl|china|cn)\s*:\s*(.*)$/is.exec(trimmed)
  if (prefixed === null) return { pat: trimmed }
  const word = (prefixed[1] ?? '').toLowerCase()
  return {
    pat: (prefixed[2] ?? '').trim(),
    region: word === 'global' || word === 'intl' ? 'global' : 'china',
  }
}

/**
 * Validate a pasted PAT and build the session to store.
 *
 * Tries each candidate region in turn and keeps the first that accepts the token.
 * When every candidate refuses it, the error surfaced is the FIRST candidate's,
 * because that is the one an unqualified token was most likely minted for — but
 * the message says both were tried, so a user with a China account is not left
 * thinking their token is broken.
 * @param input - the raw pasted text.
 * @param fetchFn - injectable fetcher for tests; defaults to the global fetch.
 * @param signal - optional cancellation.
 * @returns the session to persist.
 * @throws {LlmError} `MISSING_CREDENTIAL` for empty input, `AUTH` when every
 *   deployment refuses the token, or the transport failure when none answered.
 */
export async function qoderSessionFromPaste(
  input: string,
  fetchFn?: typeof fetch,
  signal?: AbortSignal,
): Promise<QoderSession> {
  const parsed = parseQoderPaste(input)
  if (parsed.pat === '') {
    throw new LlmError(
      'Qoder: paste a Personal Access Token (mint one at qoder.com/account/integrations, or qoder.com.cn for the China deployment).',
      'MISSING_CREDENTIAL',
    )
  }
  const candidates = parsed.region === undefined ? QODER_REGIONS : [parsed.region]

  /** Codes that mean the deployment never rendered a verdict on the token. */
  const noVerdictCodes = new Set(['TRANSPORT', 'TIMEOUT', 'ABORTED'])
  let firstFailure: unknown
  // Whether any deployment ANSWERED. Distinct from "accepted": a 401 is an
  // answer, and conflating the two made a refused token surface as the raw
  // upstream error instead of the message that explains both were tried.
  let gotVerdict = false
  for (const region of candidates) {
    try {
      const probe = await probeQoderPat(parsed.pat, region, fetchFn, signal)
      return {
        // The job token the probe just minted, with the PAT kept beside it: the
        // PAT is the durable secret a refresh exchanges, exactly as
        // `refreshToken` is for every other route.
        accessToken: probe.jobToken,
        refreshToken: parsed.pat,
        expiresAt: probe.expiresAt,
        ...probe.userId === undefined ? {} : { userId: probe.userId },
        ...probe.name === undefined ? {} : { account: probe.name },
        region,
      }
    } catch (error) {
      // A caller cancellation is the caller's, not a reason to try the other
      // deployment.
      signal?.throwIfAborted()
      firstFailure ??= error
      const code = error instanceof LlmError ? error.code : undefined
      if (code === undefined || !noVerdictCodes.has(code)) gotVerdict = true
      // A transport failure is not a verdict on the token, so the next
      // deployment is still worth asking.
    }
  }

  if (!gotVerdict) {
    // Nothing answered at all: report the transport problem rather than dressing
    // it up as a rejected credential.
    throw firstFailure instanceof LlmError
      ? firstFailure
      : new LlmError(`Qoder: could not reach either deployment. ${String(firstFailure)}`, 'TRANSPORT')
  }

  throw new LlmError(
    candidates.length > 1
      ? 'Qoder: the token was refused by both the global (qoder.com) and China (qoder.com.cn) deployments. Check the token is current, or prefix it with "global:" or "china:" to pin the region.'
      : `Qoder: the token was refused by the ${candidates[0] ?? 'global'} deployment.`,
    'AUTH',
    ...(firstFailure === undefined ? [] : [{ cause: firstFailure }]),
  )
}