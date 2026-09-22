/**
 * The model list's icon set: the vendor mark and the input-modality glyphs.
 *
 * Layout per row: vendor mark → model name → (elastic gap) → modality glyphs, so
 * a grid of rows reads as aligned columns rather than ragged text.
 *
 * Visual rules, in service of "precise and small":
 *
 * - **Monochrome and borderless.** Every mark is `currentColor` in the muted text
 *   tone, with no border, no fill and no chip background, so a long list reads as
 *   one quiet column of marks rather than a row of badges.
 * - **Fixed footprint.** Each mark occupies the same box, so rows line up whether
 *   a model declares one modality or five.
 * - **Never a guess.** A model whose vendor is unknown renders no mark, and a
 *   route that never declared its modalities renders no glyphs: the harness treats
 *   an explicit omission as a negative capability, not as text-only.
 * - **Accessible without shape.** Marks are `aria-hidden`; the meaning travels in
 *   each one's `title` and in the harness's own model list, so nothing is
 *   conveyed by a pictogram alone.
 *
 * @module dsh-subscription-hub/client/ModelIcons
 */

import type { ModelVendor } from '../model-vendor.js'

/** Glyph box in pixels. Small enough to disappear into a dense list. */
const GLYPH = 14

/**
 * The vendor mark: a borderless monogram in the muted text tone.
 *
 * A monogram rather than each company's logo: those are third-party trademarks,
 * and a hand-redrawn lookalike that renders subtly wrong is worse than a clean
 * initial that is always right. The seam is one component, so real marks can be
 * dropped in later without touching any call site.
 * @param props - the vendor to render.
 */
export function VendorMark({ vendor }: { vendor: ModelVendor }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      title={vendor.label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 16,
        height: 16,
        flex: '0 0 auto',
        // No border, no background: the glyph alone carries the identity.
        color: 'var(--dsw-alias-label-tertiary, #8b8b93)',
        fontSize: 10,
        fontWeight: 600,
        lineHeight: 1,
        userSelect: 'none',
      }}
    >
      {vendor.mono}
    </span>
  )
}

/** The tooltip and ordering for one modality. */
interface ModalityMeta {
  label: string
  order: number
}

/**
 * The modality vocabulary, keyed by the harness's `ModelModality` values.
 *
 * `text` and `image` are what dsh-llm declares today; `video`, `file` and `audio`
 * are carried so a route that starts declaring them gets a glyph instead of
 * nothing, and any value not listed here still gets the neutral glyph below.
 */
const MODALITIES: Readonly<Record<string, ModalityMeta>> = Object.freeze({
  text: { label: 'Text', order: 0 },
  image: { label: 'Image', order: 1 },
  video: { label: 'Video', order: 2 },
  audio: { label: 'Audio', order: 3 },
  file: { label: 'File', order: 4 },
})

/** Metadata for a modality this build does not know by name. */
const UNKNOWN_MODALITY: ModalityMeta = { label: 'Additional input', order: 9 }

/** One stroked glyph, sized to the shared box. */
function ModalityGlyph({ kind }: { kind: string }): React.JSX.Element {
  const common = {
    width: GLYPH,
    height: GLYPH,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.4,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  }
  switch (kind) {
    case 'text':
      // A capital T, drawn rather than typed so it keeps the same stroke weight
      // as the other glyphs at this size.
      return (
        <svg {...common} aria-hidden="true">
          <path d="M3 4h10" />
          <path d="M8 4v8" />
        </svg>
      )
    case 'image':
      // A framed picture with a horizon and a sun.
      return (
        <svg {...common} aria-hidden="true">
          <rect x="2" y="3" width="12" height="10" rx="1.8" />
          <circle cx="5.7" cy="6.4" r="0.9" />
          <path d="M2.4 11.4l3-2.9 2.4 2.3 2.2-2.1 2.6 2.5" />
        </svg>
      )
    case 'video':
      // A camera body with a lens barrel.
      return (
        <svg {...common} aria-hidden="true">
          <rect x="2" y="4.4" width="8" height="7.2" rx="1.6" />
          <path d="M10 8l4-2.3v4.6L10 8z" />
        </svg>
      )
    case 'file':
      // A page with a folded corner.
      return (
        <svg {...common} aria-hidden="true">
          <path d="M4 2.4h5l3 3v8.2H4z" />
          <path d="M9 2.4v3h3" />
        </svg>
      )
    default:
      // The neutral mark for an unrecognised modality: a puzzle piece, reading as
      // "additional input" rather than as a warning.
      return (
        <svg {...common} aria-hidden="true">
          <path d="M6.2 3.4a1.35 1.35 0 112.7 0v1.2h1.5a.8.8 0 01.8.8v1.7h1.1a1.35 1.35 0 110 2.7h-1.1v1.7a.8.8 0 01-.8.8H8.9v1.2a1.35 1.35 0 11-2.7 0v-1.2H4.7a.8.8 0 01-.8-.8V9.8h1.1a1.35 1.35 0 100-2.7H3.9V5.4a.8.8 0 01.8-.8h1.5z" />
        </svg>
      )
  }
}

/**
 * The input modalities a model accepts, as muted borderless glyphs.
 *
 * Text is shown ONLY when the model accepts nothing else: every text-out model
 * takes text, so a text glyph on every row would be noise. A model with image
 * input therefore shows just the image glyph, which is the fact a reader is
 * actually scanning for.
 * @param props - the declared modalities, or undefined when the route never said.
 */
export function ModalityIcons({ modalities }: { modalities: readonly string[] | undefined }): React.JSX.Element | null {
  if (modalities === undefined || modalities.length === 0) return null

  const onlyText = modalities.length === 1 && modalities[0] === 'text'
  const shown = onlyText ? ['text'] : modalities.filter(modality => modality !== 'text')
  if (shown.length === 0) return null

  // A stable, meaningful order rather than whatever order the route listed.
  const ordered = [...new Set(shown)].sort(
    (left, right) => (MODALITIES[left] ?? UNKNOWN_MODALITY).order - (MODALITIES[right] ?? UNKNOWN_MODALITY).order,
  )

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        flex: '0 0 auto',
        color: 'var(--dsw-alias-label-tertiary, #8b8b93)',
      }}
    >
      {ordered.map(modality => (
        <span
          key={modality}
          aria-hidden="true"
          title={(MODALITIES[modality] ?? UNKNOWN_MODALITY).label}
          style={{ display: 'inline-flex', alignItems: 'center' }}
        >
          <ModalityGlyph kind={modality} />
        </span>
      ))}
    </span>
  )
}