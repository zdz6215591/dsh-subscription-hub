/**
 * Antigravity tool-call thought_signature cache.
 *
 * When the upstream returns a functionCall, the sibling / same-part
 * `thoughtSignature` MUST be replayed on the NEXT request's assistant
 * functionCall part, or the API refuses the conversation with
 * "Function call is missing a thought_signature". This module holds those
 * signatures keyed by the upstream tool-call id so translate.ts can attach
 * them again on replay. See translate.ts and parse.ts (onToolSignature).
 *
 * Cap the table so a very long session cannot grow it unboundedly; end-of-turn
 * pruning removes ids that already made their round trip.
 */

/** tool-call id → the android-model sign that rode with the functionCall. */
const toolSignatures = new Map<string, string>()
/** Cap on retained signatures; oldest entries evict past it. */
const MAX_ENTRIES = 512

/** Record a signature for a functionCall id, with a bound on table growth. */
export function recordToolSignature(id: string, signature: string): void {
  if (id.length === 0 || signature.length === 0) return
  if (toolSignatures.size >= MAX_ENTRIES) {
    const oldest = toolSignatures.keys().next().value as string | undefined
    if (oldest !== undefined) toolSignatures.delete(oldest)
  }
  toolSignatures.set(id, signature)
}

/** The replayed signature for a functionCall id, when one is cached. */
export function getToolSignature(id: string): string | undefined {
  return toolSignatures.get(id)
}

/** Drop signatures for completed tool-call ids after a turn replays them. */
export function forgetToolSignatures(ids: Iterable<string>): void {
  for (const id of ids) toolSignatures.delete(id)
}

/** Clear the cache. Test-only. */
export function clearToolSignaturesForTests(): void {
  toolSignatures.clear()
}