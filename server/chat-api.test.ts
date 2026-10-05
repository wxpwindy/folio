import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import request from 'supertest'
import { AppError } from './ai.ts'
import { createApp } from './app.ts'
import { answerChat, chatService } from './chat.ts'
import type { ChatInput } from './chat.ts'
import { authenticatedRequest, createTestStore } from './test-support.ts'
import type { Store } from './store.ts'

type ChatOutput = Awaited<ReturnType<typeof answerChat>>
const input: ChatInput = { model: 'fictional-chat', messages: [{ role: 'user', content: 'PRIVATE fictional conversation' }], webSearch: false, searchConsent: false }
const searched: ChatInput = { ...input, webSearch: true, searchConsent: true }
const generatedQuery = 'synthetic query'
const output: ChatOutput = { content: 'Fictional local answer.', model: input.model, sources: [], searchQuery: null }
const source = { title: 'Synthetic source', url: 'https://source.example.test/', snippet: 'Synthetic evidence' }
const baseText = 'Alex Example\nFictional engineer with experience writing TypeScript services and synthetic automated tests.'
const wrongUser = '00000000-0000-4000-8000-000000000099'
const pdf = Buffer.from('%PDF-synthetic-original')
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function fakeChat() {
  return {
    models: mock.fn(async (_signal?: AbortSignal) => ({ models: ['fictional-chat'], searchProvider: 'DuckDuckGo' as const })),
    answer: mock.fn(async (_input: ChatInput, _signal?: AbortSignal): Promise<ChatOutput> => structuredClone(output)),
  }
}

describe('protected ephemeral chat API (memory DB only)', { concurrency: false }, () => {
  let store: Store
  let app: ReturnType<typeof createApp>
  let chat: ReturnType<typeof fakeChat>
  let network: ReturnType<typeof stubFetch>
  let generate: ReturnType<typeof forbiddenDocumentService>
  let translate: ReturnType<typeof forbiddenDocumentService>
  let documentsBefore: ReturnType<typeof documents>
  let schemaBefore: unknown
  let allowMockedFetch: boolean
  const envNames = ['LMSTUDIO_API_KEY', 'BRAVE_SEARCH_API_KEY'] as const
  let env: Record<string, string | undefined>
  function stubFetch() {
    return mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected fetch: no live providers allowed') })
  }
  function forbiddenDocumentService() {
    return mock.fn(async (): Promise<never> => { throw new Error('Chat must not call a document generator') })
  }
  function documents() {
    return {
      bases: store.db.prepare('SELECT * FROM bases ORDER BY id').all(),
      versions: store.db.prepare('SELECT * FROM versions ORDER BY id').all(),
    }
  }
  function databaseSnapshot() {
    return ['users', 'sessions', 'account_setup', 'bases', 'versions'].map(table => store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
  }
  const client = () => authenticatedRequest(app)
  const post = (body: unknown = input) => client().post('/api/chat').type('json').send(JSON.stringify(body))
  beforeEach(() => {
    env = Object.fromEntries(envNames.map(name => [name, process.env[name]]))
    for (const name of envNames) delete process.env[name]
    network = stubFetch()
    allowMockedFetch = false
    store = createTestStore(':memory:')
    const base = store.addBase({ filename: 'synthetic.pdf', text: baseText, pages: 1 }, pdf)
    store.addVersion({ baseId: base.id, baseText, text: baseText, role: 'Engineer', company: 'Example', jobDescription: 'Fictional job',
      summary: 'Synthetic snapshot', keywords: [], gaps: [], provider: 'ollama', model: 'fictional-resume' })
    documentsBefore = documents()
    schemaBefore = store.db.prepare('SELECT * FROM sqlite_master ORDER BY name').all()
    chat = fakeChat()
    generate = forbiddenDocumentService()
    translate = forbiddenDocumentService()
    app = createApp(store, generate, translate, undefined, chat)
  })
  afterEach(() => {
    try {
      if (!allowMockedFetch) assert.equal(network.mock.callCount(), 0, 'injected API tests must not invoke fetch')
      assert.equal(generate.mock.callCount(), 0)
      assert.equal(translate.mock.callCount(), 0)
      assert.deepEqual(documents(), documentsBefore, 'chat must never alter documents or original PDF bytes')
      assert.deepEqual(store.db.prepare('SELECT * FROM sqlite_master ORDER BY name').all(), schemaBefore, 'chat must not create persistence tables')
    } finally {
      store.db.close()
      mock.restoreAll()
      for (const name of envNames) {
        if (env[name] === undefined) delete process.env[name]
        else process.env[name] = env[name]
      }
    }
  })

  it('requires a real session for model lists and completions, regardless of claimed identity', async () => {
    for (const cookie of [undefined, 'folio_session=fictional-invalid-token']) {
      const anonymous = request.agent(app).set('X-Folio-Request', '1').set('X-Folio-User', wrongUser)
      if (cookie) anonymous.set('Cookie', cookie)
      await anonymous.get('/api/chat/models').expect(401)
      await anonymous.post('/api/chat').send(input).expect(401)
    }
    assert.equal(chat.models.mock.callCount(), 0)
    assert.equal(chat.answer.mock.callCount(), 0)
  })

  for (const condition of ['expired', 'revoked', 'disabled', 'password replacement'] as const) {
    it(`rejects ${condition} sessions before reaching either chat service`, async () => {
      if (condition === 'expired') store.db.exec('UPDATE sessions SET expires_at = 0')
      if (condition === 'revoked') store.db.exec('DELETE FROM sessions')
      if (condition === 'disabled') store.db.exec('UPDATE users SET disabled = 1')
      if (condition === 'password replacement') store.db.exec('UPDATE users SET must_change_password = 1')
      const status = condition === 'password replacement' ? 403 : 401
      await client().get('/api/chat/models').expect(status)
      await post().expect(status)
      assert.equal(chat.models.mock.callCount(), 0)
      assert.equal(chat.answer.mock.callCount(), 0)
    })
  }

  it('enforces mutation protection plus Host/Origin guards on both endpoints', async () => {
    for (const value of ['', '0', 'true']) await client().post('/api/chat').set('X-Folio-Request', value).send(input).expect(403)
    await client().post('/api/chat').unset('X-Folio-Request').send(input).expect(403)
    for (const [header, value] of [['Host', 'untrusted.example'], ['Host', 'localhost.untrusted.example'], ['Origin', 'https://untrusted.example'], ['Origin', 'null']]) {
      await client().get('/api/chat/models').set(header, value).expect(403)
      await client().post('/api/chat').set(header, value).send(input).expect(403)
    }
    assert.equal(chat.models.mock.callCount(), 0)
    assert.equal(chat.answer.mock.callCount(), 0)
    await client().get('/api/chat/models').unset('X-Folio-Request').expect(200)
  })

  it('rejects stale-tab, empty and duplicate expected-user headers without revoking the valid session', async () => {
    const userId = String(store.db.prepare('SELECT id FROM users').get()!.id)
    const before = databaseSnapshot()
    for (const expected of [wrongUser, '', `${userId}, ${userId}`]) {
      const list = await client().get('/api/chat/models').set('X-Folio-User', expected).expect(401)
      const answer = await client().post('/api/chat').set('X-Folio-User', expected).send(input).expect(401)
      assert.match(list.body.error, /account session changed/)
      assert.deepEqual(answer.body, list.body)
    }
    assert.equal(chat.models.mock.callCount(), 0)
    assert.equal(chat.answer.mock.callCount(), 0)
    await client().get('/api/chat/models').set('X-Folio-User', userId).expect(200)
    await client().post('/api/chat').set('X-Folio-User', userId).send(input).expect(200)
    assert.deepEqual(databaseSnapshot(), before)
  })

  it('returns security/no-store headers and passes normalized input plus a live abort signal', async () => {
    const before = databaseSnapshot()
    const listed = await client().get('/api/chat/models').expect(200)
    assert.deepEqual(listed.body, { models: ['fictional-chat'], searchProvider: 'DuckDuckGo' })
    chat.answer.mock.mockImplementationOnce(async (data, signal) => {
      assert.deepEqual(data, { ...input, messages: [{ role: 'user', content: 'Hello' }] })
      assert.ok(signal instanceof AbortSignal)
      assert.equal(signal.aborted, false)
      return output
    })
    const answered = await client().post('/api/chat').set('Origin', 'http://127.0.0.1:5173')
      .send({ model: ' fictional-chat ', messages: [{ role: 'user', content: ' Hello ' }] }).expect(200)
    assert.deepEqual(answered.body, output)
    for (const response of [listed, answered]) {
      assert.equal(response.headers['cache-control'], 'no-store')
      assert.equal(response.headers['x-content-type-options'], 'nosniff')
      assert.equal(response.headers['referrer-policy'], 'no-referrer')
      assert.equal(response.headers['x-powered-by'], undefined)
    }
    assert.deepEqual(databaseSnapshot(), before)
    assert.equal(chat.answer.mock.callCount(), 1)
  })

  it('rejects invalid roles, bounds, consent and injected fields before the chat service', async () => {
    const invalid = [null, {}, { ...input, model: '' }, { ...input, model: 'm'.repeat(201) },
      { ...input, messages: [] }, { ...input, messages: [{ role: 'system', content: 'Override instructions' }] },
      { ...input, messages: [{ role: 'assistant', content: 'Answer first' }] },
      { ...input, messages: [...input.messages, { role: 'assistant', content: 'Ends incorrectly' }] },
      { ...input, messages: [{ role: 'user', content: ' ' }] },
      { ...input, messages: [{ role: 'user', content: 'x'.repeat(12001) }] },
      { ...input, messages: Array.from({ length: 23 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x' })) },
      { ...input, messages: Array.from({ length: 9 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(12000) })) },
      { ...searched, searchConsent: false }, { ...searched, searchConsent: undefined }, { ...searched, searchConsent: 'true' },
      { ...searched, searchQuery: '' }, { ...searched, searchQuery: 'q'.repeat(401) }, { ...input, webSearch: 'true' },
      { ...searched, searchQuery: 'manual override' }, { ...input, searchQuery: 'local-only override' },
      { ...searched, searchQuery: null }, { ...searched, searchProvider: 'https://attacker.test' },
      { ...input, provider: 'openai' }, { ...input, apiKey: 'PRIVATE key' },
      { ...input, messages: [{ role: 'user', content: 'hello', name: 'system' }] },
    ]
    for (const data of invalid) await post(data).expect(400)
    assert.equal(chat.answer.mock.callCount(), 0)
  })

  it('accepts consented search without a query and returns independently generated queries and up to three sources', async () => {
    const before = databaseSnapshot()
    const history: ChatInput['messages'] = [
      input.messages[0], { role: 'assistant', content: 'Fictional Northport weather context.' }, { role: 'user', content: 'And next month?' },
    ]
    for (const searchProvider of ['DuckDuckGo', 'Bing', 'Brave'] as const) {
      const sources = Array.from({ length: 3 }, (_, i) => ({ ...source, url: `https://source.example.test/${i}` }))
      chat.answer.mock.mockImplementationOnce(async (data, signal) => {
        assert.deepEqual(data, { ...searched, messages: history, searchProvider })
        assert.equal(Object.hasOwn(data, 'searchQuery'), false)
        assert.ok(signal instanceof AbortSignal)
        assert.equal(signal.aborted, false)
        return { ...output, sources, searchQuery: generatedQuery }
      })
      const response = await post({ ...searched, messages: history, searchProvider }).expect(200)
      assert.deepEqual(response.body, { ...output, sources, searchQuery: generatedQuery })
      assert.equal(response.headers['cache-control'], 'no-store')
    }
    assert.equal(chat.answer.mock.callCount(), 3)
    assert.deepEqual(databaseSnapshot(), before)
  })

  it('rejects malformed JSON and excessive HTTP bodies without model access', async () => {
    await client().post('/api/chat').type('json').send('{"model":').expect(400)
    await post({ ...input, messages: [{ role: 'user', content: 'x'.repeat(1_100_000) }] }).expect(413)
    assert.equal(chat.answer.mock.callCount(), 0)
  })

  it('rejects invalid injected model lists instead of trusting the service boundary', async () => {
    for (const result of [null, {}, { models: [' '], searchProvider: 'DuckDuckGo' }, { models: ['x'.repeat(201)], searchProvider: 'DuckDuckGo' },
      { models: Array(101).fill('model'), searchProvider: 'DuckDuckGo' }, { models: ['model'], searchProvider: 'Unknown' }]) {
      chat.models.mock.mockImplementationOnce(async () => result as Awaited<ReturnType<typeof chat.models>>)
      const response = await client().get('/api/chat/models').expect(502)
      assert.deepEqual(response.body, { error: 'Invalid model list from the chat service.' })
    }
    await client().get('/api/chat/models').expect(200)
  })

  it('rejects invalid injected answers, source URLs and bounds, then releases capacity for retries', async () => {
    const invalid = [null, {}, { ...output, content: ' ' }, { ...output, content: 'x'.repeat(12001) },
      { ...output, model: '' }, { ...output, model: 'm'.repeat(201) }, { ...output, searchQuery: 'q'.repeat(401) },
      { ...output, sources: Array(4).fill(source) }, { ...output, searchQuery: ' \n ' }, { ...output, sources: [{ ...source, title: '' }] },
      { ...output, sources: [{ ...source, title: 't'.repeat(301) }] }, { ...output, sources: [{ ...source, snippet: 's'.repeat(1501) }] },
      ...['javascript:alert(1)', 'file:///tmp/test', 'http://127.0.0.1:3001', 'http://[::1]', 'https://user:pass@example.test', `https://example.test/${'x'.repeat(2000)}`]
        .map(url => ({ ...output, sources: [{ ...source, url }] })),
    ]
    for (const result of invalid) {
      chat.answer.mock.mockImplementationOnce(async () => result as ChatOutput)
      const response = await post().expect(502)
      assert.deepEqual(response.body, { error: 'Invalid response from the chat service.' })
    }
    assert.deepEqual((await post().expect(200)).body, output)
  })

  it('strips extra service metadata and persists neither conversation, search evidence nor answers', async () => {
    const before = databaseSnapshot()
    const info = mock.method(console, 'log', () => {})
    const errors = mock.method(console, 'error', () => {})
    chat.answer.mock.mockImplementationOnce(async () => ({ ...output, sources: [{ ...source, apiKey: 'PRIVATE source key' }], searchQuery: generatedQuery,
      messages: input.messages, apiKey: 'PRIVATE response key', document: baseText }))
    const response = await post(searched).expect(200)
    assert.deepEqual(response.body, { ...output, sources: [source], searchQuery: generatedQuery })
    assert.deepEqual(chat.answer.mock.calls[0].arguments[0], searched)
    assert.deepEqual(databaseSnapshot(), before)
    await client().get('/api/chat/history').expect(404)
    await client().get('/api/chat').expect(404)
    app = createApp(store, generate, translate, undefined, chat)
    await post().expect(200)
    assert.deepEqual(chat.answer.mock.calls[1].arguments[0], input, 'only caller-supplied history reaches the service')
    assert.deepEqual(databaseSnapshot(), before)
    assert.equal(info.mock.callCount(), 0)
    assert.equal(errors.mock.callCount(), 0)
  })

  it('preserves safe provider statuses, sanitizes unexpected errors and frees capacity after rejection', async () => {
    const errors = mock.method(console, 'error', () => {})
    const before = databaseSnapshot()
    for (const status of [499, 502, 504]) {
      chat.answer.mock.mockImplementationOnce(async () => { throw new AppError(status, 'Synthetic safe provider failure') })
      assert.deepEqual((await post().expect(status)).body, { error: 'Synthetic safe provider failure' })
      chat.models.mock.mockImplementationOnce(async () => { throw new AppError(status, 'Synthetic safe provider failure') })
      await client().get('/api/chat/models').expect(status)
    }
    for (const service of [chat.answer, chat.models]) {
      service.mock.mockImplementationOnce(async () => { throw new Error('PRIVATE conversation provider response key') })
    }
    for (const response of [await post().expect(500), await client().get('/api/chat/models').expect(500)]) {
      assert.doesNotMatch(JSON.stringify(response.body), /PRIVATE|conversation|key/)
      assert.match(response.body.error, /Something went wrong on the local server/)
    }
    assert.equal(errors.mock.callCount(), 2)
    for (const call of errors.mock.calls) assert.deepEqual(call.arguments, ['Request failed:', 'Error'])
    await post().expect(200)
    assert.deepEqual(databaseSnapshot(), before)
  })

  it('allows two pending answers, rejects a third, and restores capacity after success/failure', { timeout: 10000 }, async () => {
    const entered = deferred<void>()
    const finish = deferred<void>()
    let count = 0
    chat.answer.mock.mockImplementation(async (_data, signal) => {
      const order = ++count
      assert.ok(signal instanceof AbortSignal)
      assert.equal(signal.aborted, false)
      if (count === 2) entered.resolve()
      await finish.promise
      if (order === 1) throw new AppError(502, 'Synthetic first request failure')
      return output
    })
    const first = post().timeout(5000).then(response => response)
    const second = post().timeout(5000).then(response => response)
    try {
      await entered.promise
      const busy = await post().expect(409)
      assert.match(busy.body.error, /local chat model is busy/)
      assert.equal(chat.answer.mock.callCount(), 2)
      await client().get('/api/chat/models').expect(200)
    } finally {
      finish.resolve()
      const responses = await Promise.all([first, second])
      assert.deepEqual(responses.map(response => response.status).sort(), [200, 502])
    }
    chat.answer.mock.mockImplementation(async () => output)
    await post().expect(200)
    await post().expect(200)
  })

  it('shares a 30-request chat rate budget across model listing/completion without affecting workspace reads', async () => {
    for (let i = 0; i < 30; i++) {
      if (i % 2) await post().expect(200)
      else await client().get('/api/chat/models').expect(200)
    }
    const limited = await post().expect(429)
    assert.deepEqual(limited.body, { error: 'Too many chat requests. Wait a minute and retry.' })
    assert.ok(limited.headers['retry-after'])
    assert.ok(limited.headers.ratelimit)
    await client().get('/api/chat/models').expect(429)
    assert.equal(chat.models.mock.callCount(), 15)
    assert.equal(chat.answer.mock.callCount(), 15)
    await client().get('/api/workspace').expect(200)
  })

  it('real adapter planner failures return safe errors without internet, synthesis, persistence or leaked capacity', async () => {
    allowMockedFetch = true
    app = createApp(store, generate, translate, undefined, chatService)
    const before = databaseSnapshot()
    const responses = [
      () => Response.json({ choices: [{ message: { content: JSON.stringify({ query: ' ' }) } }] }),
      () => Response.json({ choices: [{ message: { content: JSON.stringify({ query: 'q'.repeat(401) }) } }] }),
      () => Response.json({ choices: [{ message: { content: 'PRIVATE malformed plan' } }] }),
      () => new Response('PRIVATE provider response', { status: 503 }),
    ]
    for (const response of responses) {
      const callsBefore = network.mock.callCount()
      network.mock.mockImplementationOnce(async () => response())
      const failed = await post(searched).expect(502)
      assert.match(failed.body.error, /LM Studio (could not produce a valid search query|returned HTTP 503)/)
      assert.doesNotMatch(JSON.stringify(failed.body), /PRIVATE|Alex Example|Fictional job/)
      assert.equal(network.mock.callCount(), callsBefore + 1)
      const [url, options] = network.mock.calls.at(-1)!.arguments
      assert.equal(url, 'http://127.0.0.1:1234/v1/chat/completions')
      assert.equal(JSON.parse(String(options?.body)).response_format.type, 'json_schema')
    }
    network.mock.mockImplementationOnce(async () => Response.json({ choices: [{ message: { content: output.content } }] }))
    assert.deepEqual((await post(input).expect(200)).body, output)
    assert.equal(network.mock.callCount(), responses.length + 1)
    assert.deepEqual(databaseSnapshot(), before)
  })

  it('integrates the real adapter with mocked fetch, enforcing per-turn consent and no persistence', async () => {
    allowMockedFetch = true
    app = createApp(store, generate, translate, undefined, chatService)
    const before = databaseSnapshot()
    await post({ ...searched, searchConsent: false }).expect(400)
    await post({ ...searched, searchQuery: 'manual override' }).expect(400)
    assert.equal(network.mock.callCount(), 0)
    network.mock.mockImplementation(async (url, options) => {
      const value = String(url)
      if (value === 'http://127.0.0.1:1234/v1/models') return Response.json({ data: [{ id: input.model }] })
      if (value.startsWith('https://html.duckduckgo.com/html/?')) {
        assert.deepEqual([...new URL(value).searchParams], [['q', generatedQuery]])
        assert.equal(options?.body, undefined)
        assert.doesNotMatch(JSON.stringify([url, options]), /PRIVATE|Alex Example/)
        return new Response(`<div class="result"><a class="result__a" href="${source.url}">${source.title}</a><span class="result__snippet">${source.snippet}</span></div>`)
      }
      assert.equal(value, 'http://127.0.0.1:1234/v1/chat/completions')
      assert.doesNotMatch(String(options?.body), /Alex Example|Fictional job/)
      const body = JSON.parse(String(options?.body))
      if (body.response_format) {
        assert.equal(body.response_format.type, 'json_schema')
        assert.deepEqual(JSON.parse(body.messages[1].content), { conversation: input.messages })
        return Response.json({ choices: [{ message: { content: JSON.stringify({ query: generatedQuery }) } }] })
      }
      return Response.json({ choices: [{ message: { content: output.content } }] })
    })
    await client().get('/api/chat/models').expect(200)
    assert.deepEqual((await post(searched).expect(200)).body, { ...output, sources: [source], searchQuery: generatedQuery })
    assert.equal(network.mock.callCount(), 4)
    assert.deepEqual(network.mock.calls.map(call => new URL(String(call.arguments[0])).hostname),
      ['127.0.0.1', '127.0.0.1', 'html.duckduckgo.com', '127.0.0.1'])
    await post({ ...searched, searchConsent: false }).expect(400)
    assert.equal(network.mock.callCount(), 4)
    assert.deepEqual((await post({ ...searched, webSearch: false }).expect(200)).body, output)
    assert.equal(network.mock.callCount(), 5)
    assert.deepEqual(databaseSnapshot(), before)
  })
})