/**
 * Read a media tool call's prompt and reference count for its title row.
 *
 * DSH 0.2.2 removed `argsRaw` from a preparing call and added a lazy `args`
 * view on every call stage; earlier hosts carry only `argsRaw`. The view is
 * read during render, as its contract requires, and the raw JSON is the
 * fallback for hosts without it.
 */
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'

const PROMPT_MAX_LENGTH = 60

/** The lazy argument reader of DSH 0.2.2+ (structural, so older typings compile). */
interface ArgsView {
  keys(): Iterable<string>
  textPrefix(key: string, length: number): string | undefined
  value(key: string): unknown
}

/**
 * The prompt line and reference-image count of one media tool call.
 * @param block - the call in any stage.
 * @returns the truncated first prompt line and the number of reference images.
 */
export function mediaArguments(block: ToolCallBlock): { prompt: string; references: number } {
  const record = block as unknown as { args?: unknown; argsRaw?: unknown; call?: { argsRaw?: unknown } }
  const view = typeof record.args === 'object' && record.args !== null
    && typeof (record.args as ArgsView).textPrefix === 'function'
    ? record.args as ArgsView
    : undefined
  const rawValue = 'kind' in block ? record.call?.argsRaw : record.argsRaw
  const raw = typeof rawValue === 'string' ? rawValue : undefined
  let prompt: string | undefined
  let references: unknown
  if (view !== undefined) {
    prompt = view.textPrefix('prompt', PROMPT_MAX_LENGTH + 1)
    if (!prompt) {
      for (const key of view.keys()) {
        const candidate = view.textPrefix(key, PROMPT_MAX_LENGTH + 1)
        if (candidate) { prompt = candidate; break }
      }
    }
    references = view.value('referenceImages')
  } else if (raw !== undefined) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const fields = parsed as Record<string, unknown>
        prompt = typeof fields.prompt === 'string' && fields.prompt !== ''
          ? fields.prompt
          : Object.values(fields).find((value): value is string => typeof value === 'string' && value !== '')
        references = fields.referenceImages
      }
    } catch {
      // Arguments may still be streaming: the raw line is shown below.
    }
  }
  const line = (prompt ?? raw ?? '').split('\n', 1)[0] ?? ''
  return {
    prompt: line.length > PROMPT_MAX_LENGTH ? `${line.slice(0, PROMPT_MAX_LENGTH)}…` : line,
    references: Array.isArray(references) ? references.length : 0,
  }
}
