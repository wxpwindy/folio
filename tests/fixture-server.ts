import express from 'express'
import { MemoryStore } from 'express-rate-limit'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { parseCookie, stringifySetCookie } from 'cookie'
import { createApp } from '../server/app.ts'
import { createStore } from '../server/store.ts'
import { hashPassword, hashToken, initializeAdministrator } from '../server/auth.ts'
import { exportPdf } from '../server/pdf.ts'
import type { generateResume } from '../server/ai.ts'
import { outputSchema } from '../server/ai.ts'
import type { translateDocument } from '../server/translation.ts'
import { chineseLetterTranslationText, chineseTranslationText, englishLetterText, englishPairedText, frenchGap, frenchJobDescription, frenchLetterSummary, frenchLetterText, frenchResumeText, frenchSummary, gap, jobDescription, letterSummary, originalText, summary } from './data.ts'
import { FakePipeline } from './pipeline-fixture.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const dist = fileURLToPath(new URL('../dist/', import.meta.url))
if (!existsSync(`${dist}/index.html`)) execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' })

// Defense in depth: accidental production generation/translation cannot reach a provider.
globalThis.fetch = async () => { throw new Error('Outbound fetch is forbidden in the E2E fixture') }
delete process.env.OPENAI_API_KEY
process.env.OLLAMA_MODEL = 'e2e-local-model'
process.env.OPENAI_MODEL = 'e2e-cloud-model'
const store = createStore(':memory:')
// Fictional fixture contract, mirrored in helpers.ts. Never read DATA_DIR or the
// real setup-code file. Hash once; ordinary tests do not consume the auth limiter.
const defaultUserId = 'e2e-default-user'
const defaultIdentifier = 'alex@example.test'
const passwordHash = await hashPassword('Fictional-password-2026!')
const setupCode = 'e2e-setup-code-fictional-only-not-a-secret'
const legacyPdf = await exportPdf(originalText, 'Fictional legacy resume')
function addLegacy(scope: ReturnType<typeof store.forUser>) {
  const base = scope.base()
  if (!base) return null
  return scope.addVersion({
    baseId: base.id, baseText: base.text, role: 'Frontend Engineer', company: 'Example Labs',
    jobDescription, text: base.text, summary, keywords: ['TypeScript', 'React'], gaps: [gap],
    provider: 'ollama', model: 'e2e-legacy-model',
  })
}
function sessionHash(cookie: string | undefined) {
  const token = parseCookie(cookie ?? '').folio_session
  return token ? hashToken(token) : ''
}
const generate: typeof generateResume = async (input, baseText) => outputSchema.parse(input.jobDescription === frenchJobDescription ? {
  language: { code: 'fr', name: 'French' },
  resumeText: input.documentType === 'cover-letter' ? frenchLetterText : frenchResumeText,
  summary: input.documentType === 'cover-letter' ? frenchLetterSummary : frenchSummary,
  keywords: ['TypeScript', 'React', 'accessibilité'],
  gaps: [frenchGap],
  englishVersion: {
    resumeText: input.documentType === 'cover-letter' ? englishLetterText : englishPairedText,
    summary: input.documentType === 'cover-letter' ? letterSummary : summary,
    keywords: ['TypeScript', 'React', 'accessibility'],
    gaps: [gap],
  },
} : {
  language: { code: 'en', name: 'English' },
  resumeText: input.documentType === 'cover-letter' ? englishLetterText : `${baseText}\n\nROLE FOCUS\nTypeScript, React, accessibility, and automated testing.`,
  summary: input.documentType === 'cover-letter' ? letterSummary : summary,
  keywords: ['TypeScript', 'React', 'accessibility'],
  gaps: [gap],
  englishVersion: null,
})
const translate: typeof translateDocument = async (input, sourceText, documentType = 'resume') => {
  const text = input.targetLanguage === 'zh-Hans'
    ? (documentType === 'cover-letter' ? chineseLetterTranslationText : chineseTranslationText)
    : (documentType === 'cover-letter' ? englishLetterText : originalText)
  // Keep synthetic user-edit tokens from the actual server-selected source,
  // making a stale/base-text translation observable without logging documents.
  const markers = [...new Set(sourceText.match(/E2E-SAVED-[A-Z0-9-]+/g) ?? [])]
  return { text: [text, ...markers].join('\n') }
}
const chatRateLimitStore = new MemoryStore()
const authRateLimitStores = { auth: new MemoryStore(), admin: new MemoryStore() }
const pipeline = new FakePipeline()
const app = createApp(store, generate, translate, () => {
  store.db.prepare('INSERT INTO account_setup(id, code_hash) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET code_hash = excluded.code_hash')
    .run(hashToken('e2e-rotated-setup-code-fictional-only'))
}, {
  models: async () => ({ models: ['fictional-local-chat'], searchProvider: 'DuckDuckGo' }),
  answer: async input => ({ model: input.model, content: input.webSearch ? 'A fictional answer combining three search results [1], [2], and [3].' : `A fictional local answer to: ${input.messages.at(-1)!.content}`,
    searchQuery: input.webSearch ? 'fictional automatically extracted research' : null,
    sources: input.webSearch ? [
      { title: 'Example research source', url: 'https://example.com/research', snippet: 'Synthetic search evidence for browser tests.' },
      { title: 'Second research source', url: 'https://example.com/research-two', snippet: 'Second ranked synthetic result.' },
      { title: 'Third research source', url: 'https://example.com/research-three', snippet: 'Third ranked synthetic result.' },
    ] : [] }),
  }, chatRateLimitStore, authRateLimitStores, pipeline)
// These utilities exist ONLY on this isolated loopback/in-memory fixture. They
// never disable or replace production auth, ownership checks, or rate limiting.
app.use('/__test', (req, res, next) => {
  if (req.get('X-Folio-Request') !== '1') { res.sendStatus(403); return }
  next()
})
app.post('/__test/admin-bootstrap', async (_req, res) => {
  // Local memory fixture only; same one-time hash/role bootstrap as the CLI.
  await initializeAdministrator(store.db, 'Example123')
  res.sendStatus(204)
})
app.post('/__test/reset', (req, res) => {
  pipeline.reset()
  // Reset only this fixture's injected in-memory limiter between isolated tests.
  chatRateLimitStore.resetAll()
  authRateLimitStores.auth.resetAll()
  authRateLimitStores.admin.resetAll()
  const anonymous = req.body?.anonymous === true
  const legacy = req.body?.legacy === true
  if (legacy && !anonymous) { res.sendStatus(400); return }
  const token = randomBytes(32).toString('base64url')
  const seconds = 7 * 24 * 60 * 60
  const expiresAt = Date.now() + seconds * 1000
  store.db.exec('BEGIN IMMEDIATE')
  try {
    store.db.exec('DELETE FROM versions; DELETE FROM bases; DELETE FROM sessions; DELETE FROM users; DELETE FROM account_setup; DELETE FROM features;')
    store.db.prepare('INSERT INTO account_setup (id, code_hash) VALUES (1, ?)').run(hashToken(setupCode))
    if (anonymous) {
      if (legacy) {
        store.addBase({ filename: 'legacy-resume.pdf', text: originalText, pages: 1 }, legacyPdf)
        addLegacy(store)
      }
    } else {
      store.db.prepare('INSERT INTO users (id, method, identifier, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(defaultUserId, 'email', defaultIdentifier, passwordHash, new Date().toISOString())
      store.db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
        .run(hashToken(token), defaultUserId, expiresAt)
      store.db.exec('DELETE FROM account_setup')
    }
    store.db.exec('COMMIT')
  } catch (error) { store.db.exec('ROLLBACK'); throw error }
  res.setHeader('Set-Cookie', stringifySetCookie({
    name: 'folio_session', value: anonymous ? '' : token, httpOnly: true, sameSite: 'strict', path: '/',
    maxAge: anonymous ? 0 : seconds, expires: new Date(anonymous ? 0 : expiresAt),
  }))
  res.sendStatus(204)
})
// Seed a historical document without language/generation metadata, bypassing
// generation only in this in-memory fixture. The production API has no seed route.
app.post('/__test/legacy', (req, res) => {
  const session = store.db.prepare('SELECT s.user_id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?')
    .get(sessionHash(req.headers.cookie), Date.now())
  if (!session) { res.sendStatus(401); return }
  const version = addLegacy(store.forUser(String(session.user_id)))
  if (!version) { res.sendStatus(409); return }
  res.status(201).json(version)
})
app.post('/__test/expire-session', (req, res) => {
  const result = store.db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ? AND expires_at > ?')
    .run(Date.now() - 1, sessionHash(req.headers.cookie), Date.now())
  res.sendStatus(result.changes ? 204 : 401)
})
app.post('/__test/pipeline-complete', (req, res) => { pipeline.complete(req.body?.fail === true); res.json({ ok: true }) })
if (/^[a-f0-9-]{36}$/.test(process.env.FOLIO_CI_RELEASE_ID ?? '')) {
  app.use(`/releases/${process.env.FOLIO_CI_RELEASE_ID}`, express.static(dist))
}
app.use(express.static(dist))
const server = app.listen(3101, '127.0.0.1', () => console.log('E2E fixture: http://127.0.0.1:3101 (memory DB, fake AI)'))
function shutdown() {
  server.close(() => { store.db.close(); process.exit(0) })
}
process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)