/**
 * Verbatim models.dev responses, captured live while implementing the badge
 * sync — not retyped, not idealized.
 *
 * They are the load-bearing evidence for the one fact this feature gets wrong
 * most easily: a lab models.dev has NO logo for does not 404. Its logo URL
 * answers HTTP 200 with 1421 bytes of generic placeholder SVG, and the body of that
 * placeholder is shape-identical to a real logo (it starts with `<svg`, ends
 * with `</svg>`, carries no script). So neither the status code, the content
 * type, nor a shape check can tell the two apart, and `isRealLabLogo` compares
 * against the placeholder instead. These fixtures are what proves it.
 *
 * @module dsh-subscription-hub/test/lab-logo-fixtures
 */

/** What models.dev serves for a slug that cannot exist — and for a lab with no logo. */
export const PLACEHOLDER_SVG = "<svg viewBox=\"0 0 24 24\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\">\n  <path\n    shape-rendering=\"geometricPrecision\"\n    d=\"M9.8132 15.9038L9 18.75L8.1868 15.9038C7.75968 14.4089 6.59112 13.2403 5.09619 12.8132L2.25 12L5.09619 11.1868C6.59113 10.7597 7.75968 9.59112 8.1868 8.09619L9 5.25L9.8132 8.09619C10.2403 9.59113 11.4089 10.7597 12.9038 11.1868L15.75 12L12.9038 12.8132C11.4089 13.2403 10.2403 14.4089 9.8132 15.9038Z\"\n    stroke=\"currentColor\"\n    stroke-width=\"1.5\"\n    stroke-linecap=\"round\"\n    stroke-linejoin=\"round\"\n  />\n  <path\n    d=\"M18.2589 8.71454L18 9.75L17.7411 8.71454C17.4388 7.50533 16.4947 6.56117 15.2855 6.25887L14.25 6L15.2855 5.74113C16.4947 5.43883 17.4388 4.49467 17.7411 3.28546L18 2.25L18.2589 3.28546C18.5612 4.49467 19.5053 5.43883 20.7145 5.74113L21.75 6L20.7145 6.25887C19.5053 6.56117 18.5612 7.50533 18.2589 8.71454Z\"\n    stroke=\"currentColor\"\n    stroke-width=\"1.5\"\n    stroke-linecap=\"round\"\n    stroke-linejoin=\"round\"\n  />\n  <path\n    d=\"M16.8942 20.5673L16.5 21.75L16.1058 20.5673C15.8818 19.8954 15.3546 19.3682 14.6827 19.1442L13.5 18.75L14.6827 18.3558C15.3546 18.1318 15.8818 17.6046 16.1058 16.9327L16.5 15.75L16.8942 16.9327C17.1182 17.6046 17.6454 18.1318 18.3173 18.3558L19.5 18.75L18.3173 19.1442C17.6454 19.3682 17.1182 19.8954 16.8942 20.5673Z\"\n    stroke=\"currentColor\"\n    stroke-width=\"1.5\"\n    stroke-linecap=\"round\"\n    stroke-linejoin=\"round\"\n  />\n</svg>\n"

/** Anthropic's real logo: small, a different viewBox, and not the placeholder. */
export const ANTHROPIC_LOGO_SVG = "<svg width=\"24\" height=\"24\" viewBox=\"0 0 40 40\" xmlns=\"http://www.w3.org/2000/svg\">\n<path d=\"M26.9568 9.88184H22.1265L30.7753 31.7848H35.4917L26.9568 9.88184ZM13.028 9.88184L4.4917 31.7848H9.32203L11.2305 27.1793H20.2166L22.0126 31.6724H26.8444L18.0832 9.88184H13.028ZM12.5783 23.1361L15.4987 15.3853L18.5315 23.1361H12.5783Z\" fill=\"currentColor\"/>\n</svg>"
