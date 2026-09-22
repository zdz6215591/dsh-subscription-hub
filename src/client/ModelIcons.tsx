/**
 * The model list's icon set: vendor mark, input modalities, agent score.
 *
 * Design rules, all in service of "precise and small" rather than decorative:
 *
 * - **Monochrome and borderless.** Every glyph is `currentColor` at the muted
 *   text tone with no box, border or fill, so a long list reads as one quiet
 *   column of marks instead of a row of badges.
 * - **Fixed footprint.** Each mark is a fixed-size inline-flex box, so rows line
 *   up whether or not a model has an image modality or a score.
 * - **Never a guess.** A model with no known vendor renders nothing, and one the
 *   board does not list renders no score — see the modules that supply them.
 * - **Accessible without the glyph.** Icons are `aria-hidden`; the vendor's name
 *   and the score's meaning travel in `title` and in the row's own label, so
 *   nothing is conveyed by shape or colour alone.
 *
 * @module dsh-subscription-hub/client/ModelIcons
 */

import type { ModelVendor } from '../model-vendor.js'
import type { AgentScore } from '../model-agent-score.js'

/** Shared geometry for one inline glyph. */
const GLYPH = 14

/**
 * The vendor mark: a borderless monogram in the muted text tone.
 *
 * A monogram rather than each company's logo: those are third-party trademarks,
 * and a hand-redrawn lookalike that renders subtly wrong is worse than a clean
 * initial that is always right. The seam is a single component, so real marks can
 * be dropped in later without touching any call site.
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
        color: 'var(--dsw-alias-text-tertiary, #8b8b93)',
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: 0,
        lineHeight: 1,
        userSelect: 'none',
      }}
    >
      {vendor.mono}
    </span>
  )
}

/** One input-modality glyph, drawn as a stroked mark. */
function ModalityGlyph({ kind }: { kind: 'text' | 'image' }): React.JSX.Element {
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
  return (
    <svg {...common} aria-hidden="true">
      {kind === 'text' ? (
        // Three text baselines.
        <>
          <path d="M2.5 4h11" />
          <path d="M2.5 8h11" />
          <path d="M2.5 12h6.5" />
        </>
      ) : (
        // A framed picture with a horizon mark.
        <>
          <rect x="2" y="3" width="12" height="10" rx="1.5" />
          <circle cx="5.75" cy="6.5" r="1" />
          <path d="M2.5 11.5l3.2-3 2.6 2.4 2.4-2.2 2.8 2.6" />
        </>
      )}
    </svg>
  )
}

/**
 * The input modalities a model accepts, as muted inline glyphs.
 *
 * `undefined` means the route never declared them, which is NOT the same as
 * text-only: the harness treats an explicit omission as a negative capability, so
 * rendering nothing is the honest choice for an undeclared model.
 * @param props - the modalities to render.
 */
export function ModalityIcons({ modalities }: { modalities: readonly string[] | undefined }): React.JSX.Element | null {
  if (modalities === undefined || modalities.length === 0) return null
  // Text is implied by every text-out model and would be noise on every row;
  // only a modality that is NOT plain text is worth a glyph, plus a single text
  // mark when the model is text-only so the column never looks empty-handed.
  const onlyText = modalities.length === 1 && modalities[0] === 'text'
  const shown: ('text' | 'image')[] = onlyText
    ? ['text']
    : modalities.filter((m): m is 'image' => m === 'image')
  if (shown.length === 0) return null
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        flex: '0 0 auto',
        color: 'var(--dsw-alias-text-tertiary, #8b8b93)',
      }}
    >
      {shown.map(kind => (
        <span
          key={kind}
          aria-hidden="true"
          title={kind === 'image' ? 'Accepts images' : 'Text only'}
          style={{ display: 'inline-flex', alignItems: 'center' }}
        >
          <ModalityGlyph kind={kind} />
        </span>
      ))}
    </span>
  )
}

/**
 * The Agent Arena net-improvement figure, with its confidence interval.
 *
 * Rendered only when the board lists the model. The tooltip names the board's own
 * model name, the measured effort variant and the CI, so the number is never read
 * as more precise than it is — and when the variant differs from the one in
 * effect, the tooltip says so rather than implying a measurement of this setting.
 * @param props - the resolved score.
 */
export function AgentScoreBadge({ score }: { score: AgentScore | undefined }): React.JSX.Element | null {
  if (score === undefined) return null
  const sign = score.score >= 0 ? '+' : ''
  const effortNote = score.effort === undefined
    ? ''
    : ` (${score.effort}${score.effortMismatch ? ' variant, not the setting in use' : ''})`
  return (
    <span
      title={`Agent Arena · ${score.label}${effortNote} · ${sign}${score.score.toFixed(2)}% ±${score.ci.toFixed(2)} net improvement vs the average model · rank #${String(score.rank)}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        flex: '0 0 auto',
        color: 'var(--dsw-alias-text-tertiary, #8b8b93)',
        fontSize: 10,
        lineHeight: 1,
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
      }}
    >
      {/* The word carries the meaning; the glyph makes it scannable. */}
      <span aria-hidden="true" style={{ fontSize: 9, marginRight: 3, opacity: 0.9 }}>◈</span>
      {sign}{score.score.toFixed(2)}%
    </span>
  )
}