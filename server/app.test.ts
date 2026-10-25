import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import PDFDocument from 'pdfkit'
import { PDFParse } from 'pdf-parse'
import type { Response } from 'supertest'
import { AppError } from './ai.ts'
import type { GenerationInput, TailoredResult } from './ai.ts'
import { createApp } from './app.ts'
import { exportPdf } from './pdf.ts'
import { authenticatedRequest as request, createTestStore } from './test-support.ts'
import type { BaseResume, ResumeVersion, Store } from './store.ts'

const baseText = 'Alex Example\nalex@example.test\nEXPERIENCE\nBuilt and maintained TypeScript services, wrote automated tests, and reviewed code with a small engineering team.'
const editedText = 'Alex Example\nalex@example.test\nEXPERIENCE\nMaintained JavaScript applications and documented deployment procedures for the engineering team.'
const jobDescription = 'We need a software engineer to build TypeScript services, write automated tests, review code, and collaborate with our engineering team.'
const tailored: TailoredResult = {
  language: { code: 'en', name: 'English' },
  englishVersion: null,
  resumeText: baseText,
  summary: 'Emphasized the existing TypeScript and testing experience.',
  keywords: ['TypeScript', 'automated tests'],
  gaps: ['No cloud certification is evidenced in the base resume.'],
}
const englishVersion = {
  resumeText: tailored.resumeText, summary: tailored.summary, keywords: tailored.keywords, gaps: tailored.gaps,
}
const bilingual: TailoredResult = {
  language: { code: 'fr', name: 'French' },
  resumeText: 'Alex Example\nalex@example.test\nEXPÉRIENCE\nDéveloppement de services TypeScript et rédaction de tests automatisés avec une petite équipe.',
  summary: 'Expérience TypeScript mise en avant.',
  keywords: ['TypeScript', 'tests automatisés'],
  gaps: ['Aucune certification cloud attestée.'],
  englishVersion,
}
const missingId = '00000000-0000-4000-8000-000000000001'

// Real PDFKit documents exercise the importer rather than mocking PDF extraction.
function makePdf(draw: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48 })
    const chunks: Buffer[] = []
    doc.on('data', (chunk: Buffer) => chunks.push(chunk))
    doc.on('error', reject)
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    draw(doc)
    doc.end()
  })
}

function binaryParser(response: Response, done: (error: Error | null, body?: Buffer) => void) {
  const chunks: Buffer[] = []
  response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
  response.on('error', done)
  response.on('end', () => done(null, Buffer.concat(chunks)))
}

async function readPdf(buffer: Buffer) {
  assert.ok(Buffer.isBuffer(buffer))
  assert.equal(buffer.subarray(0, 5).toString(), '%PDF-')
  assert.match(buffer.subarray(-32).toString(), /%%EOF/)
  const parser = new PDFParse({ data: new Uint8Array(buffer) })
  try {
    return await parser.getText()
  } finally {
    await parser.destroy()
  }
}

function fakeGenerator() {
  return mock.fn(async (_input: GenerationInput, _base: string): Promise<TailoredResult> => structuredClone(tailored))
}

describe('local resume API and in-memory persistence', { concurrency: false }, () => {
  let store: Store
  let app: ReturnType<typeof createApp>
  let generate: ReturnType<typeof fakeGenerator>
  let sourcePdf: Buffer

  beforeEach(async () => {
    store = createTestStore(':memory:')
    generate = fakeGenerator()
    app = createApp(store, generate)
    sourcePdf = await makePdf(doc => { doc.text(baseText) })
  })

  afterEach(() => {
    store.db.close()
    mock.restoreAll()
  })

  function input(baseId: string): GenerationInput {
    return { baseId, role: 'Software Engineer', company: 'Example Co', jobDescription, provider: 'ollama', model: 'test-model' }
  }

  async function importBase(buffer = sourcePdf, filename = 'resume.pdf'): Promise<BaseResume> {
    const response = await request(app).post('/api/base')
      .attach('resume', buffer, { filename, contentType: 'application/pdf' }).expect(201)
    return response.body as BaseResume
  }

  async function createVersion(baseId: string): Promise<ResumeVersion> {
    const response = await request(app).post('/api/versions').send(input(baseId)).expect(201)
    return response.body as ResumeVersion
  }

  function assertNoVersions() {
    assert.deepEqual(store.versions(), [])
    assert.equal(generate.mock.callCount(), 0)
  }

  it('saves an independent cover letter with immutable type, source and JD, then exports edited letter text', async () => {
    const base = await importBase()
    const resume = await createVersion(base.id)
    assert.equal(resume.documentType, 'resume')
    const text = 'Alex Example\nalex@example.test\n\nDear Hiring Team,\n\nI am applying for the Software Engineer role at Example Co. My TypeScript services and automated testing experience directly relates to the responsibilities described.\n\nThank you for your consideration.\nAlex Example'
    generate.mock.mockImplementationOnce(async () => ({ ...tailored, resumeText: text }))
    const data = { ...input(base.id), documentType: 'cover-letter', apiKey: 'fake-test-key', cloudConsent: true }
    const { body: letter } = await request(app).post('/api/versions').send(data).expect(201)
    assert.equal(generate.mock.calls[1].arguments[0].documentType, 'cover-letter')
    assert.equal(generate.mock.calls[1].arguments[1], base.text)
    assert.equal(letter.documentType, 'cover-letter')
    assert.equal(letter.text, text)
    assert.equal(letter.baseText, base.text)
    assert.equal(letter.jobDescription, jobDescription)
    assert.equal(letter.additionalVersions, undefined)
    assert.equal(letter.apiKey, undefined)
    assert.equal(letter.cloudConsent, undefined)
    assert.notEqual(letter.generationId, resume.generationId)
    await request(app).patch(`/api/base/${base.id}`).send({ text: editedText }).expect(200)
    const patch = { text: text.replace('Thank you for your consideration.', 'Thank you for reviewing my application.'), role: letter.role, company: letter.company, status: 'ready' }
    const { body: edited } = await request(app).patch(`/api/versions/${letter.id}`).send({
      ...patch, documentType: 'resume', baseText: editedText, jobDescription: 'overwrite', generationId: 'overwrite', language: { code: 'de', name: 'German' },
    }).expect(200)
    assert.deepEqual(edited, { ...letter, ...patch, updatedAt: edited.updatedAt })
    const pdf = await request(app).get(`/api/versions/${letter.id}/pdf`).buffer(true).parse(binaryParser).expect(200).expect('Content-Type', /application\/pdf/)
    assert.equal(pdf.headers['content-disposition'], 'attachment; filename="Example-Co-Software-Engineer-cover-letter-en.pdf"')
    const parsed = await readPdf(pdf.body)
    assert.equal(parsed.total, 1)
    assert.match(parsed.text, /Thank you for reviewing my application/)
    assert.match(parsed.text, /Dear Hiring Team/)
    assert.deepEqual(store.version(resume.id), resume)
    const workspace = await request(app).get('/api/workspace').expect(200)
    assert.deepEqual(workspace.body.versions, [edited, resume])
    await request(app).delete(`/api/versions/${letter.id}`).expect(204)
    assert.deepEqual(store.versions(), [resume])
    assert.deepEqual(Buffer.from(store.pdf(base.id)!), sourcePdf)
  })

  it('rejects invalid document types before calling a provider or saving', async () => {
    const base = await importBase()
    for (const documentType of ['letter', null, 1, {}, ['cover-letter']]) {
      await request(app).post('/api/versions').send({ ...input(base.id), documentType }).expect(400)
      assertNoVersions()
    }
    await request(app).post('/api/versions').set('Origin', 'https://evil.example').send({ ...input(base.id), documentType: 'cover-letter' }).expect(403)
    assertNoVersions()
  })

  it('atomically saves both cover-letter languages and keeps their edits and deletions independent', async () => {
    const base = await importBase()
    generate.mock.mockImplementation(async () => structuredClone(bilingual))
    const { body } = await request(app).post('/api/versions').send({ ...input(base.id), documentType: 'cover-letter' }).expect(201)
    const { additionalVersions: [english], ...primary } = body
    assert.equal(primary.documentType, 'cover-letter')
    assert.equal(english.documentType, 'cover-letter')
    assert.equal(primary.generationId, english.generationId)
    assert.deepEqual(store.versions(), [english, primary])
    await request(app).patch(`/api/versions/${primary.id}`).send({ role: primary.role, company: primary.company, text: editedText, status: 'ready' }).expect(200)
    assert.deepEqual(store.version(english.id), english)
    await request(app).delete(`/api/versions/${primary.id}`).expect(204)
    assert.deepEqual(store.versions(), [english])
  })

  it('rejects incomplete cover-letter pairs and rolls back failed English inserts without losing resumes', async () => {
    const base = await importBase()
    const resume = await createVersion(base.id)
    const data = { ...input(base.id), documentType: 'cover-letter' }
    generate.mock.mockImplementationOnce(async () => ({ ...bilingual, englishVersion: null }))
    await request(app).post('/api/versions').send(data).expect(502)
    assert.deepEqual(store.versions(), [resume])
    generate.mock.mockImplementation(async () => structuredClone(bilingual))
    const log = mock.method(console, 'error', () => {})
    store.db.exec(`CREATE TRIGGER reject_letter_english BEFORE INSERT ON versions
      WHEN json_extract(NEW.document, '$.language.code') = 'en'
      BEGIN SELECT RAISE(ABORT, 'test-only English letter insert failure'); END;`)
    await request(app).post('/api/versions').send(data).expect(500)
    assert.deepEqual(store.versions(), [resume])
    assert.deepEqual(log.mock.calls[0].arguments, ['Request failed:', 'Error'])
    store.db.exec('DROP TRIGGER reject_letter_english')
    const { body } = await request(app).post('/api/versions').send(data).expect(201)
    const { additionalVersions, ...primary } = body
    assert.deepEqual(store.versions(), [additionalVersions[0], primary, resume])
  })

  it('returns an empty workspace, public configuration, and security headers', async () => {
    const response = await request(app).get('/api/workspace').expect(200)
    assert.deepEqual(response.body, {
      base: null,
      versions: [],
      config: {
        openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
        ollamaModel: process.env.OLLAMA_MODEL || 'llama3.2',
        openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        lmstudioModel: process.env.LMSTUDIO_MODEL || 'google/gemma-4-e4b',
        defaultProvider: process.env.FOLIO_AI_PROVIDER === 'lmstudio' ? 'lmstudio' : 'ollama',
      },
    })
    assert.equal(response.headers['x-powered-by'], undefined)
    assert.equal(response.headers['x-content-type-options'], 'nosniff')
    assert.equal(response.headers['referrer-policy'], 'no-referrer')
    assert.equal(response.headers['cache-control'], 'no-store')
    assertNoVersions()
  })

  it('imports selectable PDF text and downloads the byte-identical original', async () => {
    const base = await importBase()
    assert.match(base.id, /^[\da-f-]{36}$/i)
    assert.equal(base.filename, 'resume.pdf')
    assert.equal(base.pages, 1)
    assert.ok(Number.isFinite(Date.parse(base.createdAt)))
    assert.match(base.text, /Alex Example/)
    assert.match(base.text, /TypeScript services/)
    assert.deepEqual(store.base(base.id), base)
    const workspace = await request(app).get('/api/workspace').expect(200)
    assert.deepEqual(workspace.body.base, base)
    assert.deepEqual(workspace.body.versions, [])
    const download = await request(app).get(`/api/base/${base.id}/pdf`)
      .buffer(true).parse(binaryParser).expect(200).expect('Content-Type', /application\/pdf/)
    assert.equal(download.headers['content-disposition'], 'attachment; filename="base-resume.pdf"')
    assert.deepEqual(download.body, sourcePdf)
    assert.deepEqual(Buffer.from(store.pdf(base.id)!), sourcePdf)
    assert.match((await readPdf(download.body)).text, /Alex Example/)
  })

  it('rejects an upload with no file', async () => {
    const response = await request(app).post('/api/base').expect(400)
    assert.match(response.body.error, /valid PDF/)
    assert.equal(store.base(), null)
  })

  it('rejects non-PDF bytes even when the filename and MIME type claim PDF', async () => {
    const response = await request(app).post('/api/base')
      .attach('resume', Buffer.from(baseText), { filename: 'fake.pdf', contentType: 'application/pdf' }).expect(400)
    assert.match(response.body.error, /valid PDF/)
    assert.equal(store.base(), null)
  })

  it('rejects a damaged PDF with an otherwise valid signature', async () => {
    const response = await request(app).post('/api/base')
      .attach('resume', Buffer.from('%PDF-1.7\nnot a PDF document'), 'broken.pdf').expect(400)
    assert.match(response.body.error, /could not be read/)
    assert.equal(store.base(), null)
  })

  it('rejects scan-like PDFs without selectable text and preserves an existing base', async () => {
    const base = await importBase()
    // A graphics-only page has the same lack of selectable text as a scan.
    const scan = await makePdf(doc => { doc.rect(50, 50, 200, 100).fill('#333333') })
    const response = await request(app).post('/api/base').attach('resume', scan, 'scan.pdf').expect(400)
    assert.match(response.body.error, /Scanned PDFs need OCR/)
    assert.deepEqual(store.base(), base)
    assert.deepEqual(Buffer.from(store.pdf(base.id)!), sourcePdf)
  })

  it('rejects a PDF with too little selectable text', async () => {
    const short = await makePdf(doc => { doc.text('Alex Example') })
    const response = await request(app).post('/api/base').attach('resume', short, 'short.pdf').expect(400)
    assert.match(response.body.error, /too little selectable text/)
    assert.equal(store.base(), null)
  })

  it('rejects PDFs over 30 pages', async () => {
    const long = await makePdf(doc => {
      doc.text(baseText)
      for (let page = 1; page < 31; page++) doc.addPage().text(baseText)
    })
    const response = await request(app).post('/api/base').attach('resume', long, 'long.pdf').expect(400)
    assert.match(response.body.error, /too long/)
    assert.equal(store.base(), null)
  })

  it('rejects more than 50,000 extracted characters even below the page limit', async () => {
    const dense = await makePdf(doc => { doc.fontSize(2).text('TypeScript '.repeat(4700)) })
    const parsed = await readPdf(dense)
    assert.ok(parsed.total <= 30)
    assert.ok(parsed.text.trim().length > 50000)
    const response = await request(app).post('/api/base').attach('resume', dense, 'dense.pdf').expect(400)
    assert.match(response.body.error, /too long/)
    assert.equal(store.base(), null)
  })

  it('rejects multiple files, unexpected file fields, and files over 10 MB', async () => {
    for (const upload of [
      request(app).post('/api/base').attach('resume', sourcePdf, 'one.pdf').attach('resume', sourcePdf, 'two.pdf'),
      request(app).post('/api/base').attach('wrong-field', sourcePdf, 'resume.pdf'),
      request(app).post('/api/base').attach('resume', Buffer.alloc(10 * 1024 * 1024 + 1), 'huge.pdf'),
    ]) {
      const response = await upload.expect(400)
      assert.match(response.body.error, /Upload one PDF file, up to 10 MB/)
      assert.equal(store.base(), null)
    }
  })

  it('edits and trims base text without changing metadata or the original PDF', async () => {
    const base = await importBase()
    const response = await request(app).patch(`/api/base/${base.id}`).send({ text: `  ${editedText}  ` }).expect(200)
    assert.deepEqual(response.body, { ...base, text: editedText })
    assert.deepEqual(store.base(), response.body)
    const download = await request(app).get(`/api/base/${base.id}/pdf`).buffer(true).parse(binaryParser).expect(200)
    assert.deepEqual(download.body, sourcePdf)
  })

  it('rejects missing, short, whitespace-only, non-string, and overlong base edits without saving', async () => {
    const base = await importBase()
    for (const body of [{}, { text: 'too short' }, { text: ' '.repeat(100) }, { text: 123 }, { text: 'x'.repeat(50001) }]) {
      const response = await request(app).patch(`/api/base/${base.id}`).send(body).expect(400)
      assert.equal(typeof response.body.error, 'string')
      assert.deepEqual(store.base(base.id), base)
    }
  })

  it('creates a draft with the exact generator input, captured base, result, and no saved API key', async () => {
    const base = await importBase()
    const payload = { ...input(base.id), role: ' Software Engineer ', company: ' Example Co ', model: ' test-model ', apiKey: 'test-only-key' }
    const response = await request(app).post('/api/versions').send(payload).expect(201)
    const version = response.body as ResumeVersion
    assert.equal(generate.mock.callCount(), 1)
    assert.deepEqual(generate.mock.calls[0].arguments, [{ ...payload, role: 'Software Engineer', company: 'Example Co', model: 'test-model' }, base.text])
    assert.match(version.id, /^[\da-f-]{36}$/i)
    assert.match(version.generationId!, /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i)
    assert.equal('additionalVersions' in response.body, false)
    assert.ok(Number.isFinite(Date.parse(version.createdAt)))
    assert.equal(version.updatedAt, version.createdAt)
    assert.deepEqual(version, {
      id: version.id, baseId: base.id, baseText: base.text,
      documentType: 'resume',
      role: 'Software Engineer', company: 'Example Co', jobDescription,
      text: tailored.resumeText, summary: tailored.summary, keywords: tailored.keywords, gaps: tailored.gaps,
      language: tailored.language, generationId: version.generationId,
      provider: 'ollama', model: 'test-model', status: 'draft',
      createdAt: version.createdAt, updatedAt: version.createdAt,
    })
    assert.deepEqual(store.version(version.id), version)
    assert.deepEqual(store.versions(), [version])
    assert.ok(!JSON.stringify(store.versions()).includes('test-only-key'))
  })

  for (const code of ['en-US', 'en-GB']) {
    it(`saves only one primary version for regional English ${code}`, async () => {
      const base = await importBase()
      const language = { code, name: 'English' }
      generate.mock.mockImplementationOnce(async () => ({ ...tailored, language }))
      const response = await request(app).post('/api/versions').send(input(base.id)).expect(201)
      assert.deepEqual(response.body.language, language)
      assert.equal('additionalVersions' in response.body, false)
      assert.equal('englishVersion' in response.body, false)
      assert.deepEqual(store.versions(), [response.body])
      const pdf = await request(app).get(`/api/versions/${response.body.id}/pdf`).expect(200)
      assert.equal(pdf.headers['content-disposition'], `attachment; filename="Example-Co-Software-Engineer-${code}.pdf"`)
    })
  }

  for (const candidate of [
    { output: bilingual, jd: 'Nous recherchons une personne pour développer des services TypeScript, écrire des tests automatisés et collaborer avec notre équipe.' },
    {
      output: { ...bilingual, language: { code: 'es-MX', name: 'Spanish (Mexico)' },
        resumeText: 'Alex Example\nalex@example.test\nEXPERIENCIA\nMantenimiento de servicios TypeScript y creación de pruebas automatizadas con un pequeño equipo.',
        summary: 'Se destacó la experiencia con TypeScript.', keywords: ['TypeScript', 'pruebas automatizadas'], gaps: ['No consta una certificación de nube.'] },
      jd: 'Buscamos una persona para desarrollar servicios TypeScript, escribir pruebas automatizadas y colaborar con nuestro equipo de ingeniería.',
    },
    {
      output: { ...bilingual, language: { code: 'zh-Hant', name: 'Chinese (Traditional)' },
        resumeText: 'Alex Example\nalex@example.test\n工作經歷\n與小型工程團隊合作維護 TypeScript 服務，撰寫自動化測試並參與程式碼審查。',
        summary: '強調既有的服務維護經驗。', keywords: ['TypeScript', '自動化測試'], gaps: ['沒有雲端認證的依據。'] },
      jd: '我們正在招聘軟體工程師，負責維護 TypeScript 服務、撰寫自動化測試、審查程式碼並與工程團隊合作。我們重視清晰的技術文件、可靠的服務維護及團隊溝通能力，歡迎具備相關經驗的候選人申請。',
    },
  ]) {
    it(`returns and atomically saves independent ${candidate.output.language.code} and English versions with shared provenance`, async () => {
      const base = await importBase()
      const payload = { ...input(base.id), jobDescription: candidate.jd, apiKey: 'test-pair-key' }
      generate.mock.mockImplementationOnce(async () => structuredClone(candidate.output))
      const batch = mock.method(store, 'addVersions')
      const response = await request(app).post('/api/versions').send(payload).expect(201)
      const { additionalVersions, ...primary } = response.body
      assert.equal(additionalVersions.length, 1)
      const [english] = additionalVersions as ResumeVersion[]
      assert.equal(batch.mock.callCount(), 1)
      assert.equal(batch.mock.calls[0].arguments[0].length, 2)
      assert.deepEqual(generate.mock.calls[0].arguments, [payload, base.text])
      assert.notEqual(primary.id, english.id)
      assert.match(primary.generationId, /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i)
      for (const [version, expected, language] of [
        [primary, candidate.output, candidate.output.language],
        [english, englishVersion, { code: 'en', name: 'English' }],
      ] as const) {
        assert.deepEqual(version, {
          id: version.id, baseId: base.id, baseText: base.text,
          documentType: 'resume',
          role: payload.role, company: payload.company, jobDescription: candidate.jd,
          provider: payload.provider, model: payload.model, generationId: primary.generationId,
          language, text: expected.resumeText, summary: expected.summary, keywords: expected.keywords, gaps: expected.gaps,
          status: 'draft', createdAt: version.createdAt, updatedAt: version.createdAt,
        })
        assert.match(version.id, /^[\da-f-]{36}$/i)
        assert.ok(Number.isFinite(Date.parse(version.createdAt)))
        assert.deepEqual(store.version(version.id), version)
        const pdf = await request(app).get(`/api/versions/${version.id}/pdf`).expect(200)
        assert.equal(pdf.headers['content-disposition'], `attachment; filename="Example-Co-Software-Engineer-${language.code}.pdf"`)
      }
      assert.deepEqual(store.versions(), [english, primary])
      const workspace = await request(app).get('/api/workspace').expect(200)
      assert.deepEqual(workspace.body.versions, [english, primary])
      assert.ok(!JSON.stringify(workspace.body).includes('test-pair-key'))
      assert.deepEqual(store.base(), base)
      const next = await createVersion(base.id)
      assert.notEqual(next.generationId, primary.generationId)
    })
  }

  for (const target of ['primary', 'english'] as const) {
    it(`editing and deleting the ${target} member leaves its counterpart and source snapshots unchanged`, async () => {
      const base = await importBase()
      generate.mock.mockImplementationOnce(async () => structuredClone(bilingual))
      const response = await request(app).post('/api/versions').send(input(base.id)).expect(201)
      const { additionalVersions, ...primary } = response.body
      const english = additionalVersions[0] as ResumeVersion
      const [selected, other] = target === 'primary' ? [primary, english] : [english, primary]
      await request(app).patch(`/api/base/${base.id}`).send({ text: editedText }).expect(200)
      const replacementPdf = await makePdf(doc => { doc.text(editedText) })
      const replacement = await importBase(replacementPdf, 'replacement.pdf')
      for (const status of ['ready', 'applied', 'draft'] as const) {
        const patch = { role: 'Reviewed Engineer', company: 'Reviewed Co', text: editedText, status }
        const edited = await request(app).patch(`/api/versions/${selected.id}`).send({
          ...patch, baseId: replacement.id, baseText: 'tampered', generationId: missingId,
          language: { code: 'de', name: 'German' }, jobDescription: 'tampered', keywords: ['invented'],
        }).expect(200)
        assert.deepEqual(edited.body, { ...selected, ...patch, updatedAt: edited.body.updatedAt })
        assert.deepEqual(store.version(other.id), other)
      }
      await request(app).delete(`/api/versions/${selected.id}`).expect(204)
      assert.deepEqual(store.versions(), [other])
      assert.equal(other.baseText, base.text)
      assert.equal(store.base(base.id)?.text, editedText)
      assert.deepEqual(store.base(), replacement)
      assert.deepEqual(Buffer.from(store.pdf(base.id)!), sourcePdf)
      assert.deepEqual(Buffer.from(store.pdf(replacement.id)!), replacementPdf)
      const workspace = await request(app).get('/api/workspace').expect(200)
      assert.deepEqual(workspace.body.versions, [other])
    })
  }

  it('keeps legacy versions without language or generation metadata readable, editable, and exportable', async () => {
    const base = await importBase()
    const legacy = store.addVersion({
      baseId: base.id, baseText: base.text, role: 'Engineer', company: 'Example', jobDescription,
      text: baseText, summary: tailored.summary, keywords: tailored.keywords, gaps: tailored.gaps,
      provider: 'ollama', model: 'old-model',
    })
    assert.equal('language' in legacy, false)
    assert.equal('generationId' in legacy, false)
    const workspace = await request(app).get('/api/workspace').expect(200)
    assert.deepEqual(workspace.body.versions, [legacy])
    const edited = await request(app).patch(`/api/versions/${legacy.id}`).send({
      role: legacy.role, company: legacy.company, text: editedText, status: 'ready',
    }).expect(200)
    assert.deepEqual(edited.body, { ...legacy, text: editedText, status: 'ready', updatedAt: edited.body.updatedAt })
    const pdf = await request(app).get(`/api/versions/${legacy.id}/pdf`).expect(200)
    assert.equal(pdf.headers['content-disposition'], 'attachment; filename="Example-Engineer.pdf"')
    await request(app).delete(`/api/versions/${legacy.id}`).expect(204)
    assert.deepEqual(store.versions(), [])
  })

  it('validates JD length after trimming and does not generate or save invalid requests', async () => {
    const base = await importBase()
    for (const jd of [undefined, '', ' '.repeat(100), 'x'.repeat(79), `  ${'x'.repeat(79)}  `, 'x'.repeat(30001), 123]) {
      const response = await request(app).post('/api/versions').send({ ...input(base.id), jobDescription: jd }).expect(400)
      assert.equal(typeof response.body.error, 'string')
      assertNoVersions()
    }
    await request(app).post('/api/versions').send({ ...input(base.id), jobDescription: ` ${'x'.repeat(80)} ` }).expect(201)
    assert.equal(generate.mock.calls[0].arguments[0].jobDescription, 'x'.repeat(80))
  })

  it('validates required generation identifiers, names, provider, model, and consent types', async () => {
    const base = await importBase()
    for (const patch of [
      { baseId: 'not-a-uuid' }, { role: ' ' }, { role: 'x'.repeat(151) },
      { company: '' }, { company: 'x'.repeat(151) }, { provider: 'unknown' },
      { model: '' }, { model: 'x'.repeat(101) }, { cloudConsent: 'yes' }, { apiKey: 'x'.repeat(501) },
    ]) {
      await request(app).post('/api/versions').send({ ...input(base.id), ...patch }).expect(400)
      assertNoVersions()
    }
  })

  it('preserves version snapshots across base edits and replacement imports', async () => {
    const original = await importBase()
    const first = await createVersion(original.id)
    await request(app).patch(`/api/base/${original.id}`).send({ text: editedText }).expect(200)
    const second = await createVersion(original.id)
    assert.equal(second.baseText, editedText)
    const replacementPdf = await makePdf(doc => { doc.text(editedText) })
    const replacement = await importBase(replacementPdf, 'replacement.pdf')
    assert.notEqual(replacement.id, original.id)
    assert.deepEqual(store.base(), replacement)
    assert.deepEqual(store.version(first.id), first)
    assert.deepEqual(store.version(second.id), second)
    assert.equal(store.base(original.id)?.text, editedText)
    const third = await createVersion(replacement.id)
    assert.equal(third.baseId, replacement.id)
    assert.equal(third.baseText, replacement.text)
    const workspace = await request(app).get('/api/workspace').expect(200)
    assert.deepEqual(workspace.body.versions, [third, second, first])
    const oldDownload = await request(app).get(`/api/base/${original.id}/pdf`).buffer(true).parse(binaryParser).expect(200)
    const newDownload = await request(app).get(`/api/base/${replacement.id}/pdf`).buffer(true).parse(binaryParser).expect(200)
    assert.deepEqual(oldDownload.body, sourcePdf)
    assert.deepEqual(newDownload.body, replacementPdf)
  })

  it('updates text and every supported status, preserves provenance, and deletes only the target version', async () => {
    const base = await importBase()
    const first = await createVersion(base.id)
    const other = await createVersion(base.id)
    for (const status of ['ready', 'applied', 'draft'] as const) {
      const patch = { role: ' Senior Engineer ', company: ' New Co ', text: ` ${editedText} `, status }
      const response = await request(app).patch(`/api/versions/${first.id}`).send({ ...patch, baseText: 'tampered', baseId: missingId }).expect(200)
      assert.ok(Date.parse(response.body.updatedAt) >= Date.parse(first.updatedAt))
      assert.deepEqual(response.body, {
        ...first, role: 'Senior Engineer', company: 'New Co', text: editedText, status, updatedAt: response.body.updatedAt,
      })
      assert.deepEqual(store.version(first.id), response.body)
    }
    const deleted = await request(app).delete(`/api/versions/${first.id}`).expect(204)
    assert.equal(deleted.text, '')
    assert.equal(store.version(first.id), null)
    assert.deepEqual(store.versions(), [other])
    assert.deepEqual(store.base(), base)
    await request(app).delete(`/api/versions/${first.id}`).expect(404)
    await request(app).get(`/api/versions/${first.id}/pdf`).expect(404)
  })

  it('rejects invalid version updates without mutating the saved version', async () => {
    const base = await importBase()
    const version = await createVersion(base.id)
    const valid = { role: version.role, company: version.company, text: version.text, status: 'ready' }
    const invalid = [{}, ...[
      { role: '' }, { company: ' ' }, { role: 'x'.repeat(151) }, { company: 'x'.repeat(151) },
      { text: 'short' }, { text: 'x'.repeat(50001) }, { status: 'submitted' },
    ].map(patch => ({ ...valid, ...patch }))]
    for (const body of invalid) {
      await request(app).patch(`/api/versions/${version.id}`).send(body).expect(400)
      assert.deepEqual(store.version(version.id), version)
    }
  })

  it('exports edited version text as a readable PDF with a sanitized attachment filename', async () => {
    const base = await importBase()
    const version = await createVersion(base.id)
    const patch = { role: 'Engineer/Lead', company: 'Example "Co"\r\nX-Test: injected', text: editedText, status: 'ready' }
    await request(app).patch(`/api/versions/${version.id}`).send(patch).expect(200)
    const response = await request(app).get(`/api/versions/${version.id}/pdf`)
      .buffer(true).parse(binaryParser).expect(200).expect('Content-Type', /application\/pdf/)
    const filename = `${patch.company}-${patch.role}`.replace(/[^a-z0-9-]/gi, '-').slice(0, 100)
    assert.equal(response.headers['content-disposition'], `attachment; filename="${filename}-en.pdf"`)
    assert.equal(response.headers['x-test'], undefined)
    assert.match((await readPdf(response.body)).text, /documented deployment procedures/)
    assert.deepEqual(Buffer.from(store.pdf(base.id)!), sourcePdf)
  })

  it('returns not-found errors for absent bases, versions, and API routes', async () => {
    const cases = [
      [request(app).patch(`/api/base/${missingId}`).send({ text: baseText }), 'Base resume not found.'],
      [request(app).get(`/api/base/${missingId}/pdf`), 'Original PDF not found.'],
      [request(app).post('/api/versions').send(input(missingId)), 'Upload a base resume first.'],
      [request(app).patch(`/api/versions/${missingId}`).send({ role: 'Engineer', company: 'Co', text: baseText, status: 'draft' }), 'Resume version not found.'],
      [request(app).delete(`/api/versions/${missingId}`), 'Resume version not found.'],
      [request(app).get(`/api/versions/${missingId}/pdf`), 'Resume version not found.'],
      [request(app).get('/api/missing'), 'Endpoint not found.'],
    ] as const
    for (const [operation, error] of cases) {
      const response = await operation.expect(404)
      assert.deepEqual(response.body, { error })
    }
    assertNoVersions()
  })

  it('rejects malicious Host headers, including lookalike loopback domains', async () => {
    for (const host of ['evil.example', 'localhost.evil.example', '127.0.0.1.evil.example', '192.168.1.2']) {
      const response = await request(app).post('/api/base').set('Host', host)
        .attach('resume', sourcePdf, 'resume.pdf').expect(403)
      assert.deepEqual(response.body, { error: 'Only local access is allowed.' })
      assert.equal(store.base(), null)
    }
  })

  it('rejects malicious Origin headers before generating or saving', async () => {
    const base = await importBase()
    for (const origin of ['https://evil.example', 'http://localhost:5173.evil.example', 'http://localhost:9999', 'null', 'https://localhost:5173']) {
      const response = await request(app).post('/api/versions').set('Host', 'localhost:3001')
        .set('Origin', origin).send(input(base.id)).expect(403)
      assert.deepEqual(response.body, { error: 'Cross-origin requests are not allowed.' })
      assertNoVersions()
    }
  })

  it('accepts loopback hosts, development/preview origins, and same-origin requests', async () => {
    for (const host of ['localhost:3001', '127.0.0.1:3001', '[::1]:3001']) {
      await request(app).get('/api/workspace').set('Host', host).expect(200)
      await request(app).get('/api/workspace').set('Host', host).set('Origin', `http://${host}`).expect(200)
    }
    for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:4173', 'http://127.0.0.1:4173']) {
      await request(app).get('/api/workspace').set('Host', 'localhost:3001').set('Origin', origin).expect(200)
    }
  })

  it('rejects malformed JSON and oversized request bodies without saving', async () => {
    const malformed = await request(app).post('/api/versions').set('Content-Type', 'application/json').send('{broken').expect(400)
    assert.deepEqual(malformed.body, { error: 'Invalid JSON request.' })
    const oversized = await request(app).post('/api/versions').send({ text: 'x'.repeat(1024 * 1024) }).expect(413)
    assert.deepEqual(oversized.body, { error: 'Request is too large.' })
    assertNoVersions()
  })

  it('does not save failed generation, preserves existing versions, and releases the generation lock', async () => {
    const base = await importBase()
    const existing = await createVersion(base.id)
    generate.mock.mockImplementationOnce(async () => { throw new AppError(502, 'Deterministic provider failure') })
    const response = await request(app).post('/api/versions').send(input(base.id)).expect(502)
    assert.deepEqual(response.body, { error: 'Deterministic provider failure' })
    assert.deepEqual(store.versions(), [existing])
    assert.deepEqual(store.base(), base)
    const retried = await createVersion(base.id)
    assert.deepEqual(store.versions(), [retried, existing])
    assert.equal(generate.mock.callCount(), 3)
  })

  for (const [label, output] of [
    ['missing language', { ...tailored, language: undefined }],
    ['malformed code', { ...bilingual, language: { code: 'fr_CA', name: 'French' } }],
    ['missing English field', { ...bilingual, englishVersion: undefined }],
    ['null English counterpart', { ...bilingual, englishVersion: null }],
    ['missing English text', { ...bilingual, englishVersion: { ...englishVersion, resumeText: undefined } }],
    ['placeholder English text', { ...bilingual, englishVersion: { ...englishVersion, resumeText: 'Translation pending' } }],
    ['missing English summary', { ...bilingual, englishVersion: { ...englishVersion, summary: undefined } }],
    ['invalid English keywords', { ...bilingual, englishVersion: { ...englishVersion, keywords: 'TypeScript' } }],
    ['missing English gaps', { ...bilingual, englishVersion: { ...englishVersion, gaps: undefined } }],
    ['invalid primary with valid English', { ...bilingual, resumeText: 'too short' }],
    ['duplicate English', { ...tailored, englishVersion }],
    ['duplicate regional English', { ...tailored, language: { code: 'en-US', name: 'English' }, englishVersion }],
  ] as const) {
    it(`saves nothing for ${label}, preserves existing records, and releases the generation lock`, async () => {
      const base = await importBase()
      const existing = await createVersion(base.id)
      const batch = mock.method(store, 'addVersions')
      // Deliberately violate the generator's static type to exercise API boundary validation.
      generate.mock.mockImplementationOnce(async () => output as unknown as TailoredResult)
      const response = await request(app).post('/api/versions').send(input(base.id)).expect(502)
      assert.deepEqual(response.body, { error: 'The model returned an incomplete language pair. Nothing was saved. Please try again.' })
      assert.equal(batch.mock.callCount(), 0)
      assert.deepEqual(store.versions(), [existing])
      assert.deepEqual(store.base(), base)
      const retried = await createVersion(base.id)
      assert.deepEqual(store.versions(), [retried, existing])
    })
  }

  it('rolls back the primary when inserting its English counterpart fails and allows a subsequent request', async () => {
    const base = await importBase()
    const existing = await createVersion(base.id)
    const log = mock.method(console, 'error', () => {})
    // Force the second insert to fail inside the real SQLite transaction.
    store.db.exec(`CREATE TRIGGER reject_english BEFORE INSERT ON versions
      WHEN json_extract(NEW.document, '$.language.code') = 'en'
      BEGIN SELECT RAISE(ABORT, 'test-only English insert failure'); END;`)
    generate.mock.mockImplementation(async () => structuredClone(bilingual))
    const response = await request(app).post('/api/versions').send(input(base.id)).expect(500)
    assert.deepEqual(response.body, { error: 'Something went wrong on the local server. Please try again.' })
    assert.deepEqual(store.versions(), [existing])
    assert.deepEqual(store.base(), base)
    assert.deepEqual(log.mock.calls[0].arguments, ['Request failed:', 'Error'])
    store.db.exec('DROP TRIGGER reject_english')
    const retried = await request(app).post('/api/versions').send(input(base.id)).expect(201)
    const { additionalVersions, ...primary } = retried.body
    assert.deepEqual(store.versions(), [additionalVersions[0], primary, existing])
  })

  it('hides unexpected generation errors and saves nothing', async () => {
    const base = await importBase()
    const log = mock.method(console, 'error', () => {})
    generate.mock.mockImplementationOnce(async () => { throw new Error('private resume and secret key') })
    const response = await request(app).post('/api/versions').send(input(base.id)).expect(500)
    assert.deepEqual(response.body, { error: 'Something went wrong on the local server. Please try again.' })
    assert.deepEqual(store.versions(), [])
    assert.deepEqual(log.mock.calls[0].arguments, ['Request failed:', 'Error'])
    await createVersion(base.id)
  })

  it('rejects overlapping generation and saves just the completed request', { timeout: 10000 }, async () => {
    const base = await importBase()
    let release!: (result: TailoredResult) => void
    let entered!: () => void
    const pending = new Promise<TailoredResult>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    generate.mock.mockImplementationOnce(async () => { entered(); return pending })
    const first = request(app).post('/api/versions').send(input(base.id)).then(response => response)
    try {
      await started
      const second = await request(app).post('/api/versions').send({ ...input(base.id), documentType: 'cover-letter' }).expect(409)
      assert.match(second.body.error, /Another document is being generated/)
      assert.equal(generate.mock.callCount(), 1)
      assert.deepEqual(store.versions(), [])
    } finally {
      release(structuredClone(tailored))
      await first
    }
    const response = await first
    assert.equal(response.status, 201)
    assert.deepEqual(store.versions(), [response.body])
    await createVersion(base.id)
  })

  it('store lookups and mutations safely handle missing and SQL-like identifiers', () => {
    for (const id of [missingId, "' OR 1=1 --"]) {
      assert.equal(store.base(id), null)
      assert.equal(store.version(id), null)
      assert.equal(store.pdf(id), undefined)
      assert.equal(store.updateBase(id, baseText), null)
      assert.equal(store.updateVersion(id, { role: 'Engineer', company: 'Co', text: baseText, status: 'draft' }), null)
      assert.equal(store.deleteVersion(id), false)
    }
    assert.deepEqual(store.versions(), [])
  })

  it('store enforces version/base foreign keys and returns detached documents', async () => {
    const base = await importBase()
    const version = await createVersion(base.id)
    const { id: _id, createdAt: _created, updatedAt: _updated, status: _status, ...orphan } = version
    assert.throws(() => store.addVersion({ ...orphan, baseId: missingId }), /FOREIGN KEY constraint failed/)
    const fetched = store.version(version.id)!
    fetched.keywords.push('invented')
    fetched.text = 'mutated outside store'
    store.base(base.id)!.text = 'mutated outside store'
    assert.deepEqual(store.version(version.id), version)
    assert.deepEqual(store.base(base.id), base)
    assert.deepEqual(store.versions(), [version])
  })
})

describe('PDF export', () => {
  it('returns a readable PDF for blank lines, headings, and a multipage resume', async () => {
    const text = `Alex Example\n\nEXPERIENCE\n${Array.from({ length: 160 }, (_, i) => `Project ${i + 1}: Maintained TypeScript services and wrote tests.`).join('\n')}\nFINAL SECTION\nEnd of resume.`
    const pdf = await exportPdf(text, 'Engineer — Example Co')
    const parsed = await readPdf(pdf)
    assert.ok(parsed.total > 1)
    assert.match(parsed.text, /Alex Example/)
    assert.match(parsed.text, /EXPERIENCE/)
    assert.match(parsed.text, /Project 160/)
    assert.match(parsed.text, /End of resume\./)
  })
})