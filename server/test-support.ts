import request from 'supertest'
import { hashToken } from './auth.ts'
import { createStore } from './store.ts'
import type { Store } from './store.ts'

const testUserId = '00000000-0000-4000-8000-000000000010'
const sessionToken = Buffer.alloc(32, 7).toString('base64url')

/** Document-test fixtures only: use :memory: or a temporary test database. */
export function createTestStore(filename: string): Store {
  const root = createStore(filename)
  // Invalid password encoding deliberately disables password login. Requests
  // still authenticate through the real session lookup and production guards.
  // Reopening a disk fixture must preserve its existing user and session rows.
  root.db.prepare(`INSERT OR IGNORE INTO users (id, method, identifier, password_hash, created_at)
    VALUES (?, ?, ?, ?, ?)`).run(testUserId, 'email', 'document-tests@example.test',
    'disabled-test-password', '2026-01-01T00:00:00.000Z')
  root.db.prepare('INSERT OR IGNORE INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(hashToken(sessionToken), testUserId, Date.parse('9999-12-31T23:59:59.999Z'))

  const scope = root.forUser(testUserId)
  // Return this exact object to handlers so method spies and failure injection
  // observe the same scoped store used to seed and inspect document fixtures.
  return Object.assign(scope, {
    forUser: (id: string | null) => id === testUserId ? scope : root.forUser(id),
  })
}

/** Agent defaults cover every HTTP method without altering Supertest chains. */
export function authenticatedRequest(app: Parameters<typeof request>[0]) {
  return request.agent(app)
    .set('Cookie', `folio_session=${sessionToken}`)
    .set('X-Folio-Request', '1')
}