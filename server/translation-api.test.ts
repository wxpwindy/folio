import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSync } from 'fontkit'
import PDFDocument from 'pdfkit'
import { PDFParse } from 'pdf-parse'
import type { Response } from 'supertest'
import { AppError } from './ai.ts'
import type { GenerationInput, TailoredResult } from './ai.ts'
import { createApp } from './app.ts'
import { authenticatedRequest as request, createTestStore } from './test-support.ts'
import type { BaseResume, ResumeVersion, Store } from './store.ts'
import type { TranslationInput, TranslationResult } from './translation.ts'

const baseText = 'Alex Example\nalex@example.test\nEXPERIENCE\nMaintained TypeScript services and wrote automated tests in 2024 with a small engineering team.'
const savedText = 'Alex Example\nalex@example.test\nSAVED USER EDIT\nDocumented existing deployment procedures and reviewed TypeScript code with the engineering team.'
const chineseText = 'Alex Example\nalex@example.test\n工作经历\n2024 年与小型工程团队合作维护 TypeScript 服务并编写自动化测试。'
const translatedText = 'Alex Example\nalex@example.test\nEXPERIENCE\nIn 2024, maintained TypeScript services and wrote automated tests with a small engineering team.'
const jobDescription = 'Nous recherchons une personne pour développer des services TypeScript, écrire des tests automatisés et collaborer avec notre équipe.'
const missingId = '00000000-0000-4000-8000-000000000001'
const generated: TailoredResult = { language: { code: 'en', name: 'English' }, englishVersion: null, resumeText: baseText, summary: 'Synthetic tailoring.', keywords: [], gaps: [] }

function fakeTranslator() {
  return mock.fn(async (input: TranslationInput, _text: string, _type: 'resume' | 'cover-letter' = 'resume'): Promise<TranslationResult> => ({ text: input.targetLanguage === 'en' ? translatedText : chineseText }))
}
function fakeGenerator() {
  return mock.fn(async (_input: GenerationInput, _text: string): Promise<TailoredResult> => structuredClone(generated))
}
function binaryParser(response: Response, done: (error: Error | null, body?: Buffer) => void) {
  const chunks: Buffer[] = []
  response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
  response.on('error', done)
  response.on('end', () => done(null, Buffer.concat(chunks)))
}
async function pdfText(buffer: Buffer) {
  assert.equal(buffer.subarray(0, 5).toString(), '%PDF-')
  const parser = new PDFParse({ data: new Uint8Array(buffer) })
  try { return (await parser.getText()).text } finally { await parser.destroy() }
}
function makePdf(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48 })
    const chunks: Buffer[] = []
    doc.on('data', (chunk: Buffer) => chunks.push(chunk))
    doc.on('error', reject)
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.text(baseText)
    doc.end()
  })
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

// Probe glyph coverage AND subsetting; a present but unusable font is not enough.
function chineseFont(text: string) {
  const paths = ['/System/Library/Fonts/Supplemental/Arial Unicode.ttf', '/Library/Fonts/Arial Unicode.ttf', '/System/Library/Fonts/STHeiti Medium.ttc', '/System/Library/Fonts/Hiragino Sans GB.ttc', '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc', '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc', 'C:/Windows/Fonts/msyh.ttc']
  for (const path of paths) {
    if (!existsSync(path)) continue
    try {
      const opened = openSync(path)
      for (const face of 'fonts' in opened ? opened.fonts : [opened]) {
        if (Array.from(text.replace(/\n/g, '')).some(char => !face.hasGlyphForCodePoint(char.codePointAt(0)!))) continue
        const subset = face.createSubset()
        for (const glyph of face.layout(text.replace(/\n/g, ' ')).glyphs) subset.includeGlyph(glyph)
        subset.encode()
        return { path, name: path.endsWith('.ttc') ? face.postscriptName : undefined }
      }
    } catch { /* Skip unsupported installed fonts, never actual PDF export errors. */ }
  }
}

describe('translation API and independent persisted copies', { concurrency: false }, () => {
  let store: Store
  let app: ReturnType<typeof createApp>
  let translate: ReturnType<typeof fakeTranslator>
  let generate: ReturnType<typeof fakeGenerator>
  let base: BaseResume
  let sourcePdf: Buffer
  let directory: string | undefined
  const envNames = ['OPENAI_API_KEY', 'OLLAMA_URL', 'PDF_FONT_PATH', 'PDF_FONT_NAME'] as const
  let env: Record<string, string | undefined>
  let fetchMock: ReturnType<typeof stubFetch>
  function stubFetch() {
    return mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected live provider fetch in API test') })
  }
  beforeEach(async () => {
    env = Object.fromEntries(envNames.map(name => [name, process.env[name]]))
    for (const name of envNames) delete process.env[name]
    fetchMock = stubFetch()
    store = createTestStore(':memory:')
    generate = fakeGenerator()
    translate = fakeTranslator()
    app = createApp(store, generate, translate)
    sourcePdf = await makePdf()
    base = store.addBase({ filename: 'Alex Resume.PDF', text: baseText, pages: 1 }, sourcePdf)
  })
  afterEach(() => {
    try {
      assert.equal(fetchMock.mock.callCount(), 0, 'API tests must never request a live provider')
    } finally {
      store.db.close()
      mock.restoreAll()
      for (const name of envNames) {
        if (env[name] === undefined) delete process.env[name]
        else process.env[name] = env[name]
      }
      if (directory) rmSync(directory, { recursive: true, force: true })
      directory = undefined
    }
  })

  function input(sourceType: 'base' | 'version' = 'base', sourceId = base.id, targetLanguage: 'zh-Hans' | 'en' = 'en'): TranslationInput {
    return { sourceType, sourceId, targetLanguage, provider: 'ollama', model: 'fictional-translator' }
  }
  function tailoring(): GenerationInput {
    return { baseId: base.id, role: 'Engineer', company: 'Example Co', jobDescription, provider: 'ollama', model: 'fictional-generator' }
  }
  function sourceVersion(documentType?: 'resume' | 'cover-letter') {
    return store.addVersion({ baseId: base.id, baseText, role: 'Engineer', company: 'Example Co', jobDescription, text: baseText, summary: 'Original tailoring notes', keywords: ['TypeScript'], gaps: ['No certification'], provider: 'ollama', model: 'original-model', ...(documentType ? { documentType, language: { code: 'fr', name: 'French' }, generationId: missingId } : {}) })
  }
  async function edit(version: ResumeVersion, text = savedText, extra: Record<string, unknown> = {}) {
    const { body } = await request(app).patch(`/api/versions/${version.id}`).send({ role: version.role, company: version.company, text, status: 'ready', ...extra }).expect(200)
    return body as ResumeVersion
  }
  async function create(data = input()): Promise<ResumeVersion> {
    const { body } = await request(app).post('/api/translations').send(data).expect(201)
    assert.equal(body.additionalVersions, undefined)
    assert.equal(Array.isArray(body), false)
    return body
  }

  for (const target of ['zh-Hans', 'en'] as const) {
    it(`translates the saved base into ${target} as one editable copy, preserving base and original PDF`, async () => {
      await request(app).patch(`/api/base/${base.id}`).send({ text: savedText }).expect(200)
      const copy = await create(input('base', base.id, target))
      assert.equal(copy.role, 'Base resume')
      assert.equal(copy.company, 'Alex Resume')
      assert.equal(copy.jobDescription, '')
      assert.equal(copy.baseId, base.id)
      assert.equal(copy.baseText, savedText)
      assert.equal(copy.documentType, 'resume')
      assert.equal(copy.status, 'draft')
      assert.deepEqual(copy.language, { code: target, name: target === 'en' ? 'English' : 'Chinese (Simplified)' })
      assert.match(copy.generationId!, /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i)
      assert.deepEqual(copy.translation, { sourceType: 'base', sourceId: base.id, sourceText: savedText })
      assert.equal(copy.text, target === 'en' ? translatedText : chineseText)
      assert.deepEqual(copy.keywords, [])
      assert.deepEqual(copy.gaps, [])
      assert.match(copy.summary, /translation, not new job tailoring.*Review/)
      assert.deepEqual(translate.mock.calls[0].arguments, [input('base', base.id, target), savedText, 'resume'])
      const edited = await edit(copy)
      assert.equal(edited.text, savedText)
      assert.deepEqual(store.versions(), [edited])
      assert.deepEqual(store.base(), { ...base, text: savedText })
      const pdf = await request(app).get(`/api/base/${base.id}/pdf`).buffer(true).parse(binaryParser).expect(200)
      assert.deepEqual(pdf.body, sourcePdf)
      assert.equal(generate.mock.callCount(), 0)
      if (target === 'en') {
        const download = await request(app).get(`/api/versions/${copy.id}/pdf`).buffer(true).parse(binaryParser).expect(200)
        assert.equal(download.headers['content-disposition'], 'attachment; filename="Alex-Resume-Base-resume-en.pdf"')
        assert.match(await pdfText(download.body), /SAVED USER EDIT/)
        assert.doesNotMatch(await pdfText(download.body), /In 2024/)
      }
    })
  }

  it('exports edited Simplified Chinese text with a language filename and compatible system font', async context => {
    const editedText = chineseText.replace('工作经历', '项目经历')
    const font = chineseFont(`${editedText}\nBase resume — Alex Resume`)
    if (!font) { context.skip('No compatible system Chinese PDF font installed.'); return }
    process.env.PDF_FONT_PATH = font.path
    if (font.name) process.env.PDF_FONT_NAME = font.name
    const copy = await create(input('base', base.id, 'zh-Hans'))
    await edit(copy, editedText)
    const pdf = await request(app).get(`/api/versions/${copy.id}/pdf`).buffer(true).parse(binaryParser).expect(200).expect('Content-Type', /application\/pdf/)
    assert.equal(pdf.headers['content-disposition'], 'attachment; filename="Alex-Resume-Base-resume-zh-Hans.pdf"')
    const parsed = await pdfText(pdf.body)
    for (const line of editedText.split('\n')) assert.ok(parsed.includes(line), `Missing translated line: ${line}`)
    assert.ok(!parsed.includes('工作经历'))
    assert.deepEqual(store.base(), base)
    assert.deepEqual(Buffer.from(store.pdf(base.id)!), sourcePdf)
  })

  for (const type of [undefined, 'resume', 'cover-letter'] as const) {
    it(`translates current saved ${type ?? 'legacy resume'} edits, not the original base or JD`, async () => {
      const original = sourceVersion(type)
      const saved = await edit(original)
      await request(app).patch(`/api/base/${base.id}`).send({ text: translatedText }).expect(200)
      const copy = await create(input('version', saved.id))
      assert.deepEqual(translate.mock.calls[0].arguments, [input('version', saved.id), savedText, type ?? 'resume'])
      assert.deepEqual(copy.translation, { sourceType: 'version', sourceId: saved.id, sourceText: savedText })
      for (const field of ['baseId', 'baseText', 'jobDescription', 'role', 'company'] as const) assert.equal(copy[field], original[field])
      assert.equal(copy.documentType, type ?? 'resume')
      assert.deepEqual(copy.language, { code: 'en', name: 'English' })
      assert.notEqual(copy.generationId, original.generationId)
      assert.deepEqual(store.version(saved.id), saved)
      const pdf = await request(app).get(`/api/versions/${copy.id}/pdf`).buffer(true).parse(binaryParser).expect(200)
      assert.equal(pdf.headers['content-disposition'], `attachment; filename="Example-Co-Engineer${type === 'cover-letter' ? '-cover-letter' : ''}-en.pdf"`)
      assert.match(await pdfText(pdf.body), /In 2024/)
      assert.equal(generate.mock.callCount(), 0)
    })
  }

  it('PATCH keeps provenance, base snapshot, type, language and generation immutable while editing the copy', async () => {
    const original = sourceVersion('cover-letter')
    const copy = await create(input('version', original.id))
    const edited = await edit(copy, savedText, { role: 'Reviewed role', company: 'Reviewed Co', translation: { sourceType: 'base', sourceId: missingId, sourceText: 'spoof' }, sourceText: 'spoof', baseId: missingId, baseText: 'spoof', jobDescription: 'spoof', language: { code: 'fr', name: 'French' }, generationId: missingId, documentType: 'resume', provider: 'openai', model: 'spoof', apiKey: 'private-api-key' })
    assert.deepEqual(edited, { ...copy, text: savedText, role: 'Reviewed role', company: 'Reviewed Co', status: 'ready', updatedAt: edited.updatedAt })
    assert.deepEqual(store.version(copy.id), edited)
    assert.deepEqual(store.version(original.id), original)
    assert.deepEqual(store.base(), base)
  })

  it('repeated and chained translations have independent IDs, edits and deletion, never language pairs', async () => {
    const first = await create()
    const second = await create()
    const editedFirst = await edit(first)
    const chained = await create(input('version', first.id, 'zh-Hans'))
    assert.equal(new Set([first.id, second.id, chained.id]).size, 3)
    assert.equal(new Set([first.generationId, second.generationId, chained.generationId]).size, 3)
    assert.deepEqual(chained.translation, { sourceType: 'version', sourceId: first.id, sourceText: savedText })
    assert.equal(chained.baseText, baseText)
    await request(app).delete(`/api/versions/${first.id}`).expect(204)
    assert.deepEqual(store.versions(), [chained, second])
    await edit(chained)
    assert.deepEqual(store.version(second.id), second)
    assert.deepEqual(editedFirst.translation, first.translation)
    assert.deepEqual(store.base(), base)
  })

  it('retains translation snapshots after source deletion and base replacement across a disk restart', async () => {
    directory = mkdtempSync(join(tmpdir(), 'folio-translation-test-'))
    const filename = join(directory, 'test.sqlite')
    store.db.close()
    store = createTestStore(filename)
    app = createApp(store, generate, translate)
    base = store.addBase({ filename: 'Original.pdf', text: baseText, pages: 1 }, sourcePdf)
    const source = await edit(sourceVersion('cover-letter'))
    const fromBase = await create()
    const fromVersion = await create(input('version', source.id, 'zh-Hans'))
    await request(app).delete(`/api/versions/${source.id}`).expect(204)
    await request(app).patch(`/api/base/${base.id}`).send({ text: savedText }).expect(200)
    const replacement = await request(app).post('/api/base').attach('resume', sourcePdf, 'Replacement.pdf').expect(201)
    store.db.close()
    store = createTestStore(filename)
    app = createApp(store, generate, translate)
    const workspace = await request(app).get('/api/workspace').expect(200)
    assert.deepEqual(workspace.body.base, replacement.body)
    assert.deepEqual(workspace.body.versions, [fromVersion, fromBase])
    assert.equal(store.version(source.id), null)
    assert.equal(fromBase.translation?.sourceText, baseText)
    assert.equal(fromVersion.translation?.sourceText, savedText)
    assert.equal(fromVersion.baseText, baseText)
    assert.deepEqual(Buffer.from(store.pdf(base.id)!), sourcePdf)
    await edit(fromVersion)
    assert.deepEqual(store.version(fromBase.id), fromBase)
  })

  it('rejects missing/invalid source and target fields, wrong source kinds and injected text without a source', async () => {
    const data = input()
    for (const field of ['sourceType', 'sourceId', 'targetLanguage', 'provider', 'model'] as const) {
      const missing: Partial<TranslationInput> = { ...data }
      delete missing[field]
      await request(app).post('/api/translations').send(missing).expect(400)
    }
    for (const patch of [{ sourceType: 'resume' }, { sourceType: null }, { sourceId: '' }, { sourceId: 1 }, { targetLanguage: 'zh-Hant' }, { targetLanguage: 'fr' }, { targetLanguage: null }, { targetLanguage: ['en'] }, { provider: 'remote' }, { model: ' ' }, { cloudConsent: 'true' }, { sourceId: undefined, sourceText: baseText }]) {
      await request(app).post('/api/translations').send({ ...data, ...patch }).expect(400)
    }
    const version = sourceVersion()
    for (const data of [input('base', missingId), input('version', missingId), input('version', base.id), input('base', version.id)]) {
      await request(app).post('/api/translations').send({ ...data, sourceText: baseText }).expect(404)
    }
    assert.equal(translate.mock.callCount(), 0)
    assert.deepEqual(store.versions(), [version])
  })

  it('strips spoofed request/model metadata and secrets; server target and saved source are authoritative', async () => {
    const log = mock.method(console, 'log', () => {})
    const errorLog = mock.method(console, 'error', () => {})
    const data = { ...input(), provider: 'openai' as const, apiKey: 'private-api-key', cloudConsent: true }
    translate.mock.mockImplementation(async () => ({ text: translatedText, language: { code: 'fr', name: 'French' }, translation: { sourceText: 'spoof' }, generationId: missingId, apiKey: 'private-api-key' }))
    const { body } = await request(app).post('/api/translations').send({ ...data, sourceText: 'spoof', language: { code: 'fr', name: 'French' }, translation: { sourceId: missingId }, generationId: missingId, baseText: 'spoof', documentType: 'cover-letter', jobDescription: 'spoof' }).expect(201)
    assert.deepEqual(translate.mock.calls[0].arguments, [data, baseText, 'resume'])
    assert.deepEqual(body.translation, { sourceType: 'base', sourceId: base.id, sourceText: baseText })
    assert.deepEqual(body.language, { code: 'en', name: 'English' })
    assert.notEqual(body.generationId, missingId)
    assert.equal(body.documentType, 'resume')
    const workspace = await request(app).get('/api/workspace').expect(200)
    const persisted = store.db.prepare('SELECT document FROM versions').all()
    for (const value of [body, workspace.body, persisted]) assert.doesNotMatch(JSON.stringify(value), /private-api-key|apiKey|cloudConsent|spoof/)
    assert.equal(log.mock.callCount(), 0)
    assert.equal(errorLog.mock.callCount(), 0)
  })

  it('enforces host/origin gates before translating and retains local security headers', async () => {
    for (const [header, value] of [['Host', 'untrusted.example'], ['Host', 'localhost.untrusted.example'], ['Origin', 'https://untrusted.example'], ['Origin', 'null']]) {
      await request(app).post('/api/translations').set(header, value).send(input()).expect(403)
    }
    assert.equal(translate.mock.callCount(), 0)
    assert.deepEqual(store.versions(), [])
    const response = await request(app).post('/api/translations').set('Origin', 'http://127.0.0.1:5173').send(input()).expect(201)
    assert.equal(response.headers['cache-control'], 'no-store')
    assert.equal(response.headers['x-content-type-options'], 'nosniff')
    assert.equal(response.headers['referrer-policy'], 'no-referrer')
    assert.equal(response.headers['x-powered-by'], undefined)
  })

  it('invalid outputs, provider errors and failed inserts save nothing, release the lock and never log plaintext', async () => {
    const existing = sourceVersion()
    const log = mock.method(console, 'error', () => {})
    const info = mock.method(console, 'log', () => {})
    const data = { ...input(), apiKey: 'private-api-key' }
    const invalid: unknown[] = [null, {}, { text: 42 }, { text: 'x'.repeat(49) }, { text: ' '.repeat(100) }, { text: 'x'.repeat(50001) }]
    for (const output of invalid) {
      translate.mock.mockImplementationOnce(async () => output as TranslationResult)
      const response = await request(app).post('/api/translations').send(data).expect(502)
      assert.match(response.body.error, /invalid translation.*Nothing was saved/)
      assert.deepEqual(store.versions(), [existing])
    }
    for (const status of [401, 429, 502, 504]) {
      translate.mock.mockImplementationOnce(async () => { throw new AppError(status, 'Safe fictional provider failure') })
      await request(app).post('/api/translations').send(data).expect(status)
      assert.deepEqual(store.versions(), [existing])
    }
    translate.mock.mockImplementationOnce(async () => { throw new Error(`${baseText} ${jobDescription} private-api-key`) })
    const failed = await request(app).post('/api/translations').send(data).expect(500)
    assert.doesNotMatch(JSON.stringify(failed.body), /Alex Example|private-api-key|TypeScript/)
    assert.deepEqual(store.versions(), [existing])
    store.db.exec("CREATE TRIGGER reject_translation BEFORE INSERT ON versions BEGIN SELECT RAISE(ABORT, 'private-api-key'); END;")
    await request(app).post('/api/translations').send(data).expect(500)
    assert.deepEqual(store.versions(), [existing])
    store.db.exec('DROP TRIGGER reject_translation')
    // Exercise actual translator consent validation, without any model request.
    app = createApp(store, generate)
    await request(app).post('/api/translations').send({ ...data, provider: 'openai' }).expect(400)
    await request(app).post('/api/translations').send({ ...data, provider: 'openai', apiKey: '', cloudConsent: true }).expect(400)
    assert.deepEqual(store.versions(), [existing])
    app = createApp(store, generate, translate)
    const retry = await create()
    assert.deepEqual(store.versions(), [retry, existing])
    assert.equal(info.mock.callCount(), 0)
    assert.equal(log.mock.callCount(), 2)
    for (const call of log.mock.calls) assert.deepEqual(call.arguments, ['Request failed:', 'Error'])
  })

  it('pending translations lock tailoring and other translations, and capture base/version text exactly once before edits', async () => {
    for (const sourceType of ['base', 'version'] as const) {
      const source = sourceType === 'base' ? base : sourceVersion('cover-letter')
      const entered = deferred<void>()
      const finish = deferred<TranslationResult>()
      const reads = mock.method(store, sourceType === 'base' ? 'base' : 'version')
      translate.mock.mockImplementationOnce(async () => { entered.resolve(); return finish.promise })
      const data = input(sourceType, source.id)
      const pending = request(app).post('/api/translations').send(data).then(response => response)
      try {
        await entered.promise
        assert.equal(reads.mock.callCount(), 1)
        assert.deepEqual(translate.mock.calls.at(-1)!.arguments, [data, baseText, sourceType === 'version' ? 'cover-letter' : 'resume'])
        await request(app).post('/api/versions').send(tailoring()).expect(409)
        await request(app).post('/api/translations').send(data).expect(409)
        assert.equal(generate.mock.callCount(), 0)
        if (sourceType === 'base') {
          await request(app).patch(`/api/base/${source.id}`).send({ text: savedText }).expect(200)
        } else {
          await edit(source as ResumeVersion)
          await request(app).delete(`/api/versions/${source.id}`).expect(204)
        }
        const beforeFinish = reads.mock.callCount()
        finish.resolve({ text: translatedText })
        const response = await pending
        assert.equal(response.status, 201)
        assert.equal(reads.mock.callCount(), beforeFinish, 'source must not be re-read after awaiting translation')
        assert.deepEqual(response.body.translation, { sourceType, sourceId: source.id, sourceText: baseText })
        assert.equal(response.body.baseText, baseText)
        assert.equal(response.body.jobDescription, sourceType === 'version' ? jobDescription : '')
      } finally {
        finish.resolve({ text: translatedText })
        await pending
        reads.mock.restore()
      }
    }
    await request(app).post('/api/versions').send(tailoring()).expect(201)
    assert.equal(translate.mock.callCount(), 2)
  })

  it('pending tailoring holds the same lock against translations, then releases it on failure', async () => {
    const entered = deferred<void>()
    const finish = deferred<void>()
    generate.mock.mockImplementationOnce(async () => { entered.resolve(); await finish.promise; throw new AppError(504, 'Synthetic timeout') })
    const pending = request(app).post('/api/versions').send(tailoring()).then(response => response)
    try {
      await entered.promise
      await request(app).post('/api/translations').send(input()).expect(409)
      assert.equal(translate.mock.callCount(), 0)
      assert.deepEqual(store.versions(), [])
    } finally { finish.resolve() }
    assert.equal((await pending).status, 504)
    const copy = await create()
    assert.deepEqual(store.versions(), [copy])
  })
})