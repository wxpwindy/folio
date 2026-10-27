import assert from 'node:assert/strict'
import dns from 'node:dns/promises'
import type { LookupAddress, LookupAllOptions, LookupOneOptions, LookupOptions } from 'node:dns'
import https from 'node:https'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import { AppError, generateResume, generationSchema, requestModel } from './ai.ts'
import { byokEndpoint, isPublicByokAddress, requestByok } from './byok.ts'
import { cleanResume, cleanResumeSchema } from './clean-resume.ts'
import { translateDocument, translationSchema } from './translation.ts'

const settings = {
  provider: 'byok' as const, model: 'custom-model',
  baseUrl: 'https://provider.example/v1/', apiKey: 'fictional-client-key', cloudConsent: true,
}
const baseId = '00000000-0000-4000-8000-000000000001'
const text = 'Alex Example\nMaintained TypeScript services and wrote automated tests with a small engineering team.'
const generation = { ...settings, baseId, role: 'Engineer', company: 'Example', jobDescription: text }
const output = { resumeText: text, summary: '', keywords: [], gaps: [], language: { code: 'en', name: 'English' }, englishVersion: null }
const messages = [{ role: 'user', content: 'untrusted source data' }]
const errors = { consentMessage: 'Confirm sending this document to OpenAI.', invalidMessage: 'Invalid document output.' }
const callModel = (patch: Partial<Parameters<typeof requestModel>[0]> = {}) => requestModel({ ...settings, ...patch }, messages, {}, errors)

function safeError(status: number, message?: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof AppError)
    assert.equal(error.status, status)
    if (message) assert.match(error.message, message)
    for (const secret of [settings.apiKey, 'fictional-server-key', 'provider-secret-response', 'secret-password']) {
      assert.ok(!error.message.includes(secret))
    }
    return true
  }
}

describe('BYOK public HTTPS transport (no live network)', { concurrency: false }, () => {
  let requests: { url: URL; options: https.RequestOptions; body: string }[]
  let responseStatus: number
  let responseBody: string
  let transportError: Error | undefined
  let responseAborted: boolean
  let destroyed: boolean
  let dnsCalls: number
  let addresses: LookupAddress[]
  let oldKey: string | undefined
  let oldDebug: string | undefined

  function lookupStub(hostname: string, family: number): Promise<LookupAddress>
  function lookupStub(hostname: string, options: LookupOneOptions): Promise<LookupAddress>
  function lookupStub(hostname: string, options: LookupAllOptions): Promise<LookupAddress[]>
  function lookupStub(hostname: string, options: LookupOptions): Promise<LookupAddress | LookupAddress[]>
  function lookupStub(hostname: string): Promise<LookupAddress>
  async function lookupStub(_hostname: string, options?: number | LookupOptions): Promise<LookupAddress | LookupAddress[]> {
    dnsCalls++
    if (typeof options === 'object' && options.all) return addresses
    const first = addresses[0]
    if (!first) throw new Error('No mocked DNS address')
    return first
  }

  beforeEach(() => {
    requests = []
    responseStatus = 200
    responseBody = JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] })
    transportError = undefined
    responseAborted = false
    destroyed = false
    dnsCalls = 0
    addresses = [{ address: '93.184.216.34', family: 4 }]
    oldKey = process.env.OPENAI_API_KEY
    oldDebug = process.env.FOLIO_AI_DEBUG_OUTPUT
    process.env.OPENAI_API_KEY = 'fictional-server-key'
    mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected fetch; live network forbidden') })
    mock.method(dns, 'lookup', lookupStub)
    mock.method(https, 'request', ((url: URL, options: https.RequestOptions, callback: (response: IncomingMessage) => void) => {
      const request = new EventEmitter() as ClientRequest
      request.destroy = () => { destroyed = true; return request }
      request.end = ((body: string) => {
        requests.push({ url, options, body })
        queueMicrotask(() => {
          if (transportError) { request.emit('error', transportError); return }
          const response = new EventEmitter() as IncomingMessage
          response.statusCode = responseStatus
          response.headers = { location: 'https://127.0.0.1/private-metadata' }
          response.destroy = () => { destroyed = true; return response }
          callback(response)
          if (responseAborted) { response.emit('aborted'); return }
          // A real destroyed response would not send more body events.
          if (!destroyed) {
            response.emit('data', Buffer.from(responseBody))
            if (!destroyed) response.emit('end')
          }
        })
        return request
      }) as ClientRequest['end']
      return request
    }) as typeof https.request)
  })
  afterEach(() => {
    mock.restoreAll()
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = oldKey
    if (oldDebug === undefined) delete process.env.FOLIO_AI_DEBUG_OUTPUT
    else process.env.FOLIO_AI_DEBUG_OUTPUT = oldDebug
  })

  it('uses JSON-mode chat/completions, a client-only bearer key and pinned TLS identity', async () => {
    assert.deepEqual(await callModel({ apiKey: ` ${settings.apiKey} ` }), output)
    assert.equal(dnsCalls, 1)
    const { url, options, body } = requests[0]!
    assert.equal(url.href, 'https://provider.example/v1/chat/completions')
    assert.equal(options.method, 'POST')
    assert.equal(options.agent, false)
    assert.equal(options.rejectUnauthorized, true)
    assert.equal(options.family, 4)
    assert.ok(options.signal instanceof AbortSignal)
    assert.deepEqual(options.headers, { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` })
    assert.deepEqual(JSON.parse(body), { model: settings.model, messages, response_format: { type: 'json_object' } })
    assert.ok(!body.includes(settings.apiKey))
    // DNS changes after validation cannot redirect the socket to localhost.
    addresses = [{ address: '127.0.0.1', family: 4 }]
    options.lookup!('provider.example', {}, (error, address, family) => {
      assert.equal(error, null)
      assert.equal(address, '93.184.216.34')
      assert.equal(family, 4)
    })
    assert.equal(dnsCalls, 1)
  })

  it('requires explicit consent and a valid explicit key on every operation, ignoring the server key', async () => {
    for (const cloudConsent of [undefined, false]) {
      await assert.rejects(callModel({ cloudConsent }), safeError(400, /Confirm/))
    }
    for (const apiKey of [undefined, '', '   ', 'key\r\nInjected: yes', 'a b', 'x'.repeat(501)]) {
      await assert.rejects(callModel({ apiKey }), safeError(400, /BYOK API key/))
    }
    await assert.rejects(callModel({ baseUrl: undefined }), safeError(400, /baseUrl/))
    assert.equal(dnsCalls, 0)
    assert.equal(requests.length, 0)
    await callModel()
    await assert.rejects(callModel({ cloudConsent: false }), safeError(400, /Confirm/))
    assert.equal(requests.length, 1)
  })

  it('rejects unsafe URL forms and literal private, metadata, reserved and encoded IPs before DNS', async () => {
    for (const baseUrl of [
      'http://provider.example/v1', 'ftp://provider.example', 'not a URL',
      'https:provider.example/v1', 'https:////provider.example/v1',
      'https://user:secret-password@provider.example/v1', 'https://@provider.example',
      'https://provider.example/v1?', 'https://provider.example/v1#',
      'https://provider.example/v1?key=secret-password', 'https://provider.example\\@127.0.0.1',
      'https://localhost/v1', 'https://localhost./v1', 'https://foo.localhost/v1',
      'https://foo.local/v1', 'https://foo.internal/v1',
      ...['0.0.0.0', '10.0.0.1', '127.0.0.1', '127.1', '2130706433', '0x7f000001',
        '0177.0.0.1', '100.100.100.200', '169.254.169.254', '172.16.0.1', '192.168.0.1',
        '192.0.0.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1',
        '224.0.0.1', '255.255.255.255', '168.63.129.16',
        '[::]', '[::1]', '[::ffff:127.0.0.1]', '[::ffff:8.8.8.8]', '[fc00::1]',
        '[fe80::1]', '[ff02::1]', '[64:ff9b::a00:1]', '[2001:db8::1]',
        '[2002:7f00:1::1]', '[2001::1]', '[3fff::1]',
      ].map(host => `https://${host}/v1`),
    ]) await assert.rejects(callModel({ baseUrl }), safeError(400, /HTTPS public endpoint/))
    assert.equal(dnsCalls, 0)
    assert.equal(requests.length, 0)
  })

  it('validates all DNS results and rejects mixed public/private answers with no outbound request', async () => {
    for (const address of ['127.0.0.1', '10.2.3.4', '169.254.169.254', '::1', 'fc00::1', '2001:db8::1', '::ffff:10.0.0.1', 'invalid']) {
      addresses = [{ address: '93.184.216.34', family: 4 }, { address, family: address.includes(':') ? 6 : 4 }]
      await assert.rejects(callModel(), safeError(400, /HTTPS public endpoint/))
    }
    addresses = []
    await assert.rejects(callModel(), safeError(400))
    assert.equal(requests.length, 0)
  })

  it('accepts public IPv4/IPv6 literals without DNS and preserves base path and port', async () => {
    for (const address of ['8.8.8.8', '2606:4700:4700::1111']) assert.ok(isPublicByokAddress(address))
    assert.equal(byokEndpoint('https://provider.example:8443/custom/v1///').href, 'https://provider.example:8443/custom/v1/chat/completions')
    for (const host of ['8.8.8.8', '[2606:4700:4700::1111]']) {
      await callModel({ baseUrl: `https://${host}/v1` })
    }
    assert.equal(dnsCalls, 0)
    assert.equal(requests.length, 2)
    addresses = [{ address: '2606:4700:4700::1111', family: 6 }]
    await callModel()
    assert.equal(requests[2]!.options.family, 6)
  })

  it('sanitizes DNS/transport failures without fallback or retry', async () => {
    mock.method(dns, 'lookup', async () => { throw new Error('provider-secret-response secret-password') })
    await assert.rejects(callModel(), safeError(502, /Cannot reach the BYOK provider/))
    assert.equal(requests.length, 0)
  })

  it('rejects network failures and truncated responses without revealing error details', async () => {
    transportError = new Error(`provider-secret-response ${settings.apiKey}`)
    await assert.rejects(callModel(), safeError(502, /Cannot reach/))
    transportError = undefined
    responseAborted = true
    await assert.rejects(callModel(), safeError(502, /Cannot reach/))
    assert.equal(requests.length, 2)
  })

  for (const [status, expected] of [[301, 502], [302, 502], [307, 502], [308, 502], [401, 401], [403, 502], [404, 400], [429, 429], [500, 502], [600, 502], [999, 502]]) {
    it(`rejects HTTP ${status} without following redirects or leaking the provider body`, async () => {
      responseStatus = status!
      responseBody = `provider-secret-response ${settings.apiKey}`
      await assert.rejects(callModel(), safeError(expected!))
      assert.equal(requests.length, 1)
      assert.ok(destroyed)
    })
  }

  it('bounds response size and sanitizes malformed envelopes/JSON, including with debug enabled', async () => {
    process.env.FOLIO_AI_DEBUG_OUTPUT = '1'
    const log = mock.method(console, 'info', () => {})
    responseBody = 'x'.repeat(2 * 1024 * 1024 + 1)
    await assert.rejects(callModel(), safeError(502, /too large/))
    for (const body of ['provider-secret-response', '{}', JSON.stringify({ choices: [{ message: { content: `provider-secret-response ${settings.apiKey}` } }] })]) {
      destroyed = false
      responseBody = body
      await assert.rejects(callModel(), safeError(502, /Invalid document output/))
    }
    assert.equal(log.mock.callCount(), 0)
  })

  it('bounds DNS and total request time', async () => {
    const signals: number[] = []
    mock.method(AbortSignal, 'timeout', (ms: number) => {
      signals.push(ms)
      return AbortSignal.abort()
    })
    transportError = Object.assign(new Error('secret-password'), { name: 'AbortError' })
    await assert.rejects(callModel(), safeError(504, /3 minutes/))
    assert.deepEqual(signals, [180_000])
    mock.method(dns, 'lookup', () => new Promise<never>(() => {}))
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      const result = requestByok(settings.baseUrl, settings.apiKey, '{}')
      const rejected = assert.rejects(result, safeError(504, /DNS lookup timed out/))
      mock.timers.tick(5000)
      await rejected
    } finally { mock.timers.reset() }
  })

  it('wires generation, cover letters, cleanup and translation to the same guarded adapter', async () => {
    for (const documentType of ['resume', 'cover-letter'] as const) {
      assert.deepEqual(await generateResume({ ...generation, documentType }, text), output)
    }
    const pair = { englishText: text, chineseText: 'Alex Example\n工作经历\n与小型工程团队合作维护 TypeScript 服务并编写自动化测试，保留所有原始工作经历和资格信息。' }
    responseBody = JSON.stringify({ choices: [{ message: { content: JSON.stringify(pair) } }] })
    assert.deepEqual(await cleanResume({ ...settings, baseId }, text), pair)
    responseBody = JSON.stringify({ choices: [{ message: { content: JSON.stringify({ text }) } }] })
    assert.deepEqual(await translateDocument({ ...settings, sourceType: 'base', sourceId: baseId, targetLanguage: 'en' }, text), { text })
    assert.equal(requests.length, 4)
    for (const { body } of requests) assert.equal(JSON.parse(body).response_format.type, 'json_object')
    await assert.rejects(generateResume({ ...generation, cloudConsent: false }, text), safeError(400, /Confirm/))
    await assert.rejects(cleanResume({ ...settings, baseId, cloudConsent: false }, text), safeError(400, /Confirm/))
    await assert.rejects(translateDocument({ ...settings, sourceType: 'base', sourceId: baseId, targetLanguage: 'en', cloudConsent: false }, text), safeError(400, /Confirm/))
    assert.equal(requests.length, 4)
  })
})

describe('BYOK document request schemas', () => {
  for (const [name, schema, input] of [
    ['generation', generationSchema, generation],
    ['cleanup', cleanResumeSchema, { ...settings, baseId }],
    ['translation', translationSchema, { ...settings, sourceType: 'base', sourceId: baseId, targetLanguage: 'en' }],
  ] as const) {
    it(`${name} retains BYOK fields and rejects invalid field shapes`, () => {
      const parsed = schema.parse(input)
      assert.equal(parsed.provider, 'byok')
      assert.equal(parsed.baseUrl, settings.baseUrl)
      assert.equal(parsed.apiKey, settings.apiKey)
      assert.equal(parsed.cloudConsent, true)
      for (const patch of [{ baseUrl: 123 }, { baseUrl: '' }, { baseUrl: 'x'.repeat(2001) }, { apiKey: 'x'.repeat(501) }, { cloudConsent: 'true' }, { provider: 'custom' }, { model: ' ' }]) {
        assert.equal(schema.safeParse({ ...input, ...patch }).success, false)
      }
      for (const provider of ['openai', 'ollama', 'lmstudio']) {
        assert.ok(schema.safeParse({ ...input, provider, baseUrl: undefined }).success)
      }
    })
  }
})
