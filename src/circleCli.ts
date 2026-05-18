import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const execFileAsync = promisify(execFile)
const CIRCLE_BIN = process.platform === 'win32' ? 'circle.cmd' : 'circle'

export type CircleCliResult =
  | { ok: true; output: string }
  | { ok: false; output: string }

export type CircleCliOptions = {
  sessionKey?: string
  acceptTerms?: boolean
}

function safeSessionKey(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80)
}

export async function runCircleCli(args: string[], options: CircleCliOptions = {}): Promise<CircleCliResult> {
  try {
    const sessionHome = options.sessionKey
      ? resolve(process.cwd(), 'data', 'circle-sessions', safeSessionKey(options.sessionKey))
      : undefined
    if (sessionHome) await mkdir(sessionHome, { recursive: true })
    const { stdout, stderr } = await execFileAsync(CIRCLE_BIN, args, {
      timeout: 60_000,
      maxBuffer: 128 * 1024,
      shell: false,
      env: {
        ...process.env,
        ...(sessionHome ? { HOME: sessionHome, USERPROFILE: sessionHome } : {}),
        ...(options.acceptTerms ? { CIRCLE_ACCEPT_TERMS: '1' } : {}),
      },
    })
    const output = [stdout, stderr].filter(Boolean).join('\n').trim()
    return { ok: true, output: output || 'Circle CLI command completed.' }
  } catch (err) {
    const error = err as Error & { stdout?: string; stderr?: string; code?: number }
    const output = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n').trim()
    return { ok: false, output: output || 'Circle CLI command failed.' }
  }
}

export function formatCliCommand(args: string[]) {
  return ['circle', ...args].map(part => /\s/.test(part) ? `"${part.replace(/"/g, '\\"')}"` : part).join(' ')
}
