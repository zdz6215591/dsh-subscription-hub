/**
 * Trae account import: read every locally signed-in CN Trae install and
 * normalize it into the shared session store's shape.
 *
 * Kept apart from `credentials.ts` (which owns discovery and decryption) so the
 * plugin entry can import one function without pulling in the crypto details,
 * and apart from `index.ts` so the mapping is unit-testable.
 */

import type { TraeSession } from '../../auth/store.js'
import { discoverTraeCredentials, traeCandidates } from './credentials.js'
import type { TraeChannel } from './credentials.js'

/** One candidate path that yielded no account, for the import diagnostic. */
export interface TraeImportFailure {
  path: string
  reason: string
  message?: string
}

/** The outcome of one import sweep. */
export interface TraeImportResult {
  imported: { channel: TraeChannel; account: string; session: TraeSession }[]
  failures: TraeImportFailure[]
}

/**
 * Import every locally signed-in CN Trae account. Reading is read-only: the
 * desktop installs are never modified, and the plugin keeps its own copy in the
 * shared auth store.
 */
export async function importTraeAccounts(): Promise<TraeImportResult> {
  const { credentials, failures } = await discoverTraeCredentials(traeCandidates())
  const imported: TraeImportResult['imported'] = []
  for (const credential of credentials) {
    if (credential.accessToken === '') continue
    const account = credential.account ?? credential.userId ?? `${credential.channel}-account`
    imported.push({
      channel: credential.channel,
      account,
      session: {
        accessToken: credential.accessToken,
        refreshToken: credential.refreshToken,
        expiresAt: credential.expiresAt,
        account,
        ...credential.userId === '' ? {} : { userId: credential.userId },
        channel: credential.channel,
        region: 'cn',
        host: credential.host,
        edition: credential.edition,
      },
    })
  }
  return {
    imported,
    failures: failures.map(failure => ({
      path: failure.path,
      reason: failure.reason,
      ...failure.message === undefined ? {} : { message: failure.message },
    })),
  }
}

/**
 * Build the Settings-page message for an import that found nothing. Only paths
 * whose FILES EXIST are worth reporting: a machine with no Trae install at all
 * is the common case, and listing every absent candidate path helps nobody.
 */
export function traeImportFailureMessage(failures: readonly TraeImportFailure[]): string {
  const present = failures.filter(failure => failure.reason !== 'missing')
  if (present.length === 0) {
    return '未检测到本机已登录的 Trae（TRAE SOLO CN / Trae CN）。请先在 Trae 客户端登录，再点击导入。'
  }
  const details = present
    .map(failure => `${failure.path}（${failure.message ?? failure.reason}）`)
    .join('；')
  return `检测到 Trae 安装但无法读取凭据：${details}`
}
