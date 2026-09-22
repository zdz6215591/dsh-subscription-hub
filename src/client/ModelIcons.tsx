/**
 * The model list's icon set: a line-art vendor mark and the input-modality
 * glyphs, every one drawn in the same style.
 *
 * ## Why line art rather than a monogram
 *
 * A single letter distinguishes nothing — with a dozen vendors behind one picker
 * most rows share an initial. Each vendor therefore gets a **stroke-only
 * geometric mark** at a uniform weight (1.5px on a 16px box, round caps and
 * joins), which reads as one icon set rather than a row of text.
 *
 * These are stylistic marks, not the companies' official logos: those are
 * trademarks, and a hand-traced imitation that renders subtly wrong is worse
 * than a clean mark that is always right. Every mark is `currentColor` and
 * `aria-hidden`, with the vendor's own name in the tooltip, so nothing depends
 * on a shape being recognised.
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
import { VENDOR_BADGES } from './vendor-badges.js'

/** Shared stroke geometry: one weight for every mark in the set. */
const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}
/** The box every mark is drawn in. */
const BOX = '0 0 16 16'
/** Rendered size of a vendor mark. */
const VENDOR_SIZE = 15
/** Rendered size of a vendored vendor badge. */
const BADGE_SIZE = 16
/** Rendered size of a modality glyph. */
const MODALITY_SIZE = 14

/**
 * One vendor's mark, as SVG children in the shared 16x16 stroke style.
 *
 * Keyed by `ModelVendor.id`. A vendor absent here falls back to the neutral mark
 * below rather than to a letter, so the list stays visually uniform.
 */
const VENDOR_MARKS: Readonly<Record<string, React.JSX.Element>> = {
  // Anthropic's angular A: an asymmetric peak with a short crossbar, which is
  // the shape of their own mark rather than a plain letterform.
  anthropic: (<><path d="M3.2 13.2 7.9 2.8l1.7 3.9-2.6 6.5" /><path d="M8.6 6.7h2.4l2 6.5" /></>),
  // OpenAI's six-fold knot, abstracted to an interleaved hexagonal rosette.
  openai: (<><path d="M8 2.4 12.8 5v5.4L8 13.6 3.2 10.4V5z" /><path d="M8 2.4v5.2M12.8 5 8 7.6 3.2 5M8 7.6v6" /></>),
  // Google's G: a ring with a gap on the right and the crossbar into the centre.
  google: (<><path d="M13.2 6.6A5.4 5.4 0 1 0 13.4 9H8.4" /></>),
  // DeepSeek's whale: a rounded body, a tail fin and an eye.
  deepseek: (<><path d="M2.4 9.6c2.2-3 6.4-3.6 9-.8 1 .9 1.6 2 1.8 3.2-2.6 1.4-6.4 1.2-8.4-.6" /><path d="M13.2 8.2c-1 .3-1.8 1.1-2.2 2.1M5.4 8.6h.01" /></>),
  xai: (<><path d="M3.4 3.4 12.6 12.6M12.6 3.4 3.4 12.6" /></>),
  // Alibaba/Qwen: a Q — a ring with a diagonal tail, which is the family mark.
  qwen: (<><circle cx="8" cy="8" r="4.6" /><path d="M10.4 10.4 13.4 13.4" /></>),
  // Moonshot's crescent, which is also the idea behind the name.
  moonshot: (<><path d="M12.4 10.4A5.2 5.2 0 1 1 8 2.8a4.2 4.2 0 0 0 4.4 7.6z" /></>),
  // Z.ai: a Z drawn as three strokes.
  zhipu: (<><path d="M4 4.2h8l-8 7.6h8" /></>),
  // MiniMax: an M drawn as one continuous wave.
  minimax: (<><path d="M2.6 12.4V4.6l5.4 6 5.4-6v7.8" /></>),
  // Meta's infinity loop.
  meta: (<><path d="M2.6 8c0-2.4 1.3-3.8 2.8-3.8S8 5.8 8 8s1.1 3.8 2.6 3.8S13.4 10.4 13.4 8s-1.3-3.8-2.8-3.8S8 5.8 8 8s-1.1 3.8-2.6 3.8S2.6 10.4 2.6 8z" /></>),
  // Mistral's three bars.
  mistral: (<><path d="M3 5.4h10M3 8h7M6 10.6h7" /></>),
  // Microsoft's four panes.
  microsoft: (<><rect x="3" y="3" width="4.4" height="4.4" rx="0.6" /><rect x="8.6" y="3" width="4.4" height="4.4" rx="0.6" /><rect x="3" y="8.6" width="4.4" height="4.4" rx="0.6" /><rect x="8.6" y="8.6" width="4.4" height="4.4" rx="0.6" /></>),
  // Amazon's smile arrow.
  amazon: (<><path d="M3 10.6c2.6 2 7.4 2 10 0" /><path d="M11.4 9.8l1.8.7-.6 1.8" /></>),
  // NVIDIA's eye.
  nvidia: (<><path d="M1.8 8s2.6-3 6.2-3 6.2 3 6.2 3-2.6 3-6.2 3S1.8 8 1.8 8z" /><circle cx="8" cy="8" r="1.8" /></>),
  // ByteDance's musical note.
  bytedance: (<><circle cx="6.4" cy="11.4" r="1.9" /><path d="M8.3 11.4V4.2l4 1.1" /><path d="M12.3 5.3v3.4" /></>),
  // Tencent's penguin.
  tencent: (<><path d="M4.6 12.8c-.8-1.4-.4-3.4.4-4.6-.6-1.4-.2-2.8 1-3.4 1.2-.6 2.6-.2 3.4.8 1.4.4 2.4 1.6 2.4 3 0 1-.4 1.8-1 2.4.4 1.2.2 2.4-.4 3.2" /><circle cx="6.9" cy="7.1" r=".01" /><circle cx="9.9" cy="7.1" r=".01" /></>),
  // Meituan's cat, for the LongCat models.
  meituan: (<><path d="M3.4 12.6V7.4l1.8-2.2 2 .8h1.6l2-.8 1.8 2.2v5.2" /><circle cx="6.4" cy="9.4" r=".01" /><circle cx="9.6" cy="9.4" r=".01" /><path d="M7.2 11.2h1.6" /></>),
  // StepFun's ascending steps.
  stepfun: (<><path d="M3 12.6h3.4V9.2H9.8V5.8H13.4" /></>),
  // Xiaomi's squircle with the wordmark's bar.
  xiaomi: (<><rect x="2.8" y="2.8" width="10.4" height="10.4" rx="3.2" /><path d="M5.8 10.4V5.8h1.6v4.6M9 5.8h2.6" /></>),
  // InclusionAI: a rounded diamond, the neutral geometric family mark.
  inclusionai: (<><path d="M8 2.6 13.4 8 8 13.4 2.6 8z" /><path d="M8 5.6 10.4 8 8 10.4 5.6 8z" /></>),
  cohere: (<><circle cx="8" cy="8" r="2" /><path d="M8 2.6v3M8 10.4v3M2.6 8h3M10.4 8h3" /></>),
  openrouter: (<><path d="M2.6 8h3.2l1.6-3.4h3.2" /><path d="M2.6 8h3.2l1.6 3.4h3.2" /><path d="M11.4 3.4 13.4 4.6l-2 1.2M11.4 9.4l2 1.2-2 1.2" /></>),
  groq: (<><circle cx="8" cy="8" r="4.6" /><path d="M11.2 6.4H8.4v3.2h2.8" /></>),
  together: (<><circle cx="5.6" cy="8" r="2.6" /><circle cx="10.4" cy="8" r="2.6" /></>),
  fireworks: (<><path d="M8 2.6v3.4M8 10v3.4M2.6 8h3.4M10 8h3.4" /><circle cx="8" cy="8" r="1.4" /></>),
  perplexity: (<><path d="M8 2.6v10.8M3.4 5.4 8 8.6l4.6-3.2M3.4 10.6 8 7.4l4.6 3.2M3.4 5.4v5.2M12.6 5.4v5.2" /></>),
  baseten: (<><path d="M3 3v10h10" /><path d="M6 11V6l4 5V6" /></>),
  '01ai': (<><rect x="2.8" y="4.6" width="10.4" height="6.8" rx="3.4" /><path d="M7 8h2" /></>),
  ai21: (<><path d="M3 12.4 8 3.6l5 8.8" /><path d="M5.6 9.4h4.8" /></>),
}

/** The neutral mark for a vendor this build has no line art for. */
const GENERIC_MARK = (<><circle cx="8" cy="8" r="5.4" /><path d="M8 2.6v10.8M2.6 8h10.8" /></>)

/**
 * The vendor mark.
 *
 * A real badge when the vendor has one vendored (see `vendor-badges.ts`): the
 * 20x20 rounded mark in the vendor's own colour with its logo knocked out in
 * white, which is what makes the list read as one icon set. Otherwise the
 * line-art mark below.
 *
 * The badge markup is injected as HTML rather than built from JSX elements,
 * because it is the vendors' own path data and re-expressing it as JSX would be
 * a lossy transcription. It is VENDORED at build time from a fixed file set and
 * never derived from runtime input, so there is nothing untrusted in it.
 *
 * @param props - the vendor to render.
 */
export function VendorMark({ vendor }: { vendor: ModelVendor }): React.JSX.Element {
  const badge = VENDOR_BADGES[vendor.id]
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
        color: 'var(--dsw-alias-label-tertiary, #8b8b93)',
      }}
    >
      {badge === undefined
        ? (
          <svg width={VENDOR_SIZE} height={VENDOR_SIZE} viewBox={BOX} {...STROKE}>
            {VENDOR_MARKS[vendor.id] ?? GENERIC_MARK}
          </svg>
        )
        : (
          // `viewBox` comes from the badge's own 20x20 frame; width/height are
          // ours, so one badge set renders at whatever the row needs.
          <svg
            width={BADGE_SIZE}
            height={BADGE_SIZE}
            viewBox="0 0 20 20"
            aria-hidden="true"
            dangerouslySetInnerHTML={{ __html: badge }}
          />
        )}
    </span>
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