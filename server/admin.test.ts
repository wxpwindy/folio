import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import request from 'supertest'
import { createStore } from './store.ts'
import { createApp } from './app.ts'
import { initializeAdministrator, hashToken } from './auth.ts'
import { prepareAccountSetup } from './account-setup.ts'

// Fictional values only. Never use the requested real bootstrap password here.
const initial = 'Example123'
const password = 'Fictional-admin-password-2026!'
const userPassword = 'Fictional-user-password-2026!'
const temporary = 'Fictional-temporary-password!'
const text = 'A fictional resume with enough selectable source text to preserve ownership across account administration.'

describe('local administrator permissions and lifecycle', { concurrency: false }, () => {
  let store: ReturnType<typeof createStore>
  let app: ReturnType<typeof createApp>
  let directory: string
  let code: string
  const client = () => request.agent(app).set('X-Folio-Request', '1')
  const username = (secret: string) => ({ method: 'username', identifier: 'wxpwindy', password: secret })
  async function admin() {
    const session = client()
    await session.post('/api/auth/login').send(username(initial)).expect(200)
    const result = await session.post('/api/auth/change-password').send({ currentPassword: initial, newPassword: password }).expect(200)
    return { session, id: result.body.user.id }
  }
  async function user(identifier = 'person@example.test') {
    const session = client()
    const result = await session.post('/api/auth/signup').send({ method: 'email', identifier, password: userPassword, setupCode: code }).expect(201)
    return { session, id: result.body.user.id }
  }
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'folio-admin-test-'))
    store = createStore(':memory:')
    prepareAccountSetup(store.db, directory)
    code = readFileSync(join(directory, 'account-setup-code'), 'utf8').trim()
    await initializeAdministrator(store.db, initial)
    app = createApp(store, undefined, undefined, () => prepareAccountSetup(store.db, directory, true))
  })
  afterEach(() => { store.db.close(); rmSync(directory, { recursive: true, force: true }) })

  it('bootstraps a hashed username admin once without claiming legacy documents or resetting credentials', async () => {
    const base = store.addBase({ text, filename: 'fictional.pdf', pages: 1 }, Buffer.from('%PDF-fictional'))
    const row = store.db.prepare("SELECT * FROM users WHERE identifier = 'wxpwindy'").get()!
    assert.equal(row.role, 'admin'); assert.equal(row.must_change_password, 1)
    assert.match(String(row.password_hash), /^scrypt\$32768\$8\$1\$/)
    assert.ok(!String(row.password_hash).includes(initial))
    await assert.rejects(initializeAdministrator(store.db, 'Different123'), /already exists/)
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM users').get()!.n, 1)
    assert.equal(store.base()!.id, base.id)
    assert.deepEqual((await client().get('/api/auth/session')).body, { user: null, setupRequired: true })
    const owner = await user()
    assert.equal(store.forUser(owner.id).base()!.id, base.id)
    assert.equal(store.forUser(String(row.id)).base(), null)
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM account_setup').get()!.n, 0)
  })

  it('requires password replacement, rotates the cookie, revokes old sessions and disallows reuse/short passwords', async () => {
    const session = client(), other = client()
    const login = await session.post('/api/auth/login').send(username(initial)).expect(200)
    await other.post('/api/auth/login').send(username(initial)).expect(200)
    assert.equal(login.body.user.mustChangePassword, true)
    for (const path of ['/api/workspace', '/api/admin/users', '/api/admin/setup']) await session.get(path).expect(403)
    await session.post('/api/admin/setup/initialize').expect(403)
    await session.post('/api/auth/change-password').send({ currentPassword: 'wrong', newPassword: password }).expect(400)
    await session.post('/api/auth/change-password').send({ currentPassword: initial, newPassword: 'short' }).expect(400)
    const changed = await session.post('/api/auth/change-password').send({ currentPassword: initial, newPassword: password }).expect(200)
    assert.equal(changed.body.user.mustChangePassword, false)
    assert.notDeepEqual(changed.headers['set-cookie'], login.headers['set-cookie'])
    await session.get('/api/admin/users').expect(200)
    await other.get('/api/admin/users').expect(401)
    await client().post('/api/auth/login').send(username(initial)).expect(401)
    await session.post('/api/auth/change-password').send({ currentPassword: password, newPassword: password }).expect(400)
    await client().post('/api/auth/login').send(username(password)).expect(200)
  })

  it('denies anonymous and regular users, strips signup role injection, and keeps username signup closed', async () => {
    for (const path of ['/api/admin/users', '/api/admin/setup']) await client().get(path).expect(401)
    await client().post('/api/auth/signup').send({ ...username(password), setupCode: code, role: 'admin' }).expect(400)
    const session = client()
    const signed = await session.post('/api/auth/signup').send({ method: 'email', identifier: 'test@example.test', password: userPassword, setupCode: code, role: 'admin', disabled: false }).expect(201)
    assert.equal(signed.body.user.role, 'user')
    for (const path of ['/api/admin/users', '/api/admin/setup']) await session.get(path).expect(403)
    await session.post('/api/admin/setup/initialize').expect(403)
    await session.post(`/api/admin/users/${signed.body.user.id}/action`).send({ action: 'promote' }).expect(403)
  })

  it('lists only account metadata and never bypasses owner-scoped document access', async () => {
    const administrator = await admin(), owner = await user()
    const base = store.forUser(owner.id).addBase({ text, filename: 'private.pdf', pages: 1 }, Buffer.from('%PDF-private'))
    const listed = await administrator.session.get('/api/admin/users').expect(200)
    for (const account of listed.body.users) assert.deepEqual(Object.keys(account).sort(), ['createdAt', 'disabled', 'id', 'identifier', 'membershipEnrolled', 'membershipPoints', 'membershipTier', 'method', 'mustChangePassword', 'role'])
    const serialized = JSON.stringify(listed.body)
    for (const secret of [text, password, userPassword, code, 'password_hash']) assert.ok(!serialized.includes(secret))
    await administrator.session.get(`/api/base/${base.id}/pdf`).expect(404)
    await administrator.session.patch(`/api/base/${base.id}`).send({ text: text + ' edited' }).expect(404)
    assert.equal((await administrator.session.get('/api/workspace')).body.base, null)
  })

  it('lets only administrators change shared features and blocks disabled chat for every account', async () => {
    const administrator = await admin(), owner = await user()
    await client().get('/api/features').expect(401)
    await client().post('/api/features').send({ key: 'webChat', value: 'false' }).expect(401)
    await owner.session.post('/api/features').send({ key: 'webChat', value: 'false' }).expect(403)
    await owner.session.delete('/api/features/webChat').expect(403)
    assert.deepEqual((await owner.session.get('/api/features').expect(200)).body, { features: { webChat: true } })
    await administrator.session.post('/api/features').send({ key: 'webChat', value: 'false' }).expect(200)
    for (const session of [administrator.session, owner.session]) {
      assert.deepEqual((await session.get('/api/features').expect(200)).body, { features: { webChat: false } })
      await session.get('/api/chat/models').expect(403)
      await session.post('/api/chat').send({}).expect(403)
    }
    await owner.session.post('/api/features').send({ key: 'webChat', value: 'true' }).expect(403)
    await owner.session.delete('/api/features/webChat').expect(403)
    assert.equal(store.getFeature('webChat'), false)
    await administrator.session.post('/api/features').send({ key: 'webChat', value: 'true' }).expect(200)
    assert.equal((await owner.session.get('/api/features').expect(200)).body.features.webChat, true)
    await administrator.session.post('/api/features').send({ key: 'webChat', value: 'false' }).expect(200)
    await administrator.session.delete('/api/features/webChat').expect(200)
    assert.equal((await owner.session.get('/api/features').expect(200)).body.features.webChat, true)
  })

  it('disables and re-enables without losing documents, and revoked sessions never revive', async () => {
    const administrator = await admin(), owner = await user()
    const base = store.forUser(owner.id).addBase({ text, filename: 'private.pdf', pages: 1 }, Buffer.from('%PDF-private'))
    const endpoint = `/api/admin/users/${owner.id}/action`
    await administrator.session.post(endpoint).send({ action: 'disable' }).expect(204)
    await owner.session.get('/api/workspace').expect(401)
    const credentials = { method: 'email', identifier: 'person@example.test', password: userPassword }
    await client().post('/api/auth/login').send(credentials).expect(401)
    await administrator.session.post(endpoint).send({ action: 'enable' }).expect(204)
    await owner.session.get('/api/workspace').expect(401)
    await owner.session.post('/api/auth/login').send(credentials).expect(200)
    assert.equal((await owner.session.get('/api/workspace')).body.base.id, base.id)
    await administrator.session.post(endpoint).send({ action: 'revoke-sessions' }).expect(204)
    await owner.session.get('/api/workspace').expect(401)
  })

  it('resets passwords with forced change and prevents old credentials or sessions from working', async () => {
    const administrator = await admin(), owner = await user()
    const endpoint = `/api/admin/users/${owner.id}/action`
    await administrator.session.post(endpoint).send({ action: 'reset-password', password: 'short' }).expect(400)
    await administrator.session.post(endpoint).send({ action: 'reset-password', password: temporary }).expect(204)
    await owner.session.get('/api/workspace').expect(401)
    const credentials = { method: 'email', identifier: 'person@example.test', password: userPassword }
    await owner.session.post('/api/auth/login').send(credentials).expect(401)
    const login = await owner.session.post('/api/auth/login').send({ ...credentials, password: temporary }).expect(200)
    assert.equal(login.body.user.mustChangePassword, true)
    await owner.session.get('/api/workspace').expect(403)
    await owner.session.post('/api/auth/change-password').send({ currentPassword: temporary, newPassword: userPassword }).expect(200)
    await owner.session.get('/api/workspace').expect(200)
  })

  it('changes roles with session revocation and rejects self-lockout, malformed and stale-tab actions', async () => {
    const administrator = await admin(), owner = await user()
    const endpoint = `/api/admin/users/${owner.id}/action`
    await administrator.session.post(endpoint).set('X-Folio-User', owner.id).send({ action: 'disable' }).expect(401)
    await administrator.session.get('/api/admin/users').expect(200)
    await administrator.session.post(endpoint).set('X-Folio-Request', '').send({ action: 'promote' }).expect(403)
    await administrator.session.post(endpoint).send({ action: 'delete' }).expect(400)
    await administrator.session.post(endpoint).send({ action: 'promote', role: 'admin' }).expect(400)
    await administrator.session.post('/api/admin/users/missing/action').send({ action: 'disable' }).expect(404)
    for (const action of ['disable', 'demote', 'reset-password', 'revoke-sessions']) {
      await administrator.session.post(`/api/admin/users/${administrator.id}/action`).send({ action, ...(action === 'reset-password' ? { password: temporary } : {}) }).expect(400)
    }
    await administrator.session.post(endpoint).send({ action: 'promote' }).expect(204)
    await owner.session.get('/api/admin/users').expect(401)
    await owner.session.post('/api/auth/login').send({ method: 'email', identifier: 'person@example.test', password: userPassword }).expect(200)
    await owner.session.get('/api/admin/users').expect(200)
    await administrator.session.post(endpoint).send({ action: 'demote' }).expect(204)
    await owner.session.get('/api/admin/users').expect(401)
    await owner.session.post('/api/auth/login').send({ method: 'email', identifier: 'person@example.test', password: userPassword }).expect(200)
    await owner.session.get('/api/admin/users').expect(403)
  })

  it('initializes/rotates only pending setup, never returns its secret and never reopens a completed claim', async () => {
    const administrator = await admin()
    const setup = await administrator.session.get('/api/admin/setup').expect(200)
    assert.deepEqual(setup.body, { claimPending: true, initialized: true, available: true })
    const rotated = await administrator.session.post('/api/admin/setup/initialize').expect(200)
    const file = join(directory, 'account-setup-code')
    const next = readFileSync(file, 'utf8').trim()
    assert.notEqual(next, code); assert.equal(statSync(file).mode & 0o777, 0o600)
    assert.equal(store.db.prepare('SELECT code_hash FROM account_setup').get()!.code_hash, hashToken(next))
    assert.ok(!JSON.stringify(rotated.body).includes(next))
    await client().post('/api/auth/signup').send({ method: 'email', identifier: 'claim@example.test', password: userPassword, setupCode: code }).expect(403)
    code = next; await user()
    await administrator.session.post('/api/admin/setup/initialize').expect(409)
    prepareAccountSetup(store.db, directory)
    assert.equal(existsSync(file), false)
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM account_setup').get()!.n, 0)
  })

  it('rechecks administrator privileges after password hashing before committing a reset', async () => {
    const administrator = await admin(), owner = await user()
    const login = await administrator.session.post('/api/auth/login').send(username(password)).expect(200)
    const cookie = String(login.headers['set-cookie'][0]).split(';')[0]
    const before = store.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(owner.id)!.password_hash
    for (const [change, expected] of [['role', 403], ['disabled', 401]] as const) {
      store.db.prepare("UPDATE users SET role = 'admin', disabled = 0 WHERE id = ?").run(administrator.id)
      const server = createServer(app)
      // Node invokes request listeners in order. Express has started scrypt and
      // yielded; this listener changes access before the hash callback commits.
      server.on('request', () => {
        if (change === 'role') store.db.prepare("UPDATE users SET role = 'user' WHERE id = ?").run(administrator.id)
        else store.db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(administrator.id)
      })
      await request(server).post(`/api/admin/users/${owner.id}/action`).set('Cookie', cookie)
        .set('X-Folio-Request', '1').send({ action: 'reset-password', password: temporary }).expect(expected)
      assert.equal(store.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(owner.id)!.password_hash, before)
    }
  })

  it('migrates existing accounts as users and preserves administrator credentials across restarts', async () => {
    const file = join(directory, 'migration.sqlite')
    const old = new DatabaseSync(file)
    old.exec(`CREATE TABLE users(id TEXT PRIMARY KEY, method TEXT NOT NULL, identifier TEXT NOT NULL,
      password_hash TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(method, identifier));
      INSERT INTO users VALUES('legacy-user', 'email', 'legacy@example.test', 'disabled-test-hash', '2026-01-01');`)
    old.close()
    const migrated = createStore(file)
    try {
      assert.deepEqual({ ...migrated.db.prepare('SELECT role, disabled, must_change_password FROM users').get() }, { role: 'user', disabled: 0, must_change_password: 0 })
      await initializeAdministrator(migrated.db, initial)
      const before = migrated.db.prepare("SELECT password_hash FROM users WHERE method = 'username'").get()!.password_hash
      migrated.db.close()
      const reopened = createStore(file)
      try {
        await assert.rejects(initializeAdministrator(reopened.db, 'Other12345'), /already exists/)
        assert.equal(reopened.db.prepare("SELECT password_hash FROM users WHERE method = 'username'").get()!.password_hash, before)
      } finally { reopened.db.close() }
    } finally { if (migrated.db.isOpen) migrated.db.close() }
  })
})