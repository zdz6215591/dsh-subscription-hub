/**
 * Pick up a Mistral credential that the **Vibe CLI** already provisioned.
 *
 * Mistral's docs say the CLI's browser sign-in "provisions and stores credentials
 * for you" (`docs.mistral.ai/vibe/code/cli/api-keys-profiles`), and that it saves
 * them to the OS keyring, falling back to `~/.vibe/.env`. The sign-in itself lives
 * inside that closed-source client — there is no public OAuth client a third-party
 * plugin can drive — so the honest way to offer "browser sign-in" here is: let the
 * CLI do it once, then read what it stored.
 *
 * Both places are tried, keyring first, because the CLI prefers the keyring.
 */

import { readMistralVibeKey } from './mistral-vibe.js'

/** A credential row as the enumeration script reports it. */
export interface KeyringRow {
  target: string
  user: string
  secret: string
}

/**
 * The Windows credential enumeration, as one PowerShell script.
 *
 * Windows Credential Manager is the only store with a stable API reachable without
 * a native dependency, and the Vibe CLI's target name is not documented — so every
 * credential is enumerated and filtered by name here rather than guessed.
 */
export const WINDOWS_KEYRING_SCRIPT = String.raw`Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class DshMistralCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public IntPtr TargetName; public IntPtr Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public IntPtr TargetAlias; public IntPtr UserName;
  }
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredEnumerate(string filter, int flag, out int count, out IntPtr credentials);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr buffer);
}
"@
function Decode-Blob([IntPtr]$ptr, [int]$size) {
  if ($ptr -eq [IntPtr]::Zero -or $size -le 0) { return '' }
  $bytes = New-Object byte[] $size
  [Runtime.InteropServices.Marshal]::Copy($ptr, $bytes, 0, $size)
  $uni = [Text.Encoding]::Unicode.GetString($bytes).Trim([char]0)
  $utf = [Text.Encoding]::UTF8.GetString($bytes).Trim([char]0)
  if ($uni -match '^[\x20-\x7E]+$') { return $uni }
  if ($utf -match '^[\x20-\x7E]+$') { return $utf }
  if ($uni.Length -ge $utf.Length) { return $uni }
  return $utf
}
$rows = @()
$count = 0; $enumPtr = [IntPtr]::Zero
if ([DshMistralCred]::CredEnumerate($null, 1, [ref]$count, [ref]$enumPtr)) {
  try {
    for ($i = 0; $i -lt $count; $i++) {
      $credPtr = [Runtime.InteropServices.Marshal]::ReadIntPtr($enumPtr, $i * [IntPtr]::Size)
      $cred = [Runtime.InteropServices.Marshal]::PtrToStructure($credPtr, [type][DshMistralCred+CREDENTIAL])
      $target = [Runtime.InteropServices.Marshal]::PtrToStringUni($cred.TargetName)
      $user = [Runtime.InteropServices.Marshal]::PtrToStringUni($cred.UserName)
      $rows += [pscustomobject]@{ target = $target; user = $user; secret = (Decode-Blob $cred.CredentialBlob $cred.CredentialBlobSize) }
    }
  } finally { [DshMistralCred]::CredFree($enumPtr) }
}
$rows | ConvertTo-Json -Compress -Depth 3`

/** Names a Vibe/Mistral credential uses. */
const MISTRAL_TARGET = /vibe|mistral/i

/**
 * Whether a secret looks like a Mistral API key.
 *
 * Measured: the Studio key this route was built against starts with `mstrl_`, and
 * the docs' example keys are `[A-Za-z0-9_-]`. Anything shorter than 16 characters
 * or carrying whitespace is a different kind of credential and is skipped.
 *
 * @param secret - the decoded blob.
 * @returns true when it can be sent as a bearer key.
 */
export function looksLikeMistralKey(secret: string): boolean {
  const value = secret.trim()
  return /^[A-Za-z0-9_-]{16,}$/.test(value)
}

/**
 * Pick the Mistral key out of a keyring enumeration.
 *
 * @param rows - decoded rows.
 * @returns the key, or undefined when no row is a Mistral credential.
 */
export function pickMistralKeyFromRows(rows: readonly KeyringRow[]): string | undefined {
  for (const row of rows) {
    if (!MISTRAL_TARGET.test(`${row.target} ${row.user}`)) continue
    const secret = row.secret.trim()
    if (looksLikeMistralKey(secret)) return secret
  }
  return undefined
}

/** Runs a shell command and returns its stdout. */
export type RunScript = (script: string) => Promise<string>

/**
 * Read a Mistral key from the Windows Credential Manager.
 *
 * @param run - runner for the enumeration script.
 * @returns the key, or undefined when nothing matched.
 */
export async function readMistralKeyringKey(run: RunScript): Promise<string | undefined> {
  try {
    const output = await run(WINDOWS_KEYRING_SCRIPT)
    const parsed: unknown = JSON.parse(output.trim() === '' ? '[]' : output)
    const rows = (Array.isArray(parsed) ? parsed : [parsed]).filter(
      (row): row is KeyringRow => typeof row === 'object' && row !== null
        && typeof (row as KeyringRow).target === 'string'
        && typeof (row as KeyringRow).secret === 'string',
    )
    return pickMistralKeyFromRows(rows)
  } catch {
    return undefined
  }
}

/**
 * Import a Mistral credential from this machine: the keyring first, then the Vibe
 * CLI's env file.
 *
 * @param options - keyring runner and home directory (both injected for a test).
 * @returns the key and the place it came from, or undefined when there is none.
 */
export async function importLocalMistralKey(
  options: { run?: RunScript; home?: string } = {},
): Promise<{ key: string; source: 'keyring' | 'env' } | undefined> {
  if (options.run !== undefined) {
    const fromKeyring = await readMistralKeyringKey(options.run)
    if (fromKeyring !== undefined) return { key: fromKeyring, source: 'keyring' }
  }
  const fromEnv = await readMistralVibeKey(options.home)
  if (fromEnv !== undefined) return { key: fromEnv, source: 'env' }
  return undefined
}

/**
 * The real keyring runner for this platform.
 *
 * Windows is the only store this route can read without a native dependency; on
 * anything else it returns empty output so the env file is the source.
 *
 * @returns a runner that executes the enumeration script and returns its stdout.
 */
export function windowsKeyringRunner(): RunScript {
  return async (script: string): Promise<string> => {
    if (process.platform !== 'win32') return ''
    const { execFile } = await import('node:child_process')
    const { rm, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { promisify } = await import('node:util')
    const run = promisify(execFile)
    const scriptPath = join(tmpdir(), `dsh-mistral-cred-${process.pid}-${Date.now()}.ps1`)
    try {
      await writeFile(scriptPath, script, 'utf8')
      const { stdout } = await run(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        { timeout: 20_000, windowsHide: true, encoding: 'utf8' },
      )
      return stdout
    } finally {
      await rm(scriptPath, { force: true })
    }
  }
}