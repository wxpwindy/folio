import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Express, Request, Response } from 'express'
import { parseCookie, stringifySetCookie } from 'cookie'
import { rateLimit } from 'express-rate-limit'
import type { Store as RateLimitStore } from 'express-rate-limit'
import { parsePhoneNumberFromString } from 'libphonenumber-js/max'
import { z } from 'zod'
import { AppError } from './ai.ts'

export interface AuthUser {
  id: string
  method: 'email' | 'phone' | 'username'
  identifier: string
  createdAt: string
  role: 'user' | 'admin'
  mustChangePassword: boolean
}

type UserRow = Omit<AuthUser, 'mustChangePassword'> & { mustChangePassword: number; password_hash: string; disabled: number }
const cookieName = 'folio_session'
const sessionSeconds = 7 * 24 * 60 * 60
const scryptOptions = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
const passwordSchema = z.string().min(12).max(128) // Never trim passwords.
const emailSchema = z.string().trim().toLowerCase().max(254).email()
const phoneSchema = z.string().trim().max(64).transform((value, context) => {
  const phone = value.startsWith('+') ? parsePhoneNumberFromString(value, { extract: false }) : undefined
  if (!phone?.isValid() || phone.ext) {
    context.addIssue({ code: 'custom', message: 'Enter a valid international phone number with + and country code.' })
    return z.NEVER
  }
  return phone.number
})
const credentialsSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('email'), identifier: emailSchema, password: passwordSchema }),
  z.object({ method: z.literal('phone'), identifier: phoneSchema, password: passwordSchema }),
])
const loginSchema = z.union([credentialsSchema, z.object({
  method: z.literal('username'), identifier: z.string().trim().toLowerCase().regex(/^[a-z0-9_-]{3,64}$/),
  // Only username bootstrap logins accept a shorter existing password. All
  // signup, password changes and admin resets retain the 12-character policy.
  password: z.string().min(10).max(128),
})])
const setupSchema = z.object({ setupCode: z.string().max(256).optional() })
const signupError = 'Unable to create this account. Try logging in or use another identifier.'
const loginError = 'Invalid sign-in details.'
const busyError = 'Too many authentication attempts. Please try again later.'

// Process-wide, with no unbounded waiting queue: each job can use roughly 32 MiB.
let activeHashJobs = 0
async function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  if (activeHashJobs >= 4) throw new AppError(429, busyError)
  activeHashJobs++
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, salt, 64, scryptOptions, (error, key) => {
        if (error) reject(error)
        else resolve(key)
      })
    })
  } finally { activeHashJobs-- }
}

/** Versioned fixed-cost encoding; salt and derived key are hexadecimal. */
export async function hashPassword(password: string): Promise<string> {
  passwordSchema.parse(password)
  return encodePassword(password)
}

async function encodePassword(password: string): Promise<string> {
  const salt = randomBytes(32)
  const key = await deriveKey(password, salt)
  return `scrypt$32768$8$1$${salt.toString('hex')}$${key.toString('hex')}`
}

/** Explicit local CLI only; never called by startup, signup, or a public API. */
export async function initializeAdministrator(db: DatabaseSync, password: string) {
  z.string().min(10).max(128).parse(password)
  const encoded = await encodePassword(password)
  db.exec('BEGIN IMMEDIATE')
  try {
    if (db.prepare("SELECT id FROM users WHERE role = 'admin' OR (method = 'username' AND identifier = 'wxpwindy')").get()) {
      throw new AppError(409, 'An administrator already exists. Initialization never resets an existing account.')
    }
    db.prepare(`INSERT INTO users(id, method, identifier, password_hash, created_at, role, must_change_password)
      VALUES (?, 'username', 'wxpwindy', ?, ?, 'admin', 1)`).run(randomUUID(), encoded, new Date().toISOString())
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
}

/** SHA-256 hex, used for both opaque session tokens and local setup codes. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

// Unknown users and damaged stored hashes still execute precisely one scrypt.
// This synthetic hash is never accepted and needs no startup hash job.
const dummySalt = randomBytes(32)
const dummyKey = randomBytes(64)
async function verifyPassword(password: string, encoded?: string): Promise<boolean> {
  const match = encoded?.match(/^scrypt\$32768\$8\$1\$([a-f0-9]{64})\$([a-f0-9]{128})$/)
  const salt = match ? Buffer.from(match[1], 'hex') : dummySalt
  const expected = match ? Buffer.from(match[2], 'hex') : dummyKey
  const actual = await deriveKey(password, salt)
  return timingSafeEqual(actual, expected) && Boolean(match)
}

function requestTokenHash(req: Request): string | null {
  try {
    const header = req.headers.cookie
    if (!header || header.length > 8192) return null
    // Reject ambiguous duplicate cookies rather than choosing an arbitrary one.
    if (header.split(';').filter(part => part.split('=', 1)[0].trim() === cookieName).length !== 1) return null
    const token = parseCookie(header, { decode: decodeURIComponent })[cookieName]
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null
    if (Buffer.from(token, 'base64url').toString('base64url') !== token) return null
    return hashToken(token)
  } catch { return null } // Malformed cookies are unauthenticated, never a 500.
}

function setSessionCookie(res: Response, token: string, expiresAt: number) {
  res.append('Set-Cookie', stringifySetCookie({
    name: cookieName, value: token, httpOnly: true, sameSite: 'strict', path: '/',
    maxAge: sessionSeconds, expires: new Date(expiresAt),
    // Deliberately not Secure: this app is restricted to loopback HTTP by its host.
    // HTTPS deployment would require Secure and a separate security review.
  }))
}

function publicUser(row: AuthUser | UserRow): AuthUser {
  return { id: row.id, method: row.method, identifier: row.identifier, createdAt: row.createdAt,
    role: row.role, mustChangePassword: Boolean(row.mustChangePassword) }
}

// A stale tab may share a newly rotated cookie with another account. This is
// only an expectation check: identity/ownership always comes from the session.
// Omission remains supported for direct API clients; empty/duplicate values fail.
function checkExpectedUser(req: Request, user: AuthUser | undefined) {
  const expected = req.get('X-Folio-User')
  if (expected !== undefined && (!user || expected !== user.id)) {
    throw new AppError(401, 'The account session changed. Log in again to continue.')
  }
}

/**
 * Install unconditionally AFTER Host/Origin, JSON parsing, and the application's
 * X-Folio-Request: 1 mutation guard, BEFORE every other /api route and error handler.
 * The caller creates the auth tables and nullable bases/versions.owner_id columns.
 * No schema, filesystem, environment, verification, or recovery side effects here.
 * Protected routes receive AuthUser in res.locals.user and must use store.forUser.
 * Session expiry is an absolute Unix timestamp in milliseconds (not sliding).
 */
export interface AuthRateLimitStores { auth: RateLimitStore; admin: RateLimitStore }

export function installAuth(app: Express, db: DatabaseSync, resetSetup?: () => void, rateLimitStores?: AuthRateLimitStores): void {
  // Bootstrap administrators must never consume the first ordinary account's
  // protected legacy claim. Public signup cannot create username accounts.
  const countUsers = db.prepare("SELECT COUNT(*) AS count FROM users WHERE method != 'username'")
  const getSetup = db.prepare('SELECT code_hash FROM account_setup WHERE id = 1')
  const columns = 'id, method, identifier, password_hash, created_at AS createdAt, role, disabled, must_change_password AS mustChangePassword'
  const findUser = db.prepare(`SELECT ${columns} FROM users WHERE method = ? AND identifier = ?`)
  const findById = db.prepare(`SELECT ${columns} FROM users WHERE id = ?`)
  const findSession = db.prepare(`SELECT u.id, u.method, u.identifier, u.created_at AS createdAt, u.role,
    u.must_change_password AS mustChangePassword FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0`)
  const prune = db.prepare('DELETE FROM sessions WHERE expires_at <= ?')
  const revoke = db.prepare('DELETE FROM sessions WHERE token_hash = ?')
  const insertSession = db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
  const firstAccount = () => (countUsers.get() as { count: number }).count === 0

  function requireSetup(code: string | undefined) {
    const setup = getSetup.get() as { code_hash: string } | undefined
    if (!setup || !/^[a-f0-9]{64}$/i.test(setup.code_hash)) {
      throw new AppError(503, 'Account setup is unavailable. Restore the local setup code before signing up.')
    }
    const matches = timingSafeEqual(Buffer.from(hashToken(code ?? ''), 'hex'), Buffer.from(setup.code_hash, 'hex'))
    if (!code || !matches) throw new AppError(403, 'A valid local setup code is required to create the first account.')
  }

  // No await is permitted inside this transaction, especially during first claim.
  function transaction<T>(work: () => T): T {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  function rotateSession(req: Request, userId: string) {
    const token = randomBytes(32).toString('base64url')
    const expiresAt = Date.now() + sessionSeconds * 1000
    const previousHash = requestTokenHash(req)
    if (previousHash) revoke.run(previousHash)
    insertSession.run(hashToken(token), userId, expiresAt)
    return { token, expiresAt }
  }

  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    prune.run(Date.now())
    next()
  })

  // One shared IP budget for signup AND login. Loopback clients necessarily share
  // this allowance. Use the library's default IPv6-aware key; never trust XFF here.
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false,
    store: rateLimitStores?.auth,
    handler: (_req, _res, next) => next(new AppError(429, busyError)),
  })
  const adminLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false,
    store: rateLimitStores?.admin,
    handler: (_req, _res, next) => next(new AppError(429, 'Too many administration actions. Please try again later.')),
  })

  app.get('/api/auth/session', (req, res) => {
    const tokenHash = requestTokenHash(req)
    const row = tokenHash ? findSession.get(tokenHash, Date.now()) as AuthUser | undefined : undefined
    checkExpectedUser(req, row)
    res.json({ user: row ? publicUser(row) : null, setupRequired: firstAccount() })
  })

  app.post('/api/auth/signup', authLimiter, async (req, res) => {
    const input = credentialsSchema.parse(req.body)
    const { setupCode } = setupSchema.parse(req.body)
    const initiallyFirst = firstAccount()
    // Reject a wrong/missing setup code before yielding: it must never turn into
    // an ordinary signup just because another caller claims setup concurrently.
    if (initiallyFirst) requireSetup(setupCode)
    const passwordHash = await hashPassword(input.password)
    const user: AuthUser = { id: randomUUID(), method: input.method, identifier: input.identifier, createdAt: new Date().toISOString(), role: 'user', mustChangePassword: false }
    const session = transaction(() => {
      const stillFirst = firstAccount()
      if (initiallyFirst !== stillFirst) {
        throw new AppError(409, 'Account setup changed. Try logging in or retry your request.')
      }
      if (stillFirst) requireSetup(setupCode)
      if (findUser.get(input.method, input.identifier)) throw new AppError(409, signupError)
      db.prepare('INSERT INTO users (id, method, identifier, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(user.id, user.method, user.identifier, passwordHash, user.createdAt)
      if (stillFirst) {
        db.prepare('UPDATE bases SET owner_id = ? WHERE owner_id IS NULL').run(user.id)
        db.prepare('UPDATE versions SET owner_id = ? WHERE owner_id IS NULL').run(user.id)
        db.exec('DELETE FROM account_setup')
      }
      return rotateSession(req, user.id)
    })
    setSessionCookie(res, session.token, session.expiresAt)
    res.status(201).json({ user, setupRequired: false })
  })

  app.post('/api/auth/login', authLimiter, async (req, res) => {
    const parsed = loginSchema.safeParse(req.body)
    if (!parsed.success) throw new AppError(400, loginError)
    const input = parsed.data
    const row = findUser.get(input.method, input.identifier) as UserRow | undefined
    const valid = await verifyPassword(input.password, row?.password_hash)
    if (!valid || !row) throw new AppError(401, loginError)
    // Re-read after scrypt: a concurrent disable/reset must not resurrect access.
    const current = findById.get(row.id) as UserRow | undefined
    if (!current || current.disabled || current.password_hash !== row.password_hash) throw new AppError(401, loginError)
    const session = transaction(() => rotateSession(req, current.id))
    setSessionCookie(res, session.token, session.expiresAt)
    res.json({ user: publicUser(current), setupRequired: firstAccount() })
  })

  app.post('/api/auth/logout', (req, res) => {
    const tokenHash = requestTokenHash(req)
    const row = tokenHash ? findSession.get(tokenHash, Date.now()) as AuthUser | undefined : undefined
    // Reject before revoking OR clearing the shared cookie belonging to a new user.
    checkExpectedUser(req, row)
    if (tokenHash) revoke.run(tokenHash)
    res.append('Set-Cookie', stringifySetCookie({
      name: cookieName, value: '', httpOnly: true, sameSite: 'strict', path: '/',
      maxAge: 0, expires: new Date(0),
    }))
    res.status(204).end()
  })

  // Mounted by prefix, not a list of known routes: unknown /api paths fail closed.
  app.use('/api', (req, res, next) => {
    const tokenHash = requestTokenHash(req)
    const row = tokenHash ? findSession.get(tokenHash, Date.now()) as AuthUser | undefined : undefined
    if (!row) throw new AppError(401, 'Log in to continue.')
    checkExpectedUser(req, row)
    res.locals.user = publicUser(row)
    next()
  })

  app.post('/api/auth/change-password', authLimiter, async (req, res) => {
    const input = z.object({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema }).strict().parse(req.body)
    const row = findById.get(res.locals.user.id) as UserRow
    if (!await verifyPassword(input.currentPassword, row.password_hash)) throw new AppError(400, 'The current password is incorrect.')
    if (input.currentPassword === input.newPassword) throw new AppError(400, 'Choose a different new password.')
    const encoded = await hashPassword(input.newPassword)
    requireCurrentSession(req)
    const session = transaction(() => {
      const current = findById.get(row.id) as UserRow
      if (current.password_hash !== row.password_hash) throw new AppError(409, 'The password changed. Log in again.')
      db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(encoded, row.id)
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id)
      return rotateSession(req, row.id)
    })
    setSessionCookie(res, session.token, session.expiresAt)
    res.json({ user: publicUser(findById.get(row.id) as UserRow), setupRequired: firstAccount() })
  })

  app.use('/api', (_req, res, next) => {
    if (res.locals.user.mustChangePassword) throw new AppError(403, 'Change your password before accessing the workspace or administration.')
    next()
  })

  function requireCurrentSession(req: Request, admin = false) {
    const tokenHash = requestTokenHash(req)
    const row = tokenHash ? findSession.get(tokenHash, Date.now()) as AuthUser | undefined : undefined
    if (!row) throw new AppError(401, 'Log in to continue.')
    checkExpectedUser(req, row)
    if (admin && (row.role !== 'admin' || row.mustChangePassword)) throw new AppError(403, 'Administrator access is required.')
    return row
  }
  app.use('/api/admin', (req, _res, next) => { requireCurrentSession(req, true); next() })
  app.get('/api/admin/users', (_req, res) => {
    const users = db.prepare(`SELECT ${columns} FROM users ORDER BY created_at, id`).all() as unknown as UserRow[]
    res.json({ users: users.map(row => ({ ...publicUser(row), disabled: Boolean(row.disabled) })) })
  })
  app.get('/api/admin/setup', (_req, res) => {
    res.json({ claimPending: firstAccount(), initialized: Boolean(getSetup.get()), available: Boolean(resetSetup) })
  })
  app.post('/api/admin/setup/initialize', adminLimiter, (_req, res) => {
    if (!firstAccount()) throw new AppError(409, 'First-account setup is complete. Existing document ownership cannot be reopened.')
    if (!resetSetup) throw new AppError(503, 'Setup initialization is unavailable in this server.')
    resetSetup()
    res.json({ claimPending: true, initialized: true, available: true })
  })
  app.post('/api/admin/users/:id/action', adminLimiter, async (req, res) => {
    const input = z.discriminatedUnion('action', [
      z.object({ action: z.enum(['enable', 'disable', 'revoke-sessions', 'promote', 'demote']) }).strict(),
      z.object({ action: z.literal('reset-password'), password: passwordSchema }).strict(),
    ]).parse(req.body)
    const id = z.string().min(1).max(128).parse(req.params.id)
    // No self-service lockout; use change-password for your own credentials.
    if (id === res.locals.user.id) throw new AppError(400, 'Use another administrator to manage this account. You cannot change your own role or access here.')
    if (!findById.get(id)) throw new AppError(404, 'Account not found.')
    const encoded = input.action === 'reset-password' ? await hashPassword(input.password) : undefined
    requireCurrentSession(req, true)
    transaction(() => {
      const target = findById.get(id) as UserRow | undefined
      if (!target) throw new AppError(404, 'Account not found.')
      if (target.role === 'admin' && !target.disabled && ['disable', 'demote'].includes(input.action)) {
        const remaining = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND disabled = 0 AND id != ?").get(id)!
        if (Number(remaining.count) === 0) throw new AppError(409, 'Keep at least one enabled administrator.')
      }
      if (input.action === 'enable' || input.action === 'disable') db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(input.action === 'disable' ? 1 : 0, id)
      if (input.action === 'promote' || input.action === 'demote') db.prepare('UPDATE users SET role = ? WHERE id = ?').run(input.action === 'promote' ? 'admin' : 'user', id)
      if (encoded) db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(encoded, id)
      // All account changes invalidate previous privilege/password/session state.
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id)
    })
    res.status(204).end()
  })
}