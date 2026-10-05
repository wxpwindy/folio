import assert from 'node:assert/strict'
import { it, mock } from 'node:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import request from 'supertest'
import { prepareAccountSetup } from './account-setup.ts'
import { hashToken } from './auth.ts'
import { createApp } from './app.ts'
import { createStore } from './store.ts'

it('generates a private setup file, reuses/hash-stores it, persists real sessions across restart and deletes the file only after first signup', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'folio-account-setup-'))
  const filename = join(directory, 'test.sqlite')
  const path = join(directory, 'account-setup-code')
  let store = createStore(filename)
  const network = mock.method(globalThis, 'fetch', async () => { throw new Error('No external services in setup tests') })
  const generate = async (): Promise<never> => { throw new Error('Unexpected generator') }
  try {
    prepareAccountSetup(store.db, directory)
    assert.equal(statSync(path).mode & 0o777, 0o600)
    const contents = readFileSync(path, 'utf8') // Only this test's mkdtemp directory.
    const code = contents.trim()
    assert.match(code, /^[A-Za-z0-9_-]{43}$/)
    assert.equal(Buffer.from(code, 'base64url').length, 32)
    assert.equal(Buffer.from(code, 'base64url').toString('base64url'), code)
    assert.equal(store.db.prepare('SELECT code_hash FROM account_setup').get()!.code_hash, hashToken(code))
    const base = store.addBase({ filename: 'fictional.pdf', text: 'Fictional legacy source', pages: 1 }, Buffer.from('%PDF-fictional'))
    chmodSync(path, 0o644)
    store.db.close()
    store = createStore(filename)
    prepareAccountSetup(store.db, directory)
    assert.equal(readFileSync(path, 'utf8'), contents)
    assert.equal(statSync(path).mode & 0o777, 0o600)
    const client = request.agent(createApp(store, generate, generate)).set('X-Folio-Request', '1')
    await client.post('/api/auth/login').send({ method: 'email', identifier: 'fictional@example.test', password: 'Fictional password 42!' }).expect(401)
    prepareAccountSetup(store.db, directory)
    assert.equal(readFileSync(path, 'utf8'), contents)
    const response = await client.post('/api/auth/signup').send({ method: 'email', identifier: 'fictional@example.test', password: 'Fictional password 42!', setupCode: code }).expect(201)
    const cookie = (response.headers['set-cookie'] as unknown as string[])[0].split(';')[0]
    const owner = response.body.user.id as string
    assert.equal(existsSync(path), true, 'auth has no filesystem side effects; startup owns cleanup')
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM account_setup').get()!.n, 0)
    store.db.close()
    store = createStore(filename)
    prepareAccountSetup(store.db, directory)
    assert.equal(existsSync(path), false)
    const restarted = request.agent(createApp(store, generate, generate)).set('X-Folio-Request', '1').set('Cookie', cookie)
    assert.equal((await restarted.get('/api/auth/session').expect(200)).body.user.id, owner)
    assert.deepEqual((await restarted.get('/api/workspace').expect(200)).body.base, base)
    assert.equal(store.forUser(owner).base()!.id, base.id)
    prepareAccountSetup(store.db, directory)
    assert.equal(existsSync(path), false, 'never regenerate a setup secret after the first account')
    await restarted.post('/api/auth/logout').expect(204)
    store.db.close()
    store = createStore(filename)
    await request(createApp(store, generate, generate)).get('/api/workspace').set('Cookie', cookie).expect(401)
    assert.equal(network.mock.callCount(), 0)
  } finally { store.db.close(); network.mock.restore(); rmSync(directory, { recursive: true, force: true }) }
})

it('rejects a damaged setup file without overwriting it or losing legacy data, and safely reuses a fictional preexisting code', () => {
  const directory = mkdtempSync(join(tmpdir(), 'folio-account-setup-invalid-'))
  const path = join(directory, 'account-setup-code')
  const store = createStore(':memory:')
  try {
    const base = store.addBase({ filename: 'fictional.pdf', text: 'Fictional source', pages: 1 }, Buffer.from('%PDF-fictional'))
    for (const contents of ['', 'not-a-valid-setup-code\n', 'A'.repeat(44), '%'.repeat(43)]) {
      writeFileSync(path, contents)
      assert.throws(() => prepareAccountSetup(store.db, directory), /Invalid account setup code file/)
      assert.equal(readFileSync(path, 'utf8'), contents)
      assert.deepEqual(store.base(), base)
      assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM account_setup').get()!.n, 0)
    }
    const code = Buffer.from('8f903d3ab47012ccee104e90fb771da5526ac43899b0421de6750aefa2690cd1', 'hex').toString('base64url')
    writeFileSync(path, `${code}\n`)
    chmodSync(path, 0o666)
    prepareAccountSetup(store.db, directory)
    assert.equal(readFileSync(path, 'utf8'), `${code}\n`)
    assert.equal(statSync(path).mode & 0o777, 0o600)
    assert.equal(store.db.prepare('SELECT code_hash FROM account_setup').get()!.code_hash, hashToken(code))
    assert.deepEqual(store.base(), base)
  } finally { store.db.close(); rmSync(directory, { recursive: true, force: true }) }
})