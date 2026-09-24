/**
 * The models.dev lab-logo contract: where the marks come from, which of them
 * are real, and how one is made safe to render.
 *
 * ## Why this module exists
 *
 * The model list shows the company behind each row, and the user asked for the
 * marks to be the ones models.dev publishes — "no icon when there is none,
 * never something you drew instead". A rule like that is easy to violate by
 * accident in a dozen places, so the whole rule lives here, once:
 *
 * 1. **models.dev is the only source.** {@link labLogoUrl} is the one URL
 *    shape; nothing draws a mark, and nothing reuses another company's.
 * 2. **A missing logo does NOT 404.** VERIFIED live: a slug models.dev has no
 *    logo for answers HTTP 200 with a ~1421-byte generic placeholder SVG, so
 *    neither the status code nor the content type distinguishes it. The only
 *    reliable test is comparing against what a slug that cannot exist returns.
 *    {@link isRealLabLogo} does exactly that, which is why it takes the
 *    placeholder as an argument instead of guessing from a byte length.
 * 3. **An absent fact renders as absent.** {@link vendorLabBadge} answers
 *    `undefined` for a lab it has no real logo for, and the caller draws
 *    nothing. There is deliberately no fallback here: no letter, no monogram,
 *    no generic circle, no other company's mark.
 *
 * ## Sizing
 *
 * The published logos disagree about their box (`0 0 24 24`, `0 0 32 32`,
 * `0 0 40 40`, `0 0 128 128`) and several omit `width`/`height` entirely, which
 * in a browser means the replaced-element default rather than the row's size.
 * {@link normalizeLabLogo} therefore keeps the logo's own `viewBox` — its
 * geometry is not ours to change — and pins width/height to the container, so
 * every mark lands in the same box whatever the source declared.
 *
 * Client-safe by construction: no node imports, so the browser bundle, the
 * host's cache and the generator script all speak this same contract.
 *
 * @module dsh-subscription-hub/lab-logo
 */

/** Prefix of every lab logo; {@link labLogoUrl} appends `{slug}.svg`. */
export const LAB_LOGO_BASE_URL = 'https://models.dev/logos/labs/'

/**
 * A slug that cannot name a lab, used to learn what "no logo" looks like RIGHT
 * NOW instead of hardcoding the placeholder's bytes. See {@link isRealLabLogo}.
 */
export const IMPOSSIBLE_LAB_SLUG = '__no-such-lab__'

/** Lab slug shape models.dev uses (`arcee-ai`, `motif-technologies`, `zhipuai`). */
export const LAB_SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/

/**
 * Markup that is never injected into the page.
 *
 * A vendored mark is inert by construction, but the runtime path fetches a
 * logo from a third party at request time, and the mark is injected as HTML
 * rather than rebuilt as JSX (its path data is not ours to transcribe lossily).
 * So anything active is refused outright. The cost of a false refusal is a
 * missing icon, which is the honest outcome anyway; the cost of a false accept
 * is script execution in the user's Settings page.
 */
const ACTIVE_MARKUP = /<script|<foreignObject|<!ENTITY|<!DOCTYPE|javascript:|\son[a-z]+\s*=/i

/** The mark a slug's logo lives at. */
export function labLogoUrl(slug: string): string {
  return `${LAB_LOGO_BASE_URL}${slug}.svg`
}

/**
 * The same string with its leading whitespace and byte-order mark removed.
 * Both models.dev responses and hand-pasted fixtures carry these, and every
 * comparison below is about content, not padding.
 */
function body(raw: string): string {
  return raw.replace(/^\uFEFF/, '').trim()
}

/**
 * Whether a body is a logo this plugin is willing to draw at all: a complete,
 * self-contained, inert `<svg>` element.
 *
 * Deliberately silent about WHICH logo it is — that is
 * {@link isRealLabLogo}'s job, because only the live placeholder tells the two
 * apart.
 * @param raw - the response body.
 * @returns true when the body is a complete inert SVG element.
 */
export function isRenderableLabLogo(raw: string): boolean {
  const svg = body(raw)
  return svg.startsWith('<svg')
    && svg.endsWith('</svg>')
    && !ACTIVE_MARKUP.test(svg)
}

/**
 * Whether a body is the lab's OWN logo rather than models.dev's generic
 * placeholder.
 *
 * The trap this exists for, VERIFIED live: `logos/labs/stepfun.svg` — a lab the
 * page's own catalog lists — answers `200 image/svg+xml` with the placeholder,
 * exactly as a misspelled path does. So "does this lab have a logo?" cannot be
 * answered by the status code, the content type, or a shape check; it is
 * answered by fetching a slug that cannot exist and comparing. That comparison
 * also survives models.dev changing the placeholder, or replacing it with a
 * real 404.
 * @param raw - the response body for the lab's logo URL.
 * @param placeholder - the body {@link IMPOSSIBLE_LAB_SLUG} returned, live.
 * @returns true only when the body is the lab's own logo.
 */
export function isRealLabLogo(raw: string, placeholder: string): boolean {
  if (!isRenderableLabLogo(raw)) return false
  return body(raw) !== body(placeholder)
}

/**
 * Rebuild a logo so it fills whatever box the row gives it.
 *
 * Only the ROOT's own sizing is dropped; its `viewBox`, `xmlns`, `fill` and
 * everything below are kept verbatim, because the inner shapes rely on root
 * attributes (`fill="currentColor"` is set on the root of several and nowhere
 * else) and because the path data is models.dev's, not ours to rewrite.
 * @param raw - the response body.
 * @returns the normalized markup, or undefined when it is not a usable logo.
 */
export function normalizeLabLogo(raw: string): string | undefined {
  if (!isRenderableLabLogo(raw)) return undefined
  const svg = body(raw)
  const openEnd = svg.indexOf('>')
  if (openEnd < 0) return undefined
  const root = svg.slice(0, openEnd)
  const attrs = root
    .replace(/^<svg\b/, '')
    .replace(/\s(?:width|height|style)\s*=\s*"[^"]*"/gi, '')
    .trim()
  const head = attrs === ''
    ? '<svg width="100%" height="100%"'
    : `<svg ${attrs} width="100%" height="100%"`
  return `${head}${svg.slice(openEnd)}`
}

/**
 * The mark to draw for one vendor: its lab's real logo, or nothing at all.
 *
 * THE no-fallback rule, in one place. Every branch that cannot produce a real
 * models.dev logo answers `undefined`, and the caller renders nothing — the
 * requested behaviour, not a degraded one.
 * @param lab - the vendor's models.dev lab slug, when it has one.
 * @param badges - the marks available: the host's live answer over the vendored set.
 * @returns the logo markup, or undefined when the lab has none here.
 */
export function vendorLabBadge(
  lab: string | undefined,
  badges: Readonly<Record<string, string>>,
): string | undefined {
  if (lab === undefined) return undefined
  const markup = badges[lab]
  if (markup === undefined) return undefined
  // A blob that is not a complete inert SVG is not a logo, and drawing a
  // fragment of it would be a fabricated mark.
  return isRenderableLabLogo(markup) ? markup : undefined
}