import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import request from 'supertest'
import { AppError, generateResume, generationSchema, requestModel } from './ai.ts'
import { cleanResume } from './clean-resume.ts'
import { translateDocument } from './translation.ts'
import { createApp } from './app.ts'
import { lmStudioDisplayModels, lmStudioResolveModel } from './lmstudio.ts'
import { authenticatedRequest, createTestStore } from './test-support.ts'

const text = 'Alex Example\nalex@example.test\nEXPERIENCE\nMaintained TypeScript services and wrote automated tests in 2024 with an engineering team.'
const chinese = 'Alex Example\nalex@example.test\n工作经历\n2024 年与工程团队合作维护 TypeScript 服务并编写自动化测试。'
const input = { baseId: '00000000-0000-4000-8000-000000000001', provider: 'lmstudio' as const, model: 'google/gemma-4-e4b', role: 'Engineer', company: 'Example', jobDescription: text }
const result = { language: { code: 'en', name: 'English' }, resumeText: text, summary: 'Synthetic result', keywords: [], gaps: [], englishVersion: null }

describe('LM Studio resume provider', { concurrency: false }, () => {
  let originalKey: string | undefined
  beforeEach(() => { originalKey = process.env.LMSTUDIO_API_KEY; delete process.env.LMSTUDIO_API_KEY })
  afterEach(() => {
    mock.restoreAll()
    if (originalKey === undefined) delete process.env.LMSTUDIO_API_KEY
    else process.env.LMSTUDIO_API_KEY = originalKey
  })
  it('supports all document workflows with local structured output and no cloud consent or key', async () => {
    assert.equal(generationSchema.parse(input).provider, 'lmstudio')
    const fetcher = mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      const properties = body.response_format.json_schema.schema.properties
      const output = properties.englishText ? { englishText: text, chineseText: chinese } : properties.text ? { text } : result
      return Response.json({ choices: [{ message: { content: JSON.stringify(output) } }] })
    })
    await generateResume({ ...input, apiKey: 'unrelated-openai-key' }, text)
    await generateResume({ ...input, documentType: 'cover-letter' }, text)
    await cleanResume(input, text)
    await translateDocument({ ...input, sourceType: 'base', sourceId: input.baseId, targetLanguage: 'en' }, text)
    assert.equal(fetcher.mock.callCount(), 4)
    for (const call of fetcher.mock.calls) {
      const [url, init] = call.arguments
      assert.equal(url, 'http://127.0.0.1:1234/v1/chat/completions')
      assert.equal(init?.redirect, 'error')
      assert.ok(init?.signal)
      assert.equal(new Headers(init?.headers).has('Authorization'), false)
      assert.equal(String(init?.body).includes('unrelated-openai-key'), false)
      const body = JSON.parse(String(init?.body))
      assert.equal(body.model, 'gemma3:4b')
      assert.equal(body.stream, false)
      assert.equal(body.response_format.type, 'json_schema')
      assert.equal(body.response_format.json_schema.strict, true)
      assert.equal(JSON.stringify(body.response_format.json_schema.schema).includes('"pattern"'), false)
    }
  })
  it('resolves and displays the Gemma compatibility alias', () => {
    assert.equal(lmStudioResolveModel('google/gemma-4-e4b'), 'gemma3:4b')
    assert.equal(lmStudioResolveModel('fictional-chat'), 'fictional-chat')
    assert.deepEqual(lmStudioDisplayModels([' gemma3:4b ', 'gemma3:4b', 'other']), ['google/gemma-4-e4b', 'gemma3:4b', 'other'])
  })
  it('omits unsupported grammar patterns but still validates language content before accepting output', async () => {
    const fetcher = mock.method(globalThis, 'fetch', async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ choices: [{ message: { content: JSON.stringify({ englishText: text, chineseText: `${text}\nNot Chinese.` }) } }] }))
    await assert.rejects(cleanResume(input, text), /Neither draft was saved/)
    const schema = JSON.parse(String(fetcher.mock.calls[0].arguments[1]?.body)).response_format.json_schema.schema
    assert.deepEqual(schema.required, ['englishText', 'chineseText'])
    assert.equal(schema.properties.englishText.minLength, 50)
    assert.equal(schema.properties.englishText.maxLength, 50000)
    assert.equal(schema.properties.englishText.pattern, undefined)
  })
  it('uses only the optional LM Studio server token, never the OpenAI key', async () => {
    process.env.LMSTUDIO_API_KEY = 'synthetic-local-token'
    const fetcher = mock.method(globalThis, 'fetch', async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ choices: [{ message: { content: '{}' } }] }))
    await requestModel({ ...input, apiKey: 'synthetic-openai-key' }, [], {}, { consentMessage: 'not needed', invalidMessage: 'invalid' })
    assert.equal(new Headers(fetcher.mock.calls[0].arguments[1]?.headers).get('Authorization'), 'Bearer synthetic-local-token')
  })
  it('fails safely without cloud fallback for provider, network, timeout and invalid output errors', async () => {
    const fetcher = mock.method(globalThis, 'fetch', async (): Promise<Response> => { throw new Error('private provider error') })
    await assert.rejects(cleanResume(input, text), /Cannot reach LM Studio/)
    fetcher.mock.mockImplementation(async () => { throw new DOMException('private timeout', 'TimeoutError') })
    await assert.rejects(cleanResume(input, text), /timed out/)
    for (const [status, expected] of [[401, /LMSTUDIO_API_KEY/], [404, /LM Studio model not found/], [500, /AI provider returned an error/]] as const) {
      fetcher.mock.mockImplementation(async () => new Response('private details', { status }))
      await assert.rejects(cleanResume(input, text), expected)
    }
    fetcher.mock.mockImplementation(async () => Response.json({ choices: [{ message: { content: 'not JSON' } }] }))
    await assert.rejects(cleanResume(input, text), (error: unknown) => error instanceof AppError && error.status === 502 && !error.message.includes('private'))
    assert.equal(fetcher.mock.callCount(), 6)
  })
  it('lists local models with authentication even when web chat is disabled', async () => {
    const store = createTestStore(':memory:')
    try {
      store.setFeature('webChat', false)
      const app = createApp(store)
      const fetcher = mock.method(globalThis, 'fetch', async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ data: [{ id: input.model }] }))
      await request(app).get('/api/lmstudio/models').expect(401)
      assert.equal(fetcher.mock.callCount(), 0)
      const response = await authenticatedRequest(app).get('/api/lmstudio/models').expect(200)
      assert.deepEqual(response.body, { models: [input.model] })
      assert.equal(fetcher.mock.calls[0].arguments[0], 'http://127.0.0.1:1234/v1/models')
    } finally { store.db.close() }
  })
})