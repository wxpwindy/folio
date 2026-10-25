import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import rawRequest from 'supertest'
import PDFDocument from 'pdfkit'
import { createApp } from './app.ts'
import { authenticatedRequest, createTestStore } from './test-support.ts'

const jd = 'We need a software engineer to build TypeScript services, write automated tests and collaborate with the engineering team.'
async function pdf(text = jd, pages = 1) {
  const doc = new PDFDocument()
  const chunks: Buffer[] = []
  const result = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', chunk => chunks.push(Buffer.from(chunk)))
    doc.on('error', reject)
    doc.on('end', () => resolve(Buffer.concat(chunks)))
  })
  doc.text(text)
  for (let page = 1; page < pages; page++) doc.addPage().text(text)
  doc.end()
  return result
}

describe('local JD extraction and Ollama discovery', () => {
  let store: ReturnType<typeof createTestStore>
  let app: ReturnType<typeof createApp>
  const previousUrl = process.env.OLLAMA_URL
  beforeEach(() => { store = createTestStore(':memory:'); app = createApp(store); delete process.env.OLLAMA_URL })
  afterEach(() => {
    store.db.close(); mock.restoreAll()
    if (previousUrl === undefined) delete process.env.OLLAMA_URL
    else process.env.OLLAMA_URL = previousUrl
  })
  const upload = (file: Buffer, filename: string) => authenticatedRequest(app).post('/api/job-description/extract').attach('document', file, filename)

  it('extracts a real PDF locally without saving data or calling AI', async () => {
    const fetch = mock.method(globalThis, 'fetch', async () => { throw new Error('No provider request allowed') })
    const response = await upload(await pdf(), 'job.pdf').expect(200)
    assert.equal(response.body.text.replace(/\s+/g, ' '), jd)
    assert.equal(store.base(), null)
    assert.deepEqual(store.versions(), [])
    assert.equal(fetch.mock.callCount(), 0)
    assert.equal(response.headers['cache-control'], 'no-store')
  })
  it('extracts UTF-8 with BOM and keeps short text editable', async () => {
    const response = await upload(Buffer.from('\uFEFF  招聘软件工程师\nTypeScript  '), 'JOB.TXT').expect(200)
    assert.equal(response.body.text, '招聘软件工程师\nTypeScript')
  })
  it('rejects unsupported, empty, binary, invalid UTF-8 and damaged documents', async () => {
    for (const [buffer, filename] of [
      [Buffer.from(jd), 'job.docx'], [Buffer.from('   '), 'job.txt'],
      [Buffer.from([0xff, 0xfe]), 'job.txt'], [Buffer.from('binary\x00text'), 'job.txt'],
      [Buffer.from('not a pdf'), 'job.pdf'], [Buffer.from('%PDF-damaged'), 'job.pdf'],
      [await pdf(''), 'scan.pdf'],
    ] as const) await upload(buffer, filename).expect(400)
  })
  it('enforces length, page, file size, field and count limits', async () => {
    await upload(Buffer.from('x'.repeat(30000)), 'job.txt').expect(200)
    await upload(Buffer.from('x'.repeat(30001)), 'job.txt').expect(400)
    await upload(await pdf('Page', 31), 'job.pdf').expect(400)
    await upload(Buffer.alloc(10 * 1024 * 1024 + 1, 65), 'job.txt').expect(400)
    await authenticatedRequest(app).post('/api/job-description/extract').expect(400)
    await authenticatedRequest(app).post('/api/job-description/extract').attach('resume', Buffer.from(jd), 'job.txt').expect(400)
    await upload(Buffer.from(jd), 'job.txt').attach('document', Buffer.from(jd), 'second.txt').expect(400)
  })
  it('requires authentication and mutation protection before extraction', async () => {
    await rawRequest(app).post('/api/job-description/extract').set('X-Folio-Request', '1').attach('document', Buffer.from(jd), 'job.txt').expect(401)
    await authenticatedRequest(app).post('/api/job-description/extract').unset('X-Folio-Request').attach('document', Buffer.from(jd), 'job.txt').expect(403)
    await authenticatedRequest(app).post('/api/job-description/extract').set('Origin', 'https://foreign.example').attach('document', Buffer.from(jd), 'job.txt').expect(403)
    await rawRequest(app).get('/api/ollama/models').expect(401)
  })
  it('lists installed models with a bounded local-only request', async () => {
    const fetch = mock.method(globalThis, 'fetch', async () => Response.json({ models: [{ name: 'gemma4:latest' }, { name: null }] }))
    const response = await authenticatedRequest(app).get('/api/ollama/models').expect(200)
    assert.deepEqual(response.body, { models: ['gemma4:latest'] })
    const call = fetch.mock.calls[0]!
    assert.equal(String(call.arguments[0]), 'http://127.0.0.1:11434/api/tags')
    assert.equal(call.arguments[1]?.redirect, 'error')
    assert.ok(call.arguments[1]?.signal)
  })
  it('reports connection failures safely and refuses remote URLs', async () => {
    const fetch = mock.method(globalThis, 'fetch', async () => { throw new Error('PRIVATE_ERROR') })
    const response = await authenticatedRequest(app).get('/api/ollama/models').expect(502)
    assert.match(response.body.error, /Open the Ollama app/)
    assert.doesNotMatch(response.body.error, /PRIVATE_ERROR/)
    for (const url of ['https://remote.example', 'http://192.168.1.1:11434', 'ftp://localhost']) {
      process.env.OLLAMA_URL = url
      await authenticatedRequest(app).get('/api/ollama/models').expect(400)
    }
    assert.equal(fetch.mock.callCount(), 1)
  })
})