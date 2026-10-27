import assert from 'node:assert/strict'
import https from 'node:https'
import dns from 'node:dns/promises'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import request from 'supertest'
import { createApp } from './app.ts'
import type { GenerationInput, TailoredResult } from './ai.ts'
import type { CleanResumeInput } from './clean-resume.ts'
import type { TranslationInput } from './translation.ts'
import type { Store } from './store.ts'
import { authenticatedRequest, createTestStore } from './test-support.ts'

const text = 'Alex Example\nMaintained TypeScript services and wrote automated tests with a small engineering team.'
const result: TailoredResult = {
  resumeText: text, summary: '', keywords: [], gaps: [],
  language: { code: 'en', name: 'English' }, englishVersion: null,
}
const settings = {
  provider: 'byok', model: 'custom-model', baseUrl: 'https://provider.example/v1',
  apiKey: 'fictional-client-key', cloudConsent: true,
}

describe('BYOK document API contract and persistence', { concurrency: false }, () => {
  let store: Store
  let baseId: string
  let app: ReturnType<typeof createApp>
  let received: (GenerationInput | CleanResumeInput | TranslationInput)[]
  beforeEach(() => {
    // API tests use injected services. Neither fetch nor native HTTPS/DNS may escape.
    mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected provider fetch') })
    mock.method(https, 'request', () => { throw new Error('Unexpected provider HTTPS') })
    mock.method(dns, 'lookup', async () => { throw new Error('Unexpected provider DNS') })
    store = createTestStore(':memory:')
    baseId = store.addBase({ filename: 'Resume.pdf', text, pages: 1 }, Buffer.from('PDF fixture')).id
    received = []
    app = createApp(store,
      async input => { received.push(input); return result },
      async input => { received.push(input); return { text } },
      undefined, undefined, undefined, undefined, undefined,
      async input => {
        received.push(input)
        return { englishText: text, chineseText: 'Alex Example\n工作经历\n与小型工程团队合作维护 TypeScript 服务并编写自动化测试，保留所有原始工作经历和资格信息。' }
      })
  })
  afterEach(() => { store.db.close(); mock.restoreAll() })

  it('passes transient settings to all document operations but only stores provider/model', async () => {
    const versionInput = { ...settings, baseId, role: 'Engineer', company: 'Example', jobDescription: text }
    const results = []
    for (const documentType of ['resume', 'cover-letter']) {
      results.push((await authenticatedRequest(app).post('/api/versions').send({ ...versionInput, documentType }).expect(201)).body)
    }
    results.push((await authenticatedRequest(app).post('/api/base/clean').send({ ...settings, baseId }).expect(201)).body)
    results.push((await authenticatedRequest(app).post('/api/translations').send({
      ...settings, sourceType: 'base', sourceId: baseId, targetLanguage: 'en',
    }).expect(201)).body)
    assert.equal(received.length, 4)
    for (const input of received) {
      assert.equal(input.provider, 'byok')
      assert.equal(input.baseUrl, settings.baseUrl)
      assert.equal(input.apiKey, settings.apiKey)
      assert.equal(input.cloudConsent, true)
    }
    assert.equal(store.versions().length, 5)
    for (const version of store.versions()) {
      assert.equal(version.provider, 'byok')
      assert.equal(version.model, settings.model)
    }
    const workspace = (await authenticatedRequest(app).get('/api/workspace').expect(200)).body
    const persisted = store.db.prepare('SELECT document FROM versions').all()
    for (const value of [...results, workspace, persisted]) {
      assert.doesNotMatch(JSON.stringify(value), /fictional-client-key|provider\.example|apiKey|baseUrl|cloudConsent/)
    }
  })

  it('retains session, origin, mutation-header and source ownership boundaries before invoking any provider', async () => {
    const body = { ...settings, baseId, role: 'Engineer', company: 'Example', jobDescription: text }
    await request(app).post('/api/versions').set('X-Folio-Request', '1').send(body).expect(401)
    await request(app).post('/api/versions').send(body).expect(403)
    await authenticatedRequest(app).post('/api/versions').set('Origin', 'https://untrusted.example').send(body).expect(403)
    await authenticatedRequest(app).post('/api/versions').set('Host', 'untrusted.example').send(body).expect(403)
    const otherId = '00000000-0000-4000-8000-000000000099'
    store.db.prepare(`INSERT INTO users (id, method, identifier, password_hash, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(otherId, 'email', 'other-byok@example.test', 'disabled-test-password', '2026-01-01T00:00:00.000Z')
    const foreign = store.forUser(otherId).addBase({ filename: 'Other.pdf', text, pages: 1 }, Buffer.from('PDF fixture'))
    await authenticatedRequest(app).post('/api/versions').send({ ...body, baseId: foreign.id }).expect(404)
    await authenticatedRequest(app).post('/api/base/clean').send({ ...settings, baseId: foreign.id }).expect(404)
    await authenticatedRequest(app).post('/api/translations').send({
      ...settings, sourceType: 'base', sourceId: foreign.id, targetLanguage: 'en',
    }).expect(404)
    assert.equal(received.length, 0)
    assert.equal(store.versions().length, 0)
  })
})
