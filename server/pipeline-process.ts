import { spawn } from 'node:child_process'
import { stripVTControlCharacters } from 'node:util'

export interface PipelineCommand { name: string; executable: string; args: string[] }
export type PipelineExecutor = (command: PipelineCommand, cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal, log: (line: string) => void) => Promise<number>

/** Deliberately do not inherit API keys, DATA_DIR, NODE_OPTIONS or npm hooks. */
export function pipelineEnvironment(source: NodeJS.ProcessEnv, nodeBin: string, workspaceBin: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CI: '1', NO_COLOR: '1', FORCE_COLOR: '0', NODE_ENV: 'test' }
  for (const key of ['HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'LANG']) {
    if (source[key]) env[key] = source[key]
  }
  env.PATH = [workspaceBin, nodeBin, '/usr/local/bin', '/usr/bin', '/bin'].join(process.platform === 'win32' ? ';' : ':')
  if (source.PLAYWRIGHT_CHANNEL === 'chrome') env.PLAYWRIGHT_CHANNEL = 'chrome'
  return env
}

export function redactPipelineLog(text: string, secrets: string[], paths: string[]): string {
  let value = Array.from(stripVTControlCharacters(text)).filter(character => {
    const code = character.codePointAt(0)!
    return code === 9 || code === 10 || (code >= 32 && code !== 127)
  }).join('')
  for (const secret of secrets.filter(value => value.length >= 4).sort((a, b) => b.length - a.length)) value = value.split(secret).join('[redacted]')
  value = value.replace(/((?:api[_-]?key|password|authorization|secret|token)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
  for (const path of paths.filter(Boolean).sort((a, b) => b.length - a.length)) value = value.split(path).join('[local]')
  return value
}

/** No shell, browser-supplied command, or stdin. Abort terminates the process group. */
export const executePipelineCommand: PipelineExecutor = (command, cwd, env, signal, log) => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(new Error('Step cancelled.')); return }
  const child = spawn(command.executable, command.args, { cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
  const buffers = { stdout: '', stderr: '' }
  const dropping = { stdout: false, stderr: false }
  // Only complete lines reach the redactor: secrets split over chunks stay hidden.
  function output(channel: 'stdout' | 'stderr', chunk: string) {
    for (const piece of chunk.split(/(?<=\n)/)) {
      if (!dropping[channel]) buffers[channel] += piece
      if (buffers[channel].length > 8192) { buffers[channel] = ''; dropping[channel] = true }
      if (piece.endsWith('\n')) {
        log(dropping[channel] ? '[oversized output line omitted]\n' : buffers[channel])
        buffers[channel] = ''; dropping[channel] = false
      }
    }
  }
  child.stdout.setEncoding('utf8').on('data', chunk => output('stdout', chunk))
  child.stderr.setEncoding('utf8').on('data', chunk => output('stderr', chunk))
  let killTimer: NodeJS.Timeout | undefined
  function kill(signal: NodeJS.Signals) {
    try {
      if (child.pid && process.platform !== 'win32') process.kill(-child.pid, signal)
      else child.kill(signal)
    } catch { /* The process group already exited. */ }
  }
  function abort() {
    kill('SIGTERM')
    killTimer = setTimeout(() => kill('SIGKILL'), 1500)
    killTimer.unref()
  }
  signal.addEventListener('abort', abort, { once: true })
  child.once('error', reject)
  child.once('close', code => {
    signal.removeEventListener('abort', abort)
    if (!signal.aborted && killTimer) clearTimeout(killTimer)
    for (const channel of ['stdout', 'stderr'] as const) {
      if (buffers[channel]) log(`${buffers[channel]}\n`)
    }
    resolve(code ?? 1)
  })
  if (signal.aborted) abort()
})