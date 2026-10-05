import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import { scryptSync } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import type { Response } from 'supertest'
import PDFDocument from 'pdfkit'
import { createApp } from './app.ts'
import { hashPassword, hashToken } from './auth.ts'
import { createStore } from './store.ts'
import type { Store, ResumeVersion } from './store.ts'
import type { GenerationInput, TailoredResult } from './ai.ts'
import type { TranslationInput } from './translation.ts'

// Fixed fictional 32-byte value; never read the application's setup file or DB.
const setupCode = Buffer.from('8f903d3ab47012ccee104e90fb771da5526ac43899b0421de6750aefa2690cd1', 'hex').toString('base64url')
const password = 'Fictional password 42!'
const text = 'Alex Example\nalex@example.test\nBuilt fictional TypeScript services and automated tests with a small engineering team.'
const editedText = `${text}\nDocumented fictional deployment procedures.`
const pdfBytes = Buffer.from('%PDF-fictional-legacy-original')
const result: TailoredResult = {
  language: { code: 'en', name: 'English' }, englishVersion: null,
  resumeText: text, summary: 'Fictional summary', keywords: ['TypeScript'], gaps: [],
}
const input = (baseId: string): GenerationInput => ({
  baseId, role: 'Engineer', company: 'Example', jobDescription: text, provider: 'ollama', model: 'fictional-model',
})
const translation = (sourceType: 'base' | 'version', sourceId: string): TranslationInput => ({
  sourceType, sourceId, targetLanguage: 'en', provider: 'ollama', model: 'fictional-model',
})
const patch = { role: 'Engineer', company: 'Example', text: editedText, status: 'ready' }
const credentials = (identifier = 'alex@example.test', secret = password) => ({ method: 'email', identifier, password: secret })
const versionInput = (baseId: string) => ({
  ...input(baseId), baseText: text, text, summary: 'Fictional snapshot', keywords: [], gaps: [],
})
function cookie(response: Response) {
  const headers = response.headers['set-cookie'] as unknown as string[]
  assert.equal(headers.length, 1)
  return headers[0].split(';')[0]
}
function publicIdentity(response: Response, identifier: string, method = 'email') {
  assert.deepEqual(Object.keys(response.body).sort(), ['setupRequired', 'user'])
  assert.deepEqual(Object.keys(response.body.user).sort(), ['createdAt', 'id', 'identifier', 'method', 'mustChangePassword', 'role'])
  assert.equal(response.body.user.role, 'user')
  assert.equal(response.body.user.mustChangePassword, false)
  assert.equal(response.body.user.identifier, identifier)
  assert.equal(response.body.user.method, method)
  assert.equal(response.body.setupRequired, false)
  assert.match(response.body.user.id, /^[a-f0-9-]{36}$/)
  assert.ok(Number.isFinite(Date.parse(response.body.user.createdAt)))
  // Neither a verification claim, password/hash, nor a cookie token is public.
  assert.ok(!JSON.stringify(response.body).includes(cookie(response).split('=')[1]))
}
function seedLegacy(store: Store) {
  const base = store.addBase({ filename: 'fictional.pdf', text, pages: 1 }, pdfBytes)
  const version = store.addVersion(versionInput(base.id))
  return { base, version }
}
function rows(store: Store) {
  return {
    bases: store.db.prepare('SELECT * FROM bases ORDER BY id').all(),
    versions: store.db.prepare('SELECT * FROM versions ORDER BY id').all(),
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
async function syntheticPdf() {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument()
    const chunks: Buffer[] = []
    doc.on('data', (chunk: Buffer) => chunks.push(chunk))
    doc.on('error', reject)
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.text(text)
    doc.end()
  })
}

describe('mandatory authentication and account isolation (real scrypt and cookies)', { concurrency: false }, () => {
  let store: Store
  let app: ReturnType<typeof createApp>
  let generate: ReturnType<typeof mock.fn<typeof fakeGenerate>>
  let translate: ReturnType<typeof mock.fn<typeof fakeTranslate>>
  let network: ReturnType<typeof mock.method<typeof globalThis, 'fetch'>>
  async function fakeGenerate(_input: GenerationInput, _source: string) { return structuredClone(result) }
  async function fakeTranslate(_input: TranslationInput, source: string, _type?: 'resume' | 'cover-letter') { return { text: source } }
  const agent = () => request.agent(app).set('X-Folio-Request', '1')
  const signup = (client = agent(), identifier = 'alex@example.test', secret = password) =>
    client.post('/api/auth/signup').send({ ...credentials(identifier, secret), setupCode }).expect(201)

  beforeEach(() => {
    store = createStore(':memory:')
    store.db.prepare('INSERT INTO account_setup VALUES (1, ?)').run(hashToken(setupCode))
    generate = mock.fn(fakeGenerate)
    translate = mock.fn(fakeTranslate)
    app = createApp(store, generate, translate)
    network = mock.method(globalThis, 'fetch', async () => { throw new Error('External services are forbidden in auth tests') })
  })
  afterEach(() => {
    try { assert.equal(network.mock.callCount(), 0) }
    finally { store.db.close(); mock.restoreAll() }
  })

  it('normalizes email and international mobile identities, rejects normalized duplicates, and never claims verification', async () => {
    const email = agent()
    const first = await signup(email, '  Alex@EXAMPLE.test  ')
    publicIdentity(first, 'alex@example.test')
    await email.post('/api/auth/login').send(credentials(' ALEX@example.TEST ')).expect(200)
    const duplicateEmail = await agent().post('/api/auth/signup').send(credentials('ALEX@EXAMPLE.TEST')).expect(409)
    const phone = agent()
    const phoneCredentials = { method: 'phone', identifier: ' +1 (202) 555-0123 ', password }
    const mobile = await phone.post('/api/auth/signup').send(phoneCredentials).expect(201)
    publicIdentity(mobile, '+12025550123', 'phone')
    await phone.post('/api/auth/login').send({ ...phoneCredentials, identifier: '+12025550123' }).expect(200)
    const duplicatePhone = await agent().post('/api/auth/signup').send({ ...phoneCredentials, identifier: '+1 202-555-0123' }).expect(409)
    assert.deepEqual(duplicatePhone.body, duplicateEmail.body)
    for (const identifier of ['2025550123', '+12025550123 ext. 9', '+123', 'not a phone']) {
      await agent().post('/api/auth/signup').send({ ...phoneCredentials, identifier }).expect(400)
    }
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM users').get()!.n, 2)
  })

  it('enforces 12–128 character passwords without trimming/Unicode normalization, and fixed bounded salted scrypt encoding', async () => {
    for (const secret of ['x'.repeat(11), 'x'.repeat(129)]) {
      await agent().post('/api/auth/signup').send({ ...credentials('invalid@example.test', secret), setupCode }).expect(400)
      await assert.rejects(hashPassword(secret))
    }
    for (const [index, secret] of ['x'.repeat(12), 'x'.repeat(128), '  Café fiction 密碼  '].entries()) {
      const client = agent()
      const identifier = `boundary${index}@example.test`
      await signup(client, identifier, secret)
      await client.post('/api/auth/login').send(credentials(identifier, secret)).expect(200)
      if (index === 2) {
        await client.post('/api/auth/login').send(credentials(identifier, secret.trim())).expect(401)
        await client.post('/api/auth/login').send(credentials(identifier, secret.normalize('NFD'))).expect(401)
      }
    }
    const [one, two] = await Promise.all([hashPassword(password), hashPassword(password)])
    assert.notEqual(one, two)
    assert.match(one, /^scrypt\$32768\$8\$1\$[a-f0-9]{64}\$[a-f0-9]{128}$/)
    const [, , , , salt, key] = one.split('$')
    assert.equal(scryptSync(password, Buffer.from(salt, 'hex'), 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex'), key)
    // All five start in one JS turn; the fifth is rejected before any scrypt
    // callback can run. No timing threshold or mocked password derivation.
    const jobs = await Promise.allSettled(Array.from({ length: 5 }, () => hashPassword(password)))
    assert.equal(jobs.filter(job => job.status === 'fulfilled').length, 4)
    const rejected = jobs.filter(job => job.status === 'rejected')
    assert.equal(rejected.length, 1)
    assert.equal(rejected[0].reason.status, 429)
    assert.equal(rejected[0].reason.message, 'Too many authentication attempts. Please try again later.')
    const client = agent()
    await signup(client)
    const wrong = await client.post('/api/auth/login').send(credentials(undefined, 'Wrong fictional password')).expect(401)
    const unknown = await client.post('/api/auth/login').send(credentials('unknown@example.test')).expect(401)
    assert.deepEqual(wrong.body, { error: 'Invalid sign-in details.' })
    assert.deepEqual(unknown.body, wrong.body)
    // Attacker-controlled costs and damaged encodings must not be executed/accepted.
    for (const damaged of [one.replace('$32768$', '$1073741824$'), 'scrypt$broken', `${one}$extra`]) {
      store.db.prepare('UPDATE users SET password_hash = ? WHERE identifier = ?').run(damaged, 'alex@example.test')
      const denied = await client.post('/api/auth/login').send(credentials()).expect(401)
      assert.deepEqual(denied.body, wrong.body)
    }
  })

  it('denies missing, incorrect and unavailable first-account setup before claiming legacy data', async () => {
    seedLegacy(store)
    const before = rows(store)
    for (const code of [undefined, '', 'wrong-fictional-code']) {
      await agent().post('/api/auth/signup').send({ ...credentials(), setupCode: code }).expect(403)
    }
    store.db.exec('DELETE FROM account_setup')
    await agent().post('/api/auth/signup').send({ ...credentials(), setupCode }).expect(503)
    store.db.prepare('INSERT INTO account_setup VALUES (1, ?)').run('invalid-hash')
    await agent().post('/api/auth/signup').send({ ...credentials(), setupCode }).expect(503)
    assert.deepEqual(rows(store), before)
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM users').get()!.n, 0)
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, 0)
    assert.deepEqual((await agent().get('/api/auth/session').expect(200)).body, { user: null, setupRequired: true })
  })

  it('additively migrates legacy data and atomically assigns only the first account without exposing or changing snapshots', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'folio-auth-migration-'))
    const filename = join(directory, 'test.sqlite')
    const { base, version } = seedLegacy(store)
    const legacy = new DatabaseSync(filename)
    try {
      legacy.exec('CREATE TABLE bases (id TEXT PRIMARY KEY, document TEXT NOT NULL, pdf BLOB NOT NULL); CREATE TABLE versions (id TEXT PRIMARY KEY, base_id TEXT NOT NULL REFERENCES bases(id), document TEXT NOT NULL)')
      legacy.prepare('INSERT INTO bases VALUES (?, ?, ?)').run(base.id, JSON.stringify(base), pdfBytes)
      legacy.prepare('INSERT INTO versions VALUES (?, ?, ?)').run(version.id, base.id, JSON.stringify(version))
    } finally { legacy.close() }
    const migrated = createStore(filename)
    try {
      migrated.db.prepare('INSERT INTO account_setup VALUES (1, ?)').run(hashToken(setupCode))
      const localApp = createApp(migrated, generate, translate)
      const first = request.agent(localApp).set('X-Folio-Request', '1')
      for (const path of ['/api/workspace', `/api/base/${base.id}/pdf`, `/api/versions/${version.id}/pdf`]) await first.get(path).expect(401)
      await first.post('/api/auth/login').send(credentials()).expect(401)
      assert.equal(migrated.db.prepare('SELECT owner_id FROM bases').get()!.owner_id, null)
      const response = await first.post('/api/auth/signup').send({ ...credentials(), setupCode }).expect(201)
      const owner = response.body.user.id
      assert.deepEqual((await first.get('/api/workspace').expect(200)).body.versions, [version])
      assert.deepEqual(migrated.forUser(owner).base(), base)
      assert.equal(migrated.db.prepare('SELECT document FROM versions').get()!.document, JSON.stringify(version))
      assert.equal(migrated.db.prepare('SELECT document FROM bases').get()!.document, JSON.stringify(base))
      assert.deepEqual(Buffer.from(migrated.forUser(owner).pdf(base.id)!), pdfBytes)
      assert.equal(migrated.db.prepare('SELECT owner_id FROM versions').get()!.owner_id, owner)
      assert.equal(migrated.db.prepare('SELECT COUNT(*) AS n FROM account_setup').get()!.n, 0)
      const second = request.agent(localApp).set('X-Folio-Request', '1')
      await second.post('/api/auth/signup').send(credentials('later@example.test')).expect(201)
      const workspace = (await second.get('/api/workspace').expect(200)).body
      assert.equal(workspace.base, null)
      assert.deepEqual(workspace.versions, [])
      await first.patch(`/api/base/${base.id}`).send({ text: editedText }).expect(200)
      assert.equal(migrated.forUser(owner).version(version.id)!.baseText, text)
    } finally { migrated.db.close(); rmSync(directory, { recursive: true, force: true }) }
  })

  it('allows exactly one concurrent first-account claim; the losing claimant gets 409 and no session', async () => {
    seedLegacy(store)
    const responses = await Promise.all(['first', 'second'].map(name => agent().post('/api/auth/signup')
      .send({ ...credentials(`${name}@example.test`), setupCode })))
    assert.deepEqual(responses.map(response => response.status).sort(), [201, 409])
    const winner = responses.find(response => response.status === 201)!
    const loser = responses.find(response => response.status === 409)!
    assert.equal(loser.headers['set-cookie'], undefined)
    assert.deepEqual(Object.keys(loser.body), ['error'])
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM users').get()!.n, 1)
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, 1)
    for (const table of ['bases', 'versions']) assert.equal(store.db.prepare(`SELECT owner_id FROM ${table}`).get()!.owner_id, winner.body.user.id)
  })

  it('rolls back failed additive migration and first claim without losing legacy data, setup hash or account state', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'folio-auth-failed-migration-'))
    const filename = join(directory, 'test.sqlite')
    const legacy = new DatabaseSync(filename)
    try {
      legacy.exec(`
        CREATE TABLE bases (id TEXT PRIMARY KEY, document TEXT NOT NULL, pdf BLOB NOT NULL);
        CREATE TABLE versions (id TEXT PRIMARY KEY, base_id TEXT NOT NULL REFERENCES bases(id), document TEXT NOT NULL);
        CREATE TABLE versions_owner_idx (id TEXT);
      `)
      legacy.prepare('INSERT INTO bases VALUES (?, ?, ?)').run('legacy-base', '{"text":"fictional source"}', pdfBytes)
      legacy.prepare('INSERT INTO versions VALUES (?, ?, ?)').run('legacy-version', 'legacy-base', '{"baseText":"immutable fictional source"}')
      const originalBase = legacy.prepare('SELECT * FROM bases').all()
      const originalVersion = legacy.prepare('SELECT * FROM versions').all()
      // The conflicting table name fails the final CREATE INDEX, after both
      // ALTER TABLE operations. Check rollback through a separate connection.
      assert.throws(() => createStore(filename), /versions_owner_idx/)
      for (const table of ['bases', 'versions']) {
        assert.ok(!legacy.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === 'owner_id'))
      }
      assert.deepEqual(legacy.prepare('SELECT * FROM bases').all(), originalBase)
      assert.deepEqual(legacy.prepare('SELECT * FROM versions').all(), originalVersion)
      legacy.exec('DROP TABLE versions_owner_idx')
      const recovered = createStore(filename)
      try {
        assert.deepEqual(recovered.db.prepare('SELECT id, document, pdf FROM bases').all(), originalBase)
        assert.deepEqual(recovered.db.prepare('SELECT id, base_id, document FROM versions').all(), originalVersion)
      } finally { recovered.db.close() }
    } finally { legacy.close(); rmSync(directory, { recursive: true, force: true }) }
    seedLegacy(store)
    const before = rows(store)
    store.db.exec("CREATE TRIGGER fail_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'fictional failure'); END")
    const log = mock.method(console, 'error', () => {})
    const failed = await agent().post('/api/auth/signup').send({ ...credentials(), setupCode }).expect(500)
    assert.equal(failed.headers['set-cookie'], undefined)
    assert.deepEqual(rows(store), before)
    assert.equal(store.db.prepare('SELECT code_hash FROM account_setup').get()!.code_hash, hashToken(setupCode))
    for (const table of ['users', 'sessions']) assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n, 0)
    assert.deepEqual(log.mock.calls.map(call => call.arguments), [['Request failed:', 'Error']])
    store.db.exec('DROP TRIGGER fail_session')
    const client = agent()
    await signup(client)
    assert.equal((await client.get('/api/workspace').expect(200)).body.versions.length, 1)
  })

  it('stores only hashed sessions/passwords, rotates on signup/login, and revokes on logout with strict absolute cookie TTL', async () => {
    const client = agent()
    const started = Date.now()
    const first = await signup(client)
    publicIdentity(first, 'alex@example.test')
    const header = (first.headers['set-cookie'] as unknown as string[])[0]
    for (const attribute of ['HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=604800']) assert.ok(header.includes(attribute))
    const firstCookie = cookie(first)
    const token = firstCookie.split('=')[1]
    assert.match(token, /^[A-Za-z0-9_-]{43}$/)
    const session = store.db.prepare('SELECT * FROM sessions').get()!
    assert.equal(session.token_hash, hashToken(token))
    assert.equal(session.user_id, first.body.user.id)
    assert.ok(Number(session.expires_at) >= started + 604800000 && Number(session.expires_at) <= Date.now() + 604800000)
    const expires = Date.parse(header.match(/Expires=([^;]+)/i)![1])
    assert.ok(Math.abs(expires - Number(session.expires_at)) < 1000)
    const user = store.db.prepare('SELECT * FROM users').get()!
    assert.match(String(user.password_hash), /^scrypt\$32768\$8\$1\$/)
    assert.ok(!JSON.stringify({ session, user }).includes(password))
    assert.ok(!JSON.stringify({ session, user }).includes(token))
    const read = await client.get('/api/auth/session').expect(200).expect('Cache-Control', 'no-store')
    assert.deepEqual(read.body, first.body)
    assert.equal(read.headers['set-cookie'], undefined)
    assert.equal(store.db.prepare('SELECT expires_at FROM sessions').get()!.expires_at, session.expires_at)
    const login = await client.post('/api/auth/login').send(credentials()).expect(200)
    assert.notEqual(cookie(login), firstCookie)
    await agent().get('/api/workspace').set('Cookie', firstCookie).expect(401)
    const second = await signup(client, 'second@example.test')
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, 1)
    await agent().get('/api/workspace').set('Cookie', cookie(login)).expect(401)
    const logout = await client.post('/api/auth/logout').expect(204)
    const clear = (logout.headers['set-cookie'] as unknown as string[])[0]
    assert.match(clear, /Max-Age=0/)
    assert.match(clear, /Expires=Thu, 01 Jan 1970 00:00:00 GMT/i)
    assert.match(clear, /HttpOnly/)
    assert.match(clear, /SameSite=Strict/)
    await client.get('/api/workspace').expect(401)
    await agent().get('/api/workspace').set('Cookie', cookie(second)).expect(401)
    await client.post('/api/auth/logout').expect(204)
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, 0)
  })

  it('rejects stale expected-user headers on all data routes before upload parsing, mutation or model work', async () => {
    const client = agent()
    const ownerA = (await signup(client)).body.user.id as string
    await client.post('/api/auth/logout').set('X-Folio-User', ownerA).expect(204)
    const ownerB = (await signup(client, 'bea@example.test')).body.user.id as string
    const bStore = store.forUser(ownerB)
    const base = bStore.addBase({ filename: 'b.pdf', text, pages: 1 }, pdfBytes)
    const version = bStore.addVersion(versionInput(base.id))
    const before = rows(store)
    const sessions = store.db.prepare('SELECT * FROM sessions').all()
    const routes = [
      ['get', '/api/workspace'], ['get', '/api/auth/session'],
      ['patch', `/api/base/${base.id}`], ['get', `/api/base/${base.id}/pdf`],
      ['post', '/api/versions'], ['patch', `/api/versions/${version.id}`],
      ['delete', `/api/versions/${version.id}`], ['get', `/api/versions/${version.id}/pdf`],
      ['post', '/api/translations'], ['get', '/api/unknown'], ['post', '/api/unknown'],
    ] as const
    for (const [method, path] of routes) {
      const denied = await client[method](path).set('X-Folio-User', ownerA).expect(401)
      assert.equal(denied.headers['set-cookie'], undefined)
      assert.deepEqual(denied.body, { error: 'The account session changed. Log in again to continue.' })
    }
    await client.post('/api/base').set('X-Folio-User', ownerA)
      .attach('resume', await syntheticPdf(), 'stale-a.pdf').expect(401)
    // Would be a multer error if authentication did not run first.
    await client.post('/api/base').set('X-Folio-User', ownerA)
      .attach('unexpected', Buffer.from('not a PDF'), 'invalid.txt').expect(401)
    assert.deepEqual(rows(store), before)
    assert.deepEqual(store.db.prepare('SELECT * FROM sessions').all(), sessions)
    assert.equal(generate.mock.callCount(), 0)
    assert.equal(translate.mock.callCount(), 0)
    assert.equal((await client.get('/api/auth/session').set('X-Folio-User', ownerB).expect(200)).body.user.id, ownerB)
    assert.deepEqual((await client.get('/api/workspace').set('X-Folio-User', ownerB).expect(200)).body.versions, [version])
  })

  it('stale logout never revokes or clears the new account cookie; matching logout still revokes it', async () => {
    const client = agent()
    const ownerA = (await signup(client)).body.user.id as string
    const second = await signup(client, 'bea@example.test')
    const ownerB = second.body.user.id as string
    const sessions = store.db.prepare('SELECT * FROM sessions').all()
    for (const expected of [ownerA, '', `${ownerB}, ${ownerB}`, 'nonexistent-user']) {
      const denied = await client.post('/api/auth/logout').set('X-Folio-User', expected).expect(401)
      assert.equal(denied.headers['set-cookie'], undefined)
      assert.deepEqual(store.db.prepare('SELECT * FROM sessions').all(), sessions)
      await client.get('/api/workspace').set('X-Folio-User', ownerB).expect(200)
    }
    const logout = await client.post('/api/auth/logout').set('X-Folio-User', ownerB).expect(204)
    assert.match((logout.headers['set-cookie'] as unknown as string[])[0], /Max-Age=0/)
    await agent().get('/api/workspace').set('Cookie', cookie(second)).expect(401)
    const expired = await client.post('/api/auth/logout').set('X-Folio-User', ownerB).expect(401)
    assert.equal(expired.headers['set-cookie'], undefined)
    await client.post('/api/auth/logout').expect(204) // Unbound clients remain backwards compatible.
  })

  it('never authenticates or selects an owner from the expected-user header', async () => {
    const a = agent(), b = agent()
    const ownerA = (await signup(a)).body.user.id as string
    const ownerB = (await signup(b, 'bea@example.test')).body.user.id as string
    const baseA = store.forUser(ownerA).addBase({ filename: 'a.pdf', text, pages: 1 }, pdfBytes)
    await agent().get('/api/workspace').set('X-Folio-User', ownerA).expect(401)
    await agent().get('/api/auth/session').set('X-Folio-User', ownerA).expect(401)
    await a.get('/api/workspace').set('X-Folio-User', ownerB).expect(401)
    await b.get(`/api/base/${baseA.id}/pdf`).set('X-Folio-User', ownerB).expect(404)
    const uploaded = await b.post('/api/base').set('X-Folio-User', ownerB).field('owner_id', ownerA)
      .attach('resume', await syntheticPdf(), 'b.pdf').expect(201)
    assert.equal(store.db.prepare('SELECT owner_id FROM bases WHERE id = ?').get(uploaded.body.id)!.owner_id, ownerB)
    await b.get(`/api/base/${uploaded.body.id}/pdf`).set('X-Folio-User', ownerB).expect(200)
  })

  it('fails closed for invalid, duplicate, malformed, noncanonical, oversized and expired session cookies', async () => {
    const first = await signup()
    const valid = cookie(first)
    const noncanonical = `${'A'.repeat(42)}B`
    for (const value of ['', 'unrelated=value', 'folio_session=short', `folio_session=${setupCode}`, `${valid}; ${valid}`,
      `${valid}; folio_session=bad`, `folio_session=%E0%A4%A`, `folio_session=${noncanonical}`, `${valid}; padding=${'x'.repeat(8200)}`]) {
      const client = agent()
      await client.get('/api/workspace').set('Cookie', value).expect(401)
      assert.deepEqual((await client.get('/api/auth/session').set('Cookie', value).expect(200)).body, { user: null, setupRequired: false })
    }
    await agent().get('/api/workspace').set('Cookie', `unrelated=value; ${valid}`).expect(200)
    store.db.prepare('UPDATE sessions SET expires_at = ?').run(Date.now() - 1)
    await agent().get('/api/workspace').set('Cookie', valid).expect(401)
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n, 0)
    assert.equal((await agent().get('/api/auth/session').set('Cookie', valid).expect(200)).body.user, null)
  })

  it('guards every data route (including unknown/upload) before work, enforces CSRF without Origin, and rejects hostile Host/Origin with valid cookies', async () => {
    const { base, version } = seedLegacy(store)
    const routes = [
      ['get', '/api/workspace'], ['post', '/api/base'], ['patch', `/api/base/${base.id}`], ['get', `/api/base/${base.id}/pdf`],
      ['post', '/api/versions'], ['patch', `/api/versions/${version.id}`], ['delete', `/api/versions/${version.id}`],
      ['get', `/api/versions/${version.id}/pdf`], ['post', '/api/translations'], ['get', '/api/unknown'], ['post', '/api/unknown'],
    ] as const
    for (const [method, path] of routes) await agent()[method](path).expect(401)
    await agent().post('/api/base').attach('unexpected', Buffer.from('not even a PDF'), 'fictional.txt').expect(401)
    for (const path of ['/api/auth/signup', '/api/auth/login', '/api/auth/logout']) {
      await request(app).post(path).send({ ...credentials(), setupCode }).expect(403)
      await request(app).post(path).set('X-Folio-Request', '0').send(credentials()).expect(403)
    }
    const signedIn = await signup()
    for (const [method, path] of routes) {
      if (method !== 'get') await request(app)[method](path).set('Cookie', cookie(signedIn)).expect(403)
      for (const headers of [{ Origin: 'https://evil.example' }, { Host: 'evil.example' }]) {
        const denied = await agent()[method](path).set('Cookie', cookie(signedIn)).set(headers).expect(403)
        assert.equal(denied.headers['access-control-allow-origin'], undefined)
      }
    }
    for (const path of ['/api/auth/signup', '/api/auth/login', '/api/auth/logout', '/api/auth/session']) {
      const method = path.endsWith('session') ? 'get' : 'post'
      for (const headers of [{ Origin: 'null' }, { Origin: 'https://evil.example' }, { Host: 'evil.example' }]) {
        await agent()[method](path).set('Cookie', cookie(signedIn)).set(headers).expect(403)
      }
    }
    const preflight = await agent().options('/api/base').set('Origin', 'https://evil.example').set('Access-Control-Request-Method', 'POST').expect(403)
    assert.equal(preflight.headers['access-control-allow-origin'], undefined)
    await agent().get('/api/unknown').set('Cookie', cookie(signedIn)).expect(404)
    assert.equal(generate.mock.callCount(), 0)
    assert.equal(translate.mock.callCount(), 0)
  })

  it('isolates all ownership endpoints, ignores forged body owners, and atomically rolls back mixed-owner version batches', async () => {
    const a = agent(), b = agent()
    const ownerA = (await signup(a)).body.user.id as string
    const ownerB = (await signup(b, 'bea@example.test')).body.user.id as string
    const aStore = store.forUser(ownerA), bStore = store.forUser(ownerB)
    const baseA = aStore.addBase({ filename: 'a.pdf', text, pages: 1 }, pdfBytes)
    const versionA = aStore.addVersion(versionInput(baseA.id))
    const imported = await b.post('/api/base').field('owner_id', ownerA).field('ownerId', ownerA)
      .attach('resume', await syntheticPdf(), 'fictional.pdf').expect(201)
    const baseB = imported.body.id as string
    assert.equal(store.db.prepare('SELECT owner_id FROM bases WHERE id = ?').get(baseB)!.owner_id, ownerB)
    const before = rows(store)
    await b.patch(`/api/base/${baseA.id}`).send({ text: editedText, owner_id: ownerA }).expect(404)
    await b.get(`/api/base/${baseA.id}/pdf`).expect(404)
    await b.patch(`/api/versions/${versionA.id}`).send({ ...patch, ownerId: ownerA }).expect(404)
    await b.delete(`/api/versions/${versionA.id}`).expect(404)
    await b.get(`/api/versions/${versionA.id}/pdf`).expect(404)
    await b.post('/api/versions').send({ ...input(baseA.id), owner_id: ownerA }).expect(404)
    for (const [type, id] of [['base', baseA.id], ['version', versionA.id]] as const) {
      await b.post('/api/translations').send({ ...translation(type, id), ownerId: ownerA }).expect(404)
    }
    assert.deepEqual(rows(store), before)
    assert.equal(generate.mock.callCount(), 0)
    assert.equal(translate.mock.callCount(), 0)
    assert.throws(() => bStore.addVersions([versionInput(baseB), versionInput(baseA.id)]), /outside the account/)
    assert.deepEqual(rows(store), before)
    assert.deepEqual((await a.get('/api/workspace').expect(200)).body.versions, [versionA])
    assert.deepEqual((await b.get('/api/workspace').expect(200)).body.versions, [])
    await b.patch(`/api/base/${baseB}`).send({ text: editedText, owner_id: ownerA, ownerId: ownerA }).expect(200)
    const created = await b.post('/api/versions').send({ ...input(baseB), owner_id: ownerA, ownerId: ownerA }).expect(201)
    const id = created.body.id as string
    const updated = await b.patch(`/api/versions/${id}`).send({ ...patch, owner_id: ownerA, ownerId: ownerA, baseId: baseA.id }).expect(200)
    assert.equal(updated.body.baseId, baseB)
    assert.equal(updated.body.owner_id, undefined)
    assert.equal(updated.body.ownerId, undefined)
    assert.equal(store.db.prepare('SELECT owner_id FROM versions WHERE id = ?').get(id)!.owner_id, ownerB)
    await a.get(`/api/base/${baseB}/pdf`).expect(404)
    await a.get(`/api/versions/${id}/pdf`).expect(404)
    await b.get(`/api/base/${baseB}/pdf`).expect(200).expect('Content-Type', /application\/pdf/)
    await b.get(`/api/versions/${id}/pdf`).expect(200).expect('Content-Type', /application\/pdf/)
    await b.delete(`/api/versions/${id}`).expect(204)
    assert.deepEqual(aStore.version(versionA.id), versionA)
  })

  it('retains owners and immutable source/bilingual references for cover letters and translations', async () => {
    const a = agent(), b = agent()
    const ownerA = (await signup(a)).body.user.id as string
    const ownerB = (await signup(b, 'bea@example.test')).body.user.id as string
    const base = store.forUser(ownerA).addBase({ filename: 'a.pdf', text, pages: 1 }, pdfBytes)
    generate.mock.mockImplementationOnce(async () => ({ ...result, language: { code: 'fr', name: 'French' }, englishVersion: result }))
    const response = await a.post('/api/versions').send({ ...input(base.id), documentType: 'cover-letter', owner_id: ownerB }).expect(201)
    const primary = response.body as ResumeVersion & { additionalVersions: ResumeVersion[] }
    const english = primary.additionalVersions[0]
    assert.equal(primary.additionalVersions.length, 1)
    assert.notEqual(primary.id, english.id)
    assert.equal(primary.generationId, english.generationId)
    assert.deepEqual([primary.language?.code, english.language?.code], ['fr', 'en'])
    const translated = await a.post('/api/translations').send({ ...translation('version', primary.id), ownerId: ownerB }).expect(201)
    assert.deepEqual(translated.body.translation, { sourceType: 'version', sourceId: primary.id, sourceText: primary.text })
    assert.equal(translated.body.baseText, text)
    assert.equal(translated.body.baseId, base.id)
    assert.notEqual(translated.body.generationId, primary.generationId)
    assert.equal(translate.mock.calls[0].arguments[2], 'cover-letter')
    const baseTranslation = await a.post('/api/translations').send(translation('base', base.id)).expect(201)
    assert.deepEqual(baseTranslation.body.translation, { sourceType: 'base', sourceId: base.id, sourceText: text })
    for (const version of [primary, english, translated.body, baseTranslation.body]) {
      assert.equal(store.db.prepare('SELECT owner_id FROM versions WHERE id = ?').get(version.id)!.owner_id, ownerA)
      assert.equal(version.documentType, version.id === baseTranslation.body.id ? 'resume' : 'cover-letter')
      await b.get(`/api/versions/${version.id}/pdf`).expect(404)
      await b.post('/api/translations').send(translation('version', version.id)).expect(404)
    }
    await a.patch(`/api/base/${base.id}`).send({ text: editedText }).expect(200)
    await a.patch(`/api/versions/${primary.id}`).send(patch).expect(200)
    await a.delete(`/api/versions/${primary.id}`).expect(204)
    assert.equal(store.forUser(ownerA).version(translated.body.id)!.translation!.sourceText, text)
    assert.equal(store.forUser(ownerA).version(english.id)!.baseText, text)
    assert.deepEqual((await b.get('/api/workspace').expect(200)).body.versions, [])
    assert.equal(generate.mock.callCount(), 1)
    assert.equal(translate.mock.callCount(), 2)
  })

  it('captures the initiating owner and saved sources across in-flight generation/translation, edits and same-agent account switching', async () => {
    const client = agent(), editor = agent()
    const ownerA = (await signup(client)).body.user.id as string
    const ownerB = (await signup(agent(), 'bea@example.test')).body.user.id as string
    await editor.post('/api/auth/login').send(credentials()).expect(200)
    const aStore = store.forUser(ownerA)
    for (const kind of ['generation', 'translation'] as const) {
      await client.post('/api/auth/login').send(credentials()).expect(200)
      const base = aStore.addBase({ filename: 'snapshot.pdf', text, pages: 1 }, pdfBytes)
      const source = aStore.addVersion({ ...versionInput(base.id), documentType: 'cover-letter' })
      const entered = deferred<void>(), release = deferred<void>()
      if (kind === 'generation') generate.mock.mockImplementationOnce(async (_input, captured) => {
        assert.equal(captured, text); entered.resolve(); await release.promise; return structuredClone(result)
      })
      else translate.mock.mockImplementationOnce(async (_input, captured, type) => {
        assert.equal(captured, text); assert.equal(type, 'cover-letter'); entered.resolve(); await release.promise; return { text: captured }
      })
      const pending = (kind === 'generation'
        ? client.post('/api/versions').send(input(base.id))
        : client.post('/api/translations').send(translation('version', source.id)))
        .set('X-Folio-User', ownerA).expect(201).then(response => response)
      try {
        await Promise.race([entered.promise, pending.then(() => { throw new Error('Request finished without entering the fake model') })])
        await client.post('/api/auth/login').send(credentials('bea@example.test')).expect(200)
        await editor.patch(`/api/base/${base.id}`).send({ text: editedText }).expect(200)
        await editor.patch(`/api/versions/${source.id}`).send(patch).expect(200)
        await editor.delete(`/api/versions/${source.id}`).expect(204)
        aStore.addBase({ filename: 'replacement.pdf', text: editedText, pages: 1 }, pdfBytes)
      } finally { release.resolve() }
      const saved = (await pending).body as ResumeVersion
      assert.equal(store.db.prepare('SELECT owner_id FROM versions WHERE id = ?').get(saved.id)!.owner_id, ownerA)
      assert.equal(saved.baseId, base.id)
      assert.equal(saved.baseText, text)
      if (kind === 'translation') assert.deepEqual(saved.translation, { sourceType: 'version', sourceId: source.id, sourceText: text })
      assert.equal((await client.get('/api/auth/session').expect(200)).body.user.id, ownerB)
      await client.get(`/api/versions/${saved.id}/pdf`).expect(404)
      assert.deepEqual((await client.get('/api/workspace').expect(200)).body.versions, [])
      assert.ok(aStore.version(saved.id))
    }
    assert.equal(generate.mock.callCount(), 1)
    assert.equal(translate.mock.callCount(), 1)
  })

  it('shares a 30-attempt signup/login rate budget and returns nonsensitive 429 responses without trusting forwarded IPs', async () => {
    // The library intentionally diagnoses untrusted XFF once. Capture that
    // expected diagnostic rather than printing it as an apparent suite error.
    const log = mock.method(console, 'error', () => {})
    for (let attempt = 0; attempt < 30; attempt++) {
      const path = attempt % 2 ? '/api/auth/login' : '/api/auth/signup'
      await agent().post(path).set('X-Forwarded-For', `192.0.2.${attempt + 1}`)
        .send({ ...credentials(), setupCode: 'incorrect fictional setup' }).expect(attempt % 2 ? 401 : 403)
    }
    for (const path of ['/api/auth/signup', '/api/auth/login']) {
      const denied = await agent().post(path).send({ ...credentials(), setupCode }).expect(429)
      assert.deepEqual(denied.body, { error: 'Too many authentication attempts. Please try again later.' })
      assert.equal(denied.headers['set-cookie'], undefined)
      assert.ok(Number(denied.headers['retry-after']) > 0)
    }
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM users').get()!.n, 0)
    await agent().get('/api/auth/session').expect(200)
    await agent().post('/api/auth/logout').expect(204)
    assert.equal(log.mock.callCount(), 1)
    assert.equal(log.mock.calls[0].arguments[0].code, 'ERR_ERL_UNEXPECTED_X_FORWARDED_FOR')
  })
})