import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import request from 'supertest'
import { LocalPipeline } from './pipeline.ts'
import { installPipelineStatic } from './pipeline-static.ts'
import { executePipelineCommand, pipelineEnvironment, redactPipelineLog } from './pipeline-process.ts'
import type { PipelineExecutor } from './pipeline-process.ts'

describe('local pipeline runner and deployment (isolated fictional filesystem)', () => {
  let root: string
  const runners: LocalPipeline[] = []
  const runner = (executor?: PipelineExecutor, timeoutMs?: number) => {
    const pipeline = new LocalPipeline({ root, executor: executor ?? success, timeoutMs, env: { HOME: tmpdir(), OPENAI_API_KEY: 'fictional-sensitive-value', DATA_DIR: '/never-read', NODE_OPTIONS: '--never-inherit' } })
    runners.push(pipeline); return pipeline
  }
  const success: PipelineExecutor = async (command, cwd, env, _signal, log) => {
    log('Fictional output: OPENAI_API_KEY=fictional-sensitive-value\n')
    if (command.name === 'Web build') {
      mkdirSync(join(cwd, 'dist', 'assets'), { recursive: true })
      writeFileSync(join(cwd, 'dist', 'index.html'), `<h1>${env.FOLIO_CI_RELEASE_ID}</h1><script src="/releases/${env.FOLIO_CI_RELEASE_ID}/assets/app.js"></script>`)
      writeFileSync(join(cwd, 'dist', 'assets', 'app.js'), `console.log('${env.FOLIO_CI_RELEASE_ID}')`)
    }
    return 0
  }
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'folio-ci-test-'))
    for (const folder of ['src', 'server', 'tests', 'node_modules/.tmp', 'data', 'dist']) mkdirSync(join(root, folder), { recursive: true })
    writeFileSync(join(root, 'package.json'), '{}'); writeFileSync(join(root, 'package-lock.json'), '{}')
    writeFileSync(join(root, 'src', 'main.ts'), 'export const fictional = true')
    writeFileSync(join(root, 'server', 'example.test.ts'), '// Fictional source')
    writeFileSync(join(root, '.env'), 'Fictional private environment')
    writeFileSync(join(root, 'data', 'account-setup-code'), 'fictional-test-only')
    writeFileSync(join(root, 'data', 'folio.sqlite'), 'fictional database sentinel')
    writeFileSync(join(root, 'dist', 'index.html'), 'Original workspace web build')
  })
  afterEach(async () => {
    await Promise.all(runners.splice(0).map(pipeline => pipeline.close()))
    rmSync(root, { recursive: true, force: true })
  })

  it('executes fixed steps on a source snapshot with no local credentials/data and isolated caches', async () => {
    const calls: string[] = []
    const pipeline = runner(async (command, cwd, env, signal, log) => {
      calls.push(command.name)
      assert.notEqual(cwd, root)
      for (const excluded of ['.env', 'data', '.git']) assert.equal(existsSync(join(cwd, excluded)), false)
      assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.DATA_DIR, undefined); assert.equal(env.NODE_OPTIONS, undefined)
      assert.equal(readFileSync(join(cwd, 'src', 'main.ts'), 'utf8'), 'export const fictional = true')
      mkdirSync(join(cwd, 'node_modules', '.tmp'), { recursive: true })
      writeFileSync(join(cwd, 'node_modules', '.tmp', 'cache'), 'isolated')
      assert.equal(existsSync(join(root, 'node_modules', '.tmp', 'cache')), false)
      assert.equal(command.executable, process.execPath)
      return success(command, cwd, env, signal, log)
    })
    const run = pipeline.start()
    assert.throws(() => pipeline.start(), /already running/)
    await pipeline.waitForIdle()
    const result = pipeline.snapshot().runs[0]
    assert.equal(result.status, 'passed'); assert.equal(result.releaseReady, true)
    assert.match(result.digest!, /^[a-f0-9]{64}$/)
    assert.equal(result.steps.length, 8); assert.ok(result.steps.every(step => step.status === 'passed'))
    assert.deepEqual(calls, ['Lint', 'Backend tests', 'Frontend typecheck', 'Backend typecheck', 'Web build', 'Browser tests'])
    assert.equal(existsSync(join(root, '.folio-ci', 'work', run.id)), false)
    assert.equal(readFileSync(join(root, 'dist', 'index.html'), 'utf8'), 'Original workspace web build')
    assert.equal(readFileSync(join(root, 'data', 'folio.sqlite'), 'utf8'), 'fictional database sentinel')
    const persisted = readFileSync(join(root, '.folio-ci', 'state.json'), 'utf8')
    assert.ok(!persisted.includes('fictional-sensitive-value')); assert.ok(persisted.includes('[redacted]'))
  })

  it('fails closed, skips downstream work and refuses deployment of failed runs', async () => {
    const calls: string[] = []
    const pipeline = runner(async command => { calls.push(command.name); return 7 })
    const run = pipeline.start(); await pipeline.waitForIdle()
    assert.deepEqual(calls, ['Lint'])
    assert.equal(pipeline.snapshot().runs[0].status, 'failed')
    assert.ok(pipeline.snapshot().runs[0].steps.slice(2).every(step => step.status === 'skipped'))
    assert.throws(() => pipeline.deploy(run.id), /successful/)
    assert.equal(pipeline.activeDirectory(), null)
  })

  it('supports cancellation, process ownership locking and retry without parallel work', async () => {
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const pipeline = runner(async (_command, _cwd, _env, signal) => { started(); return new Promise(resolve => signal.addEventListener('abort', () => resolve(1), { once: true })) })
    const run = pipeline.start(); await ready
    const observer = runner()
    assert.equal(observer.snapshot().busy, true); assert.equal(observer.snapshot().canCancel, false)
    assert.throws(() => observer.start(), /already running/)
    assert.throws(() => pipeline.deploy(run.id), /Wait/)
    pipeline.cancel(run.id); await pipeline.waitForIdle()
    assert.equal(pipeline.snapshot().runs[0].status, 'cancelled')
    assert.equal(observer.snapshot().busy, false)
    const retry = observer.start(); await observer.waitForIdle()
    assert.equal(observer.snapshot().runs[0].id, retry.id)
    assert.equal(observer.snapshot().runs[0].status, 'passed')
  })

  it('timeouts fail a step without permitting deployment', async () => {
    const pipeline = runner(async (_command, _cwd, _env, signal) => new Promise(resolve => {
      const keepAlive = setInterval(() => {}, 10)
      signal.addEventListener('abort', () => { clearInterval(keepAlive); resolve(1) }, { once: true })
    }), 20)
    pipeline.start(); await pipeline.waitForIdle()
    assert.equal(pipeline.snapshot().runs[0].status, 'failed')
    assert.match(pipeline.snapshot().runs[0].steps[1].log, /timed out/)
  })

  it('deploys exact tested assets atomically, preserves old version URLs, and rolls back', async () => {
    const pipeline = runner()
    const first = pipeline.start(); await pipeline.waitForIdle(); pipeline.deploy(first.id)
    const second = pipeline.start(); await pipeline.waitForIdle(); pipeline.deploy(second.id)
    const app = express(); installPipelineStatic(app, pipeline, join(root, 'dist'))
    const page = await request(app).get('/').expect(200)
    assert.match(page.text, new RegExp(second.id)); assert.equal(page.headers['cache-control'], 'no-store')
    await request(app).get(`/releases/${first.id}/assets/app.js`).expect(200)
    await request(app).get('/releases/not-a-uuid/assets/app.js').expect(404)
    await request(app).get('/assets/missing.js').expect(404)
    await request(app).get('/api/not-real').expect(404)
    pipeline.rollback()
    assert.equal(pipeline.snapshot().activeRelease, first.id)
    assert.match((await request(app).get('/').expect(200)).text, new RegExp(first.id))
    const restored = runner(); assert.equal(restored.snapshot().activeRelease, first.id)
    assert.equal(readFileSync(join(root, 'data', 'folio.sqlite'), 'utf8'), 'fictional database sentinel')
  })

  it('bounds logs/history and keeps active releases when old run history is trimmed', async () => {
    const pipeline = runner(async (...args) => { args[4]('x'.repeat(20000)); return success(...args) })
    const first = pipeline.start(); await pipeline.waitForIdle(); pipeline.deploy(first.id)
    for (let i = 0; i < 10; i++) { pipeline.start(); await pipeline.waitForIdle() }
    const state = pipeline.snapshot()
    assert.equal(state.runs.length, 10)
    assert.ok(state.runs.every(run => run.steps.every(step => step.log.length <= 8192)))
    assert.equal(state.activeRelease, first.id)
    assert.ok(existsSync(join(pipeline.releaseDirectory(first.id), 'index.html')))
    pipeline.deploy(state.runs[1].id)
    pipeline.deploy(state.runs[0].id)
    pipeline.start(); await pipeline.waitForIdle()
    assert.equal(existsSync(pipeline.releaseDirectory(first.id)), false)
  })

  it('recovers interrupted history and removes partial working copies on restart', async () => {
    const pipeline = runner(); const run = pipeline.start(); await pipeline.waitForIdle()
    const state = JSON.parse(readFileSync(join(root, '.folio-ci', 'state.json'), 'utf8'))
    state.runs[0].status = 'running'; state.runs[0].releaseReady = false; state.runs[0].steps[1].status = 'running'
    writeFileSync(join(root, '.folio-ci', 'state.json'), JSON.stringify(state))
    mkdirSync(join(root, '.folio-ci', 'work', run.id), { recursive: true })
    const recovered = runner()
    assert.equal(recovered.snapshot().runs[0].status, 'interrupted')
    assert.equal(existsSync(join(root, '.folio-ci', 'work', run.id)), false)
    assert.equal(existsSync(recovered.releaseDirectory(run.id)), false)
  })

  it('rejects source symlinks and release symlinks rather than copying private targets', async () => {
    symlinkSync(join(root, '.env'), join(root, 'src', 'linked.txt'))
    const pipeline = runner(); pipeline.start(); await pipeline.waitForIdle()
    assert.equal(pipeline.snapshot().runs[0].status, 'failed')
    assert.match(pipeline.snapshot().runs[0].steps[0].log, /symlinks/)
    assert.equal(readdirSync(join(root, '.folio-ci', 'work')).length, 0)
    rmSync(join(root, 'src', 'linked.txt'))
    const releaseRunner = runner(async (...args) => {
      const result = await success(...args)
      if (args[0].name === 'Web build') symlinkSync(join(root, '.env'), join(args[1], 'dist', 'linked.txt'))
      return result
    })
    const run = releaseRunner.start(); await releaseRunner.waitForIdle()
    assert.equal(releaseRunner.snapshot().runs[0].status, 'failed')
    assert.match(releaseRunner.snapshot().runs[0].steps.at(-1)!.log, /symlinks/)
    assert.equal(existsSync(releaseRunner.releaseDirectory(run.id)), false)
  })
})

describe('pipeline child process safety', () => {
  it('redacts credentials, ANSI escapes and local paths', () => {
    assert.equal(redactPipelineLog('\u001b[31mKEY=fictional-secret /private/root/file\u001b[0m', ['fictional-secret'], ['/private/root']), 'KEY=[redacted] [local]/file')
    const env = pipelineEnvironment({ HOME: '/home', PATH: '/untrusted', OPENAI_API_KEY: 'no', NODE_OPTIONS: 'no', DATA_DIR: 'no', PLAYWRIGHT_CHANNEL: 'chrome' }, '/node', '/bin')
    assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.DATA_DIR, undefined)
    assert.ok(!env.PATH!.includes('/untrusted')); assert.equal(env.PLAYWRIGHT_CHANNEL, 'chrome')
  })
  it('buffers split output before redaction and exits with the child status', async () => {
    const lines: string[] = []
    const code = await executePipelineCommand({ name: 'Fictional output', executable: process.execPath, args: ['-e', 'process.stdout.write("fictional-"); setImmediate(() => process.stdout.write("secret\\n"));'] }, tmpdir(), {}, new AbortController().signal,
      line => lines.push(redactPipelineLog(line, ['fictional-secret'], [])))
    assert.equal(code, 0); assert.deepEqual(lines, ['[redacted]\n'])
  })
  it('aborts a running child without a shell', async () => {
    const controller = new AbortController()
    const result = executePipelineCommand({ name: 'Fictional wait', executable: process.execPath, args: ['-e', 'console.log("ready"); setInterval(() => {}, 1000)'] }, tmpdir(), {}, controller.signal, () => controller.abort())
    assert.notEqual(await result, 0)
  })
})