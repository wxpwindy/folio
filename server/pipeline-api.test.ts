import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import request from 'supertest'
import { createApp } from './app.ts'
import { createTestStore, authenticatedRequest } from './test-support.ts'
import { FakePipeline } from '../tests/pipeline-fixture.ts'

describe('pipeline API authorization', () => {
  let store: ReturnType<typeof createTestStore>
  let app: ReturnType<typeof createApp>
  let pipeline: FakePipeline
  beforeEach(() => {
    store = createTestStore(':memory:'); pipeline = new FakePipeline()
    app = createApp(store, undefined, undefined, undefined, undefined, undefined, undefined, pipeline)
  })
  afterEach(() => store.db.close())
  const promote = () => store.db.prepare("UPDATE users SET role = 'admin'").run()
  it('denies anonymous, ordinary, forced-password and stale-tab access', async () => {
    await request(app).get('/api/admin/pipeline').expect(401)
    await authenticatedRequest(app).get('/api/admin/pipeline').expect(403)
    await authenticatedRequest(app).post('/api/admin/pipeline/runs').send({}).expect(403)
    promote()
    store.db.prepare('UPDATE users SET must_change_password = 1').run()
    await authenticatedRequest(app).get('/api/admin/pipeline').expect(403)
    store.db.prepare('UPDATE users SET must_change_password = 0').run()
    await authenticatedRequest(app).post('/api/admin/pipeline/runs').set('X-Folio-User', 'another-account').send({}).expect(401)
    assert.equal(pipeline.snapshot().runs.length, 0)
  })
  it('enforces local headers, strict request bodies and fixed actions', async () => {
    promote()
    await authenticatedRequest(app).post('/api/admin/pipeline/runs').unset('X-Folio-Request').send({}).expect(403)
    await authenticatedRequest(app).post('/api/admin/pipeline/runs').set('Origin', 'https://example.com').send({}).expect(403)
    await authenticatedRequest(app).get('/api/admin/pipeline').set('Host', 'evil.example').expect(403)
    await authenticatedRequest(app).post('/api/admin/pipeline/runs').send({ command: 'arbitrary shell', cwd: '/tmp' }).expect(400)
    await authenticatedRequest(app).post('/api/admin/pipeline/runs/not-valid/deploy').send({}).expect(400)
    assert.equal(pipeline.snapshot().runs.length, 0)
  })
  it('allows admin lifecycle controls and rechecks revoked privileges', async () => {
    promote()
    const client = authenticatedRequest(app)
    const first = await client.post('/api/admin/pipeline/runs').send({}).expect(202)
    await client.post('/api/admin/pipeline/runs').send({}).expect(409)
    await client.post(`/api/admin/pipeline/runs/${first.body.id}/deploy`).send({}).expect(409)
    pipeline.complete()
    await client.post(`/api/admin/pipeline/runs/${first.body.id}/deploy`).send({}).expect(200)
    const second = await client.post('/api/admin/pipeline/runs').send({}).expect(202)
    pipeline.complete()
    await client.post(`/api/admin/pipeline/runs/${second.body.id}/deploy`).send({}).expect(200)
    await client.post('/api/admin/pipeline/rollback').send({}).expect(200)
    const current = await client.get('/api/admin/pipeline').expect(200)
    assert.equal(current.body.activeRelease, first.body.id)
    const third = await client.post('/api/admin/pipeline/runs').send({}).expect(202)
    await client.post(`/api/admin/pipeline/runs/${third.body.id}/cancel`).send({}).expect(200)
    assert.equal(pipeline.snapshot().runs[0].status, 'cancelled')
    store.db.prepare("UPDATE users SET role = 'user'").run()
    await client.get('/api/admin/pipeline').expect(403)
    assert.equal(store.base(), null)
  })
  it('reports unconfigured servers without adding a production bypass', async () => {
    promote(); app = createApp(store)
    const response = await authenticatedRequest(app).get('/api/admin/pipeline').expect(200)
    assert.equal(response.body.available, false)
    await authenticatedRequest(app).post('/api/admin/pipeline/runs').send({}).expect(503)
  })
})