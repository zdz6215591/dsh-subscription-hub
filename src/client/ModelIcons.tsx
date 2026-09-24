/**
 * The model list's icon set: the vendor mark and the input-modality glyphs.
 *
 * ## The vendor mark is models.dev's, or it is nothing
 *
 * Each row's company mark is the logo models.dev publishes for that lab
 * (`https://models.dev/logos/labs/{slug}.svg`), either the copy vendored in
 * `lab-badges.ts` or the one the host fetched for a lab this build has no
 * vendored copy of. When there is no logo — a lab models.dev has none for, or a
 * model no lab can be attributed to — this renders **nothing at all**: no
 * monogram, no line-art drawing, no borrowed mark. An absent icon is the honest
 * outcome; an invented one would be a fabricated claim about who makes the
 * model. `lab-logo.ts` holds that rule.
 *
 * The markup is injected as HTML rather than rebuilt as JSX: it is models.dev's
 * own path data, and re-expressing it element by element would be a lossy
 * transcription. Everything reaching here has already passed
 * `isRenderableLabLogo`, which refuses anything that is not a complete inert
 * `<svg>`.
 *
 * ## Modalities are shown in full
 *
 * Every declared modality gets a glyph, text included — an earlier version
 * suppressed the text glyph unless the model was text-only, which made a
 * text+image model look image-only. The vocabulary is the widened
 * `InputModality`, so a model whose catalog discloses video or PDF says so
 * rather than having that flattened onto `image`.
 *
 * @module dsh-subscription-hub/client/ModelIcons
 */

import type { ModelVendor } from '../model-vendor.js'
import type { InputModality } from '../providers/modality.js'
import { vendorLabBadge } from '../lab-logo.js'
import { DEFAULT_LAB_LOGO } from './local-lab-badges.js'

/** Shared stroke geometry: one weight for every glyph in the set. */
const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}
/** The box every glyph is drawn in. */
const BOX = '0 0 16 16'
/** Rendered size of a lab logo. */
const BADGE_SIZE = 16
/** Rendered size of a modality glyph. */
const MODALITY_SIZE = 14

/**
 * The vendor mark.
 *
 * A vendor whose lab has no real logo draws models.dev's own generic placeholder rather
 * than nothing. That is NOT the fabrication this module otherwise refuses: the
 * placeholder asserts no company identity, whereas a hand-drawn lookalike would assert a
 * specific one. Rows therefore stay aligned whether or not a mark exists, and nothing
 * manufactured ever reaches the list.
 *
 * The component is mounted only for a model that HAS a vendor, so a model nothing
 * attributes to a company still draws nothing at all.
 * @param props - the vendor, and the lab logos available to draw from.
 * @returns the logo in a fixed-size box.
 */
export function VendorMark({ vendor, badges }: {
  vendor: ModelVendor
  badges: Readonly<Record<string, string>>
}): React.JSX.Element | null {
  const markup = vendorLabBadge(vendor.lab, badges) ?? DEFAULT_LAB_LOGO
  if (markup === undefined) return null
  return (
    <span
      aria-hidden="true"
      title={vendor.label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: BADGE_SIZE,
        height: BADGE_SIZE,
        flex: '0 0 auto',
        lineHeight: 0,
      }}
      // The logo keeps its own viewBox and carries `width="100%" height="100%"`,
      // so it fills this box whatever box models.dev drew it in.
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  )
}

/**
 * One modality's glyph.
 *
 * Text is a paragraph of ragged lines rather than a bare capital `T`: at this
 * size a `T` reads as a letter among icons, while the ragged-line form is the
 * shape the rest of the world uses for "text input".
 */
function ModalityGlyph({ kind }: { kind: InputModality }): React.JSX.Element {
  switch (kind) {
    case 'text':
      return (
        <svg width={MODALITY_SIZE} height={MODALITY_SIZE} viewBox={BOX} {...STROKE}>
          <path d="M3 4.6h10M3 8h10M3 11.4h5.6" />
        </svg>
      )
    case 'image':
      return (
        <svg width={MODALITY_SIZE} height={MODALITY_SIZE} viewBox={BOX} {...STROKE}>
          <rect x="2.4" y="3.2" width="11.2" height="9.6" rx="1.8" />
          <circle cx="5.8" cy="6.4" r="1" />
          <path d="M2.8 11.2 6 8.2l2.6 2.4L11 8.4l2.4 2.4" />
        </svg>
      )
    case 'video':
      return (
        <svg width={MODALITY_SIZE} height={MODALITY_SIZE} viewBox={BOX} {...STROKE}>
          <rect x="2.2" y="4.4" width="8.2" height="7.2" rx="1.8" />
          <path d="M10.4 8 13.8 5.6v4.8L10.4 8z" />
        </svg>
      )
    case 'audio':
      // A waveform: immediately separable from the video camera at this size.
      return (
        <svg width={MODALITY_SIZE} height={MODALITY_SIZE} viewBox={BOX} {...STROKE}>
          <path d="M3 8h.01M5.6 5.4v5.2M8 3.4v9.2M10.4 5.4v5.2M13 8h.01" />
        </svg>
      )
    case 'file':
      return (
        <svg width={MODALITY_SIZE} height={MODALITY_SIZE} viewBox={BOX} {...STROKE}>
          <path d="M4 2.4h5l3 3v8.2H4z" />
          <path d="M9 2.4v3h3" />
        </svg>
      )
  }
}

/** The tooltip for one modality. */
function modalityLabel(kind: InputModality): string {
  switch (kind) {
    case 'text': return 'Text'
    case 'image': return 'Image'
    case 'video': return 'Video'
    case 'audio': return 'Audio'
    case 'file': return 'Documents'
  }
}

/** Display order: the primary modality first, then the extras. */
const MODALITY_ORDER: readonly InputModality[] = ['text', 'image', 'video', 'audio', 'file']

/**
 * Every input modality a model accepts, as muted line glyphs.
 *
 * All of them are shown, text included: a text+image model that hid its text
 * glyph looked image-only. An undeclared route renders nothing, because the
 * harness treats an explicit omission as a negative capability rather than as
 * text-only.
 * @param props - the declared modalities, or undefined when the route never said.
 */
export function ModalityIcons({ modalities }: { modalities: readonly InputModality[] | undefined }): React.JSX.Element | null {
  if (modalities === undefined || modalities.length === 0) return null
  const shown = MODALITY_ORDER.filter(modality => modalities.includes(modality))
  if (shown.length === 0) return null
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        flex: '0 0 auto',
        color: 'var(--dsw-alias-label-tertiary, #8b8b93)',
      }}
    >
      {shown.map(modality => (
        <span
          key={modality}
          aria-hidden="true"
          title={modalityLabel(modality)}
          style={{ display: 'inline-flex', alignItems: 'center' }}
        >
          <ModalityGlyph kind={modality} />
        </span>
      ))}
    </span>
  )
}