/**
 * The input-modality vocabulary this hub understands.
 *
 * `dsh-llm` declares only `text | image`, which is what the harness's own token
 * meter and message shapes are built around. But the upstream catalogs disclose
 * more, and mapping the extra values down to `image` loses real information:
 * Cline reads models.dev's `modalities.input`, which names `video` and `pdf` for
 * a real set of models, and the hub was collapsing all three into `image`. A
 * reader then cannot tell a model that accepts a screenshot from one that accepts
 * a screen recording.
 *
 * So the vocabulary is widened here, in the two places widening is legitimate:
 *
 * 1. a **declaration merge** into the harness's own `ModelModalityMap`. That
 *    interface is documented as merge-extensible precisely so a plugin can add a
 *    vocabulary without forking the type, and the harness only ever round-trips
 *    the value (it does not switch on it), so an extra member is inert there.
 * 2. the hub's own `InputModality`, so its validation and rendering agree.
 *
 * The asymmetry is deliberate and load-bearing: a modality the hub ACCEPTS does
 * not obligate the harness to do anything with it. Adding `video` here means a
 * model that accepts video is described truthfully; it does not mean the request
 * path can send video, and `translate/` still only ever emits text and image
 * blocks. Declaring the capability is honest; pretending to use it would not be.
 *
 * @module dsh-subscription-hub/providers/modality
 */

/** Every input modality this hub can describe. */
export type InputModality = 'text' | 'image' | 'video' | 'audio' | 'file'

/** The vocabulary in display order, lowest first. */
export const INPUT_MODALITIES: readonly InputModality[] = Object.freeze([
  'text', 'image', 'video', 'audio', 'file',
])

declare module '@deepseek-ai/dsh-llm' {
  /**
   * Widen the harness's modality map.
   *
   * `ModelModalityMap` is declared merge-extensible for exactly this: a provider
   * plugin whose upstream discloses a modality the core set lacks. The core
   * never switches on the value, so an added member only ever reaches a reader
   * that asked for it.
   */
  interface ModelModalityMap {
    video: 'video'
    audio: 'audio'
    file: 'file'
  }
}

/**
 * Whether a value is a modality this hub knows.
 * @param value - the candidate value.
 * @returns whether it is a known input modality.
 */
export function isInputModality(value: unknown): value is InputModality {
  return typeof value === 'string' && (INPUT_MODALITIES as readonly string[]).includes(value)
}

/**
 * Normalize one upstream modality spelling onto this vocabulary.
 *
 * Aliases are folded rather than dropped, because a value the hub cannot name is
 * still information: `pdf` names a document, which is the `file` modality, and
 * `document`/`text-only` appear in other catalogs for the same idea.
 * @param value - the raw upstream value.
 * @returns the matching modality, or undefined when none fits.
 */
export function normalizeInputModality(value: unknown): InputModality | undefined {
  if (typeof value !== 'string') return undefined
  switch (value.trim().toLowerCase()) {
    case 'text': return 'text'
    case 'image': return 'image'
    case 'video': return 'video'
    case 'audio': return 'audio'
    // Every document-ish spelling collapses onto `file`: the hub does not
    // distinguish MIME types here, and dropping these would lose the capability.
    case 'file': case 'pdf': case 'document': case 'doc': return 'file'
    default: return undefined
  }
}

/**
 * Validate and normalize a modality list.
 *
 * An unknown value is DROPPED rather than failing the model: a catalog that
 * starts advertising a modality this build has never heard of must not take the
 * whole route down, and the remaining known modalities are still true.
 * @param values - the raw list.
 * @returns the normalized list, or undefined when nothing usable remains.
 */
export function normalizeInputModalities(values: readonly unknown[]): InputModality[] | undefined {
  const out: InputModality[] = []
  for (const value of values) {
    const modality = normalizeInputModality(value)
    if (modality !== undefined && !out.includes(modality)) out.push(modality)
  }
  return out.length === 0 ? undefined : out
}