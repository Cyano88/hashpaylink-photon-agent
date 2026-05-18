import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const CIRCLE_BIN = process.platform === 'win32' ? 'circle.cmd' : 'circle'

export type CircleCliResult =
  | { ok: true; output: string }
  | { ok: false; output: string }

export async function runCircleCli(args: string[]): Promise<CircleCliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(CIRCLE_BIN, args, {
      timeout: 60_000,
      maxBuffer: 128 * 1024,
      shell: false,
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
