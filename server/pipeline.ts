import { createHash, randomUUID } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { AppError } from './ai.ts'
import { executePipelineCommand, pipelineEnvironment, redactPipelineLog } from './pipeline-process.ts'
import type { PipelineCommand, PipelineExecutor } from './pipeline-process.ts'
import type { PipelineRun, PipelineState, PipelineStep } from '../src/pipeline-types.ts'

export interface PipelineService {
  snapshot(): PipelineState
  start(): PipelineRun
  cancel(id: string): void
  deploy(id: string): void
  rollback(): void
}
const idSchema = z.string().uuid()
const status = z.enum(['queued', 'running', 'passed', 'failed', 'cancelled', 'interrupted', 'skipped'])
const persistedSchema = z.object({
  runs: z.array(z.object({ id: idSchema, status, startedAt: z.string(), finishedAt: z.string().optional(), digest: z.string().optional(), releaseReady: z.boolean(),
    steps: z.array(z.object({ name: z.string(), status, startedAt: z.string().optional(), finishedAt: z.string().optional(), log: z.string().max(9000) })).max(10),
  })).max(10), activeRelease: idSchema.nullable(), previousRelease: idSchema.nullable(),
})
const sourceEntries = ['src', 'server', 'tests', 'public', 'index.html', 'package.json', 'package-lock.json', 'vite.config.ts', 'playwright.config.ts',
  'tsconfig.json', 'tsconfig.app.json', 'tsconfig.node.json', 'tsconfig.server.json', '.oxlintrc.json']
const steps = ['Source snapshot', 'Lint', 'Backend tests', 'Frontend typecheck', 'Backend typecheck', 'Web build', 'Browser tests', 'Package release']
const now = () => new Date().toISOString()

/** Trusted local source only. Isolation protects app data, but is not an OS sandbox. */
export class LocalPipeline implements PipelineService {
  private state: ReturnType<typeof persistedSchema.parse> = { runs: [], activeRelease: null, previousRelease: null }
  private controller?: AbortController
  private running?: Promise<void>
  private root: string
  private directory: string
  private secrets: string[]
  private env: NodeJS.ProcessEnv
  private executor: PipelineExecutor
  private timeoutMs: number
  private persistenceTimer?: NodeJS.Timeout

  constructor(options: { root: string; executor?: PipelineExecutor; env?: NodeJS.ProcessEnv; timeoutMs?: number }) {
    this.root = resolve(options.root)
    this.directory = join(this.root, '.folio-ci')
    this.executor = options.executor ?? executePipelineCommand
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000
    const environment = options.env ?? process.env
    this.secrets = Object.entries(environment).filter(([key]) => /key|token|secret|password/i.test(key)).map(([, value]) => value ?? '')
    this.env = pipelineEnvironment(environment, dirname(process.execPath), join(this.root, 'node_modules', '.bin'))
    // Prefer installed Chrome when no bundled browser channel was explicitly chosen.
    if (!this.env.PLAYWRIGHT_CHANNEL && existsSync('/Applications/Google Chrome.app')) this.env.PLAYWRIGHT_CHANNEL = 'chrome'
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const file = join(this.directory, 'state.json')
    if (existsSync(file)) this.state = persistedSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
    const lockExisted = existsSync(join(this.directory, 'runner.lock'))
    if (!this.externalRunActive()) {
      if (lockExisted) rmSync(join(this.directory, 'runner.lock'), { force: true })
      for (const run of this.state.runs.filter(run => run.status === 'running')) {
        run.status = 'interrupted'; run.finishedAt = now()
        for (const step of run.steps) {
          if (step.status === 'running') { step.status = 'interrupted'; step.finishedAt = now() }
          if (step.status === 'queued') step.status = 'skipped'
        }
        rmSync(join(this.directory, 'work', run.id), { recursive: true, force: true })
        if (!run.releaseReady) rmSync(join(this.directory, 'releases', run.id), { recursive: true, force: true })
      }
      this.persist()
    }
  }
  private externalRunActive() {
    try { const pid = Number(readFileSync(join(this.directory, 'runner.lock'), 'utf8')); if (Number.isInteger(pid) && pid > 0) { process.kill(pid, 0); return true } } catch { /* No live runner owns the lock. */ }
    return false
  }
  private persist() {
    if (this.persistenceTimer) { clearTimeout(this.persistenceTimer); this.persistenceTimer = undefined }
    const temp = join(this.directory, `state-${process.pid}.tmp`)
    writeFileSync(temp, JSON.stringify(this.state), { mode: 0o600 })
    renameSync(temp, join(this.directory, 'state.json'))
  }
  private log(step: PipelineStep, message: string) {
    step.log = (step.log + redactPipelineLog(message, this.secrets, [this.root, this.env.HOME ?? ''])).slice(-8192)
    if (!this.persistenceTimer) this.persistenceTimer = setTimeout(() => {
      this.persistenceTimer = undefined
      try { this.persist() } catch { this.controller?.abort() }
    }, 500)
  }
  private refreshState() {
    if (!this.controller) this.state = persistedSchema.parse(JSON.parse(readFileSync(join(this.directory, 'state.json'), 'utf8')))
  }
  snapshot(): PipelineState {
    this.refreshState()
    return structuredClone({ ...this.state, available: true, busy: !!this.controller || this.externalRunActive(), canCancel: !!this.controller })
  }

  start(): PipelineRun {
    if (this.controller || this.externalRunActive()) throw new AppError(409, 'A local pipeline is already running.')
    this.refreshState()
    try { writeFileSync(join(this.directory, 'runner.lock'), String(process.pid), { flag: 'wx', mode: 0o600 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new AppError(409, 'A local pipeline owns the runner lock. Retry after it finishes or restart after a crash.'); throw error }
    this.controller = new AbortController()
    const run: PipelineRun = { id: randomUUID(), status: 'running', startedAt: now(), releaseReady: false, steps: steps.map(name => ({ name, status: 'queued', log: '' })) }
    this.state.runs.unshift(run)
    this.state.runs.splice(10)
    try {
      const retained = new Set([...this.state.runs.map(run => run.id), this.state.activeRelease, this.state.previousRelease])
      const releases = join(this.directory, 'releases')
      if (existsSync(releases)) for (const id of readdirSync(releases)) {
        if (idSchema.safeParse(id).success && !retained.has(id)) rmSync(join(releases, id), { recursive: true, force: true })
      }
      this.persist()
    } catch (error) { this.controller = undefined; rmSync(join(this.directory, 'runner.lock'), { force: true }); throw error }
    const signal = this.controller.signal
    this.running = Promise.resolve().then(() => this.perform(run, signal)).catch(() => {
      // Filesystem/cleanup failures must not become unhandled server rejections.
      run.status = 'failed'; run.releaseReady = false; run.finishedAt = now(); this.controller = undefined
      try { rmSync(join(this.directory, 'runner.lock'), { force: true }); this.persist() } catch { /* Storage is unavailable; status requests will report it. */ }
    })
    return structuredClone(run)
  }
  cancel(id: string) {
    const run = this.state.runs.find(run => run.id === idSchema.parse(id))
    if (!run) throw new AppError(404, 'Pipeline run not found.')
    if (run.status !== 'running' || !this.controller) throw new AppError(409, 'This run is no longer running.')
    this.controller.abort()
  }
  async waitForIdle() { await this.running }
  async close() { this.controller?.abort(); await this.running; if (this.persistenceTimer) this.persist() }

  private snapshotSource(destination: string) {
    mkdirSync(destination, { recursive: true, mode: 0o700 })
    const digest = createHash('sha256')
    const copy = (source: string, target: string, relative: string) => {
      const stat = lstatSync(source)
      if (stat.isSymbolicLink()) throw new Error('Source symlinks are not supported in pipeline snapshots.')
      if (stat.isDirectory()) {
        mkdirSync(target, { recursive: true, mode: 0o700 })
        for (const name of readdirSync(source).sort()) {
          if (name.startsWith('.env') || ['data', 'node_modules', '.git', '.folio-ci'].includes(name) || /\.(?:sqlite|db)(?:-|$)/.test(name)) continue
          copy(join(source, name), join(target, name), `${relative}/${name}`)
        }
      } else if (stat.isFile()) {
        const data = readFileSync(source)
        digest.update(relative).update('\0').update(data).update('\0')
        writeFileSync(target, data, { mode: 0o600 })
      }
    }
    for (const entry of sourceEntries) if (existsSync(join(this.root, entry))) copy(join(this.root, entry), join(destination, entry), entry)
    if (!existsSync(join(destination, 'package-lock.json')) || !existsSync(join(this.root, 'node_modules'))) throw new Error('Install dependencies locally before running the pipeline.')
    // Keep writable tool caches local, while reusing installed packages offline.
    const modules = join(destination, 'node_modules')
    mkdirSync(modules, { mode: 0o700 })
    for (const name of readdirSync(join(this.root, 'node_modules'))) {
      if (name.startsWith('.') && name !== '.bin') continue
      symlinkSync(join(this.root, 'node_modules', name), join(modules, name), lstatSync(join(this.root, 'node_modules', name)).isDirectory() ? 'dir' : 'file')
    }
    return digest.digest('hex')
  }
  private commands(work: string, id: string): PipelineCommand[] {
    const bin = (path: string) => join(this.root, 'node_modules', path)
    const node = (name: string, args: string[]): PipelineCommand => ({ name, executable: process.execPath, args })
    return [
      // The snapshot lives beneath Git-ignored .folio-ci; lint explicit source
      // paths without inherited ignore rules, never the linked dependencies.
      node('Lint', [bin('oxlint/bin/oxlint'), '--no-ignore', '--deny-warnings', ...sourceEntries.filter(entry =>
        existsSync(join(work, entry)) && (['src', 'server', 'tests', 'public'].includes(entry) || entry.endsWith('.ts')))]),
      node('Backend tests', ['--import', bin('tsx/dist/loader.mjs'), '--test', ...readdirSync(join(work, 'server')).filter(name => name.endsWith('.test.ts')).sort().map(name => join('server', name))]),
      node('Frontend typecheck', [bin('typescript/bin/tsc'), '-b']),
      node('Backend typecheck', [bin('typescript/bin/tsc'), '-p', 'tsconfig.server.json']),
      node('Web build', [bin('vite/bin/vite.js'), 'build', '--base', `/releases/${id}/`]),
      node('Browser tests', [bin('@playwright/test/cli.js'), 'test']),
    ]
  }
  private async perform(run: PipelineRun, signal: AbortSignal) {
    const work = join(this.directory, 'work', run.id)
    let step = run.steps[0]
    const begin = (next: PipelineStep) => { if (signal.aborted) throw new Error('Cancelled'); step = next; step.status = 'running'; step.startedAt = now(); this.persist() }
    const passed = () => { step.status = 'passed'; step.finishedAt = now(); this.persist() }
    try {
      begin(step)
      run.digest = this.snapshotSource(work)
      this.log(step, 'Copied trusted source into an isolated working directory. Local environment files and resume data excluded. Installed dependencies reused; no package installation or cloud generation.\n')
      passed()
      for (const [index, command] of this.commands(work, run.id).entries()) {
        begin(run.steps[index + 1])
        this.log(step, `${command.name} started.\n`)
        const timeout = AbortSignal.timeout(this.timeoutMs)
        const code = await this.executor(command, work, { ...this.env, FOLIO_CI_RELEASE_ID: run.id,
          ...(command.name === 'Web build' ? { NODE_ENV: 'production' } : {}),
        }, AbortSignal.any([signal, timeout]), line => this.log(step, line))
        if (signal.aborted) throw new Error('Cancelled')
        if (timeout.aborted) throw new Error('Step timed out.')
        if (code !== 0) throw new Error(`Step exited with code ${code}.`)
        passed()
      }
      begin(run.steps.at(-1)!)
      if (!existsSync(join(work, 'dist', 'index.html'))) throw new Error('Build did not produce a web application.')
      const release = join(this.directory, 'releases', run.id)
      cpSync(join(work, 'dist'), release, { recursive: true, dereference: false, filter: path => {
        if (lstatSync(path).isSymbolicLink()) throw new Error('Release symlinks are not allowed.')
        return true
      } })
      // Vite builds release-qualified URLs before browser tests: deploy exact tested bytes.
      this.log(step, 'Validated web release packaged. Use Deploy web release to publish it; backend restarts are deliberately manual.\n')
      passed(); run.status = 'passed'; run.releaseReady = true
    } catch (error) {
      run.status = signal.aborted ? 'cancelled' : 'failed'
      step.status = run.status; step.finishedAt = now()
      this.log(step, `${signal.aborted ? 'Run cancelled.' : error instanceof Error ? error.message : 'Pipeline failed.'}\n`)
      for (const remaining of run.steps) if (remaining.status === 'queued') remaining.status = 'skipped'
      rmSync(join(this.directory, 'releases', run.id), { recursive: true, force: true })
    } finally {
      run.finishedAt = now()
      rmSync(work, { recursive: true, force: true })
      this.controller = undefined
      rmSync(join(this.directory, 'runner.lock'), { force: true })
      this.persist()
    }
  }
  releaseDirectory(id: string) { return join(this.directory, 'releases', idSchema.parse(id)) }
  activeDirectory() { this.refreshState(); return this.state.activeRelease ? this.releaseDirectory(this.state.activeRelease) : null }
  deploy(id: string) {
    if (this.controller || this.externalRunActive()) throw new AppError(409, 'Wait for the active pipeline to finish.')
    this.refreshState()
    const run = this.state.runs.find(run => run.id === idSchema.parse(id))
    if (!run || run.status !== 'passed' || !run.releaseReady || !existsSync(join(this.releaseDirectory(id), 'index.html'))) throw new AppError(409, 'Only a successful, retained web release can be deployed.')
    if (this.state.activeRelease === id) return
    const previous = { ...this.state }
    this.state.previousRelease = this.state.activeRelease; this.state.activeRelease = id
    try { this.persist() } catch (error) { this.state = previous; throw error }
  }
  rollback() {
    if (this.controller || this.externalRunActive()) throw new AppError(409, 'Wait for the active pipeline to finish.')
    this.refreshState()
    const previous = this.state.previousRelease
    if (!previous || !existsSync(join(this.releaseDirectory(previous), 'index.html'))) throw new AppError(409, 'No previous web release is available.')
    const old = { ...this.state }
    this.state.previousRelease = this.state.activeRelease; this.state.activeRelease = previous
    try { this.persist() } catch (error) { this.state = old; throw error }
  }
}