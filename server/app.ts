import express from 'express'
import type { ErrorRequestHandler } from 'express'
import multer from 'multer'
import { PDFParse } from 'pdf-parse'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { AppError, generateResume, generationSchema, outputSchema } from './ai.ts'
import type { Store } from './store.ts'
import { exportPdf } from './pdf.ts'
import { translateDocument, translationSchema, translationOutputSchema, translationLanguages } from './translation.ts'
import { installAuth } from './auth.ts'
import type { AuthRateLimitStores } from './auth.ts'
import { rateLimit } from 'express-rate-limit'
import type { Store as RateLimitStore } from 'express-rate-limit'
import { chatService, chatInputSchema, chatOutputSchema, chatModelsSchema, listChatModels } from './chat.ts'
import { installPipelineApi } from './pipeline-api.ts'
import type { PipelineService } from './pipeline.ts'
import { ollamaModels } from './ollama.ts'
import { extractJobDescription } from './job-description.ts'
import { cleanResume, cleanResumeSchema, cleanResumeOutputSchema, invalidCleanResumeMessage } from './clean-resume.ts'

const membershipSettingsSchema = z.object({
  basePoints: z.number().int().min(0).max(10000),
  factors: z.object({
    1: z.number().min(0).max(10),
    2: z.number().min(0).max(10),
    3: z.number().min(0).max(10),
    4: z.number().min(0).max(10),
  }).strict(),
}).strict()

const loyaltyEventType = z.union([z.literal('settings_updated'), z.literal('user_membership_updated')])

function writeLoyaltyEvent(db: Store['db'], event: {
  type: z.infer<typeof loyaltyEventType>
  actorUserId: string
  targetUserId?: string
  payload: Record<string, unknown>
}) {
  db.prepare(`INSERT INTO loyalty_events(event_type, actor_user_id, target_user_id, payload, created_at)
    VALUES (?, ?, ?, ?, ?)`)
    .run(event.type, event.actorUserId, event.targetUserId ?? null, JSON.stringify(event.payload), new Date().toISOString())
}

function listLoyaltyEvents(db: Store['db'], limit = 25) {
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit) || 25))
  const rows = db.prepare(`SELECT e.id, e.event_type AS eventType, e.created_at AS createdAt, e.payload,
      actor.identifier AS actorIdentifier, target.identifier AS targetIdentifier
    FROM loyalty_events e
    JOIN users actor ON actor.id = e.actor_user_id
    LEFT JOIN users target ON target.id = e.target_user_id
    ORDER BY e.created_at DESC, e.id DESC
    LIMIT ?`).all(safeLimit) as Array<{
      id: number
      eventType: 'settings_updated' | 'user_membership_updated'
      createdAt: string
      payload: string
      actorIdentifier: string
      targetIdentifier: string | null
    }>
  return rows.map(row => {
    let payload: unknown = {}
    try { payload = JSON.parse(row.payload) } catch { payload = {} }
    return {
      id: row.id,
      eventType: row.eventType,
      createdAt: row.createdAt,
      actorIdentifier: row.actorIdentifier,
      targetIdentifier: row.targetIdentifier,
      payload,
    }
  })
}

function getMembershipSettings(db: Store['db']) {
  db.prepare(`INSERT OR IGNORE INTO membership_settings(id, base_points, tier1_factor, tier2_factor, tier3_factor, tier4_factor)
    VALUES (1, 10, 1, 1.2, 1.3, 1.4)`).run()
  const row = db.prepare(`SELECT base_points AS basePoints, tier1_factor AS tier1,
    tier2_factor AS tier2, tier3_factor AS tier3, tier4_factor AS tier4
    FROM membership_settings WHERE id = 1`).get() as { basePoints: number; tier1: number; tier2: number; tier3: number; tier4: number }
  return { basePoints: row.basePoints, factors: { 1: row.tier1, 2: row.tier2, 3: row.tier3, 4: row.tier4 } }
}

function loyaltyProfile(db: Store['db'], userId: string) {
  const row = db.prepare(`SELECT membership_enrolled AS enrolled, membership_tier AS tier, membership_points AS points
    FROM users WHERE id = ?`).get(userId) as { enrolled: number; tier: number; points: number } | undefined
  if (!row) throw new AppError(404, 'Account not found.')
  return { enrolled: Boolean(row.enrolled), tier: row.tier as 1 | 2 | 3 | 4, points: row.points }
}

function awardMembershipPoints(db: Store['db'], userId: string, units = 1) {
  if (units <= 0) return 0
  const profile = loyaltyProfile(db, userId)
  if (!profile.enrolled) return 0
  const settings = getMembershipSettings(db)
  const factor = settings.factors[profile.tier]
  const perAction = Math.round(settings.basePoints * factor)
  const earned = Math.max(0, perAction * units)
  if (earned > 0) db.prepare('UPDATE users SET membership_points = membership_points + ? WHERE id = ?').run(earned, userId)
  return earned
}

export function createApp(store: Store, generate: typeof generateResume = generateResume, translate: typeof translateDocument = translateDocument, resetSetup?: () => void, chat: typeof chatService = chatService, chatRateLimitStore?: RateLimitStore, authRateLimitStores?: AuthRateLimitStores, pipeline?: PipelineService, clean: typeof cleanResume = cleanResume) {
  const app = express()
  app.disable('x-powered-by')
  app.use((req, res, next) => {
    const host = req.hostname
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return res.status(403).json({ error: 'Only local access is allowed.' })
    const origin = req.headers.origin
    const permitted = new Set(['http://127.0.0.1:5173', 'http://localhost:5173', 'http://127.0.0.1:4173', 'http://localhost:4173'])
    const currentHost = req.headers.host
    if (currentHost) {
      permitted.add(`http://${currentHost}`)
      permitted.add(`https://${currentHost}`)
    }
    if (origin && !permitted.has(origin)) return res.status(403).json({ error: 'Cross-origin requests are not allowed.' })
    if (req.path.startsWith('/api') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('X-Folio-Request') !== '1') {
      return res.status(403).json({ error: 'Missing request protection header. Reload Folio and try again.' })
    }
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store')
    next()
  })
  app.use(express.json({ limit: '1mb' }))
  installAuth(app, store.db, resetSetup, authRateLimitStores)
  installPipelineApi(app, pipeline)
  app.use('/api', (_req, res, next) => {
    res.locals.store = store.forUser(res.locals.user.id)
    next()
  })
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } })
  let activeChats = 0
  // Check webChat feature flag before any chat requests
  app.use('/api/chat', (req, res, next) => {
    const store = res.locals.store as ReturnType<Store['forUser']>
    if (!store.getFeature('webChat')) {
      return res.status(403).json({ error: 'Web chat is currently disabled by the administrator.' })
    }
    next()
  })
  app.use('/api/chat', rateLimit({ windowMs: 60000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false, store: chatRateLimitStore,
    message: { error: 'Too many chat requests. Wait a minute and retry.' } }))
  app.get('/api/chat/models', async (req, res) => {
    const result = chatModelsSchema.safeParse(await chat.models())
    if (!result.success) throw new AppError(502, 'Invalid model list from the chat service.')
    res.json(result.data)
  })
  app.post('/api/chat', async (req, res) => {
    const input = chatInputSchema.parse(req.body)
    if (activeChats >= 2) throw new AppError(409, 'The local chat model is busy. Wait for an answer and retry.')
    const controller = new AbortController()
    const abort = () => controller.abort()
    res.once('close', abort)
    activeChats++
    try {
      const result = chatOutputSchema.safeParse(await chat.answer(input, controller.signal))
      if (!result.success) throw new AppError(502, 'Invalid response from the chat service.')
      if (!controller.signal.aborted) res.json(result.data)
    } finally { activeChats--; res.off('close', abort) }
  })
  // Feature management endpoints
  app.get('/api/features', (req, res) => {
    const store = res.locals.store as ReturnType<Store['forUser']>
    const features: Record<string, boolean> = { webChat: store.getFeature('webChat') }
    res.json({ features })
  })
  app.post('/api/features', (req, res) => {
    if (res.locals.user.role !== 'admin') throw new AppError(403, 'Administrator access is required to change features.')
    const store = res.locals.store as ReturnType<Store['forUser']>
    const input = z.object({ key: z.enum(['webChat']).optional(), value: z.enum(['true', 'false']).optional() }).strict().parse(req.body)
    if (!input.key || !input.value) {
      throw new AppError(400, 'Must provide key and value.')
    }
    store.setFeature(input.key, input.value === 'true')
    res.json({ features: { webChat: store.getFeature('webChat') } })
  })
  app.delete('/api/features/webChat', (req, res) => {
    if (res.locals.user.role !== 'admin') throw new AppError(403, 'Administrator access is required to change features.')
    const store = res.locals.store as ReturnType<Store['forUser']>
    store.db.prepare('DELETE FROM features WHERE key = ?').run('webChat')
    res.json({ deleted: 'webChat' })
  })
  app.get('/api/ollama/models', async (_req, res) => {
    res.json(await ollamaModels())
  })
  app.get('/api/lmstudio/models', async (_req, res) => {
    const { models } = await listChatModels()
    res.json({ models })
  })
  app.post('/api/job-description/extract', upload.single('document'), async (req, res) => {
    if (!req.file) throw new AppError(400, 'Upload one PDF or UTF-8 text file, up to 10 MB.')
    res.json({ text: await extractJobDescription(req.file.buffer, req.file.originalname) })
  })
  app.get('/api/workspace', (_req, res) => {
    const store = res.locals.store as ReturnType<Store['forUser']>
    res.json({ base: store.base(), versions: store.versions(), config: {
      openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
      ollamaModel: process.env.OLLAMA_MODEL || 'llama3.2',
      openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      lmstudioModel: process.env.LMSTUDIO_MODEL || 'google/gemma-4-e4b',
      defaultProvider: process.env.FOLIO_AI_PROVIDER === 'lmstudio' ? 'lmstudio' : 'ollama',
    } })
  })
  const loyaltyMeGet = (_req: express.Request, res: express.Response) => {
    const store = res.locals.store as ReturnType<Store['forUser']>
    const userId = res.locals.user.id as string
    res.json({ profile: loyaltyProfile(store.db, userId), settings: getMembershipSettings(store.db) })
  }
  const loyaltyMePatch = (req: express.Request, res: express.Response) => {
    const store = res.locals.store as ReturnType<Store['forUser']>
    const userId = res.locals.user.id as string
    const { enrolled } = z.object({ enrolled: z.boolean() }).strict().parse(req.body)
    store.db.prepare('UPDATE users SET membership_enrolled = ? WHERE id = ?').run(enrolled ? 1 : 0, userId)
    res.json({ profile: loyaltyProfile(store.db, userId), settings: getMembershipSettings(store.db) })
  }
  const loyaltySettingsGet = (_req: express.Request, res: express.Response) => {
    if (res.locals.user.role !== 'admin') throw new AppError(403, 'Administrator access is required to manage loyalty settings.')
    const store = res.locals.store as ReturnType<Store['forUser']>
    res.json(getMembershipSettings(store.db))
  }
  const loyaltySettingsPatch = (req: express.Request, res: express.Response) => {
    if (res.locals.user.role !== 'admin') throw new AppError(403, 'Administrator access is required to manage loyalty settings.')
    const store = res.locals.store as ReturnType<Store['forUser']>
    const parsed = membershipSettingsSchema.parse(req.body)
    store.db.prepare(`UPDATE membership_settings
      SET base_points = ?, tier1_factor = ?, tier2_factor = ?, tier3_factor = ?, tier4_factor = ?
      WHERE id = 1`).run(parsed.basePoints, parsed.factors[1], parsed.factors[2], parsed.factors[3], parsed.factors[4])
    writeLoyaltyEvent(store.db, {
      type: 'settings_updated',
      actorUserId: res.locals.user.id as string,
      payload: {
        basePoints: parsed.basePoints,
        factors: parsed.factors,
      },
    })
    res.json(getMembershipSettings(store.db))
  }
  const loyaltyEventsGet = (req: express.Request, res: express.Response) => {
    if (res.locals.user.role !== 'admin') throw new AppError(403, 'Administrator access is required to view loyalty activity.')
    const store = res.locals.store as ReturnType<Store['forUser']>
    const limit = z.coerce.number().int().min(1).max(100).optional().parse(req.query.limit)
    res.json({ events: listLoyaltyEvents(store.db, limit) })
  }
  const userLoyaltyPatch = (req: express.Request, res: express.Response) => {
    if (res.locals.user.role !== 'admin') throw new AppError(403, 'Administrator access is required to manage user loyalty levels.')
    const store = res.locals.store as ReturnType<Store['forUser']>
    const id = z.string().uuid().parse(req.params.id)
    const payload = z.object({ tier: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]), enrolled: z.boolean().optional() }).strict().parse(req.body)
    const row = store.db.prepare('SELECT id FROM users WHERE id = ?').get(id) as { id: string } | undefined
    if (!row) throw new AppError(404, 'Account not found.')
    if (payload.enrolled === undefined) {
      store.db.prepare('UPDATE users SET membership_tier = ? WHERE id = ?').run(payload.tier, id)
    } else {
      store.db.prepare('UPDATE users SET membership_tier = ?, membership_enrolled = ? WHERE id = ?').run(payload.tier, payload.enrolled ? 1 : 0, id)
    }
    writeLoyaltyEvent(store.db, {
      type: 'user_membership_updated',
      actorUserId: res.locals.user.id as string,
      targetUserId: id,
      payload: {
        tier: payload.tier,
        enrolled: payload.enrolled,
      },
    })
    res.status(204).end()
  }
  app.get('/api/loyalty/me', loyaltyMeGet)
  app.patch('/api/loyalty/me', loyaltyMePatch)
  app.get('/api/admin/loyalty/settings', loyaltySettingsGet)
  app.patch('/api/admin/loyalty/settings', loyaltySettingsPatch)
  app.get('/api/admin/loyalty/events', loyaltyEventsGet)
  app.patch('/api/admin/users/:id/loyalty', userLoyaltyPatch)
  // Compatibility aliases for older/stale clients still using "membership" paths.
  app.get('/api/membership/me', loyaltyMeGet)
  app.patch('/api/membership/me', loyaltyMePatch)
  app.get('/api/admin/membership/settings', loyaltySettingsGet)
  app.patch('/api/admin/membership/settings', loyaltySettingsPatch)
  app.get('/api/admin/membership/events', loyaltyEventsGet)
  app.patch('/api/admin/users/:id/membership', userLoyaltyPatch)
  app.post('/api/base', upload.single('resume'), async (req, res) => {
    const store = res.locals.store as ReturnType<Store['forUser']>
    if (!req.file || req.file.buffer.subarray(0, 5).toString() !== '%PDF-') throw new AppError(400, 'Upload a valid PDF file (up to 10 MB).')
    const parser = new PDFParse({ data: new Uint8Array(req.file.buffer) })
    try {
      const result = await parser.getText({ pageJoiner: '\n' })
      const text = result.text.trim()
      if (text.length < 50) {
        throw new AppError(400, 'This PDF has too little selectable text. Scanned PDFs need OCR first. Export a text-based PDF and try again.')
      }
      if (text.length > 50000 || result.total > 30) throw new AppError(400, 'This resume is too long. Use a PDF under 30 pages and 50,000 characters.')
      const created = store.addBase({ filename: req.file.originalname, text, pages: result.total }, req.file.buffer)
      awardMembershipPoints(store.db, res.locals.user.id as string)
      res.status(201).json(created)
    } catch (error) {
      if (error instanceof AppError) throw error
      throw new AppError(400, 'This PDF could not be read. It may be damaged or password protected. Try exporting it again.')
    } finally { await parser.destroy() }
  })
  app.patch('/api/base/:id', (req, res) => {
    const store = res.locals.store as ReturnType<Store['forUser']>
    const { text } = z.object({ text: z.string().trim().min(50).max(50000) }).parse(req.body)
    const base = store.updateBase(String(req.params.id), text)
    if (!base) throw new AppError(404, 'Base resume not found.')
    awardMembershipPoints(store.db, res.locals.user.id as string)
    res.json(base)
  })
  app.get('/api/base/:id/pdf', (req, res) => {
    const store = res.locals.store as ReturnType<Store['forUser']>
    const pdf = store.pdf(String(req.params.id))
    if (!pdf) throw new AppError(404, 'Original PDF not found.')
    res.setHeader('Content-Disposition', 'attachment; filename="base-resume.pdf"')
    res.type('pdf').send(Buffer.from(pdf))
  })
  let generating = false
  app.post('/api/base/clean', async (req, res) => {
    const store = res.locals.store as ReturnType<Store['forUser']>
    const input = cleanResumeSchema.parse(req.body)
    const base = store.base(input.baseId)
    if (!base) throw new AppError(404, 'Base resume not found.')
    if (generating) throw new AppError(409, 'Another document is being generated. Wait for it to finish.')
    // Read once so both drafts retain the same saved source, even across tab edits.
    generating = true
    try {
      const result = cleanResumeOutputSchema.safeParse(await clean(input, base.text))
      if (!result.success) throw new AppError(502, invalidCleanResumeMessage)
      const shared = {
        baseId: base.id, baseText: base.text, role: 'Clean base resume',
        company: base.filename.replace(/\.pdf$/i, '').trim().slice(0, 150) || 'Base resume',
        jobDescription: '', documentType: 'resume' as const, cleanBase: true,
        generationId: randomUUID(), provider: input.provider, model: input.model,
        summary: 'Cleaned formatting and wording from the saved base resume, without job tailoring. Compare both languages against the base snapshot and check every fact before use.',
        keywords: [], gaps: [],
      }
      const versions = store.addVersions([
        { ...shared, language: translationLanguages.en, text: result.data.englishText },
        { ...shared, language: translationLanguages['zh-Hans'], text: result.data.chineseText },
      ])
      awardMembershipPoints(store.db, res.locals.user.id as string, versions.length)
      res.status(201).json({ versions })
    } finally { generating = false }
  })
  app.post('/api/translations', async (req, res) => {
    const store = res.locals.store as ReturnType<Store['forUser']>
    const input = translationSchema.parse(req.body)
    const sourceVersion = input.sourceType === 'version' ? store.version(input.sourceId) : null
    const sourceBase = input.sourceType === 'base' ? store.base(input.sourceId) : null
    if (!sourceVersion && !sourceBase) throw new AppError(404, 'The document to translate was not found.')
    if (generating) throw new AppError(409, 'Another document is being generated. Wait for it to finish.')
    // Capture saved text before awaiting AI. Later edits/replacement/deletion
    // cannot mutate the exact source or original base snapshot of this draft.
    const sourceText = (sourceVersion || sourceBase)!.text
    const documentType = sourceVersion?.documentType ?? 'resume'
    generating = true
    try {
      const result = translationOutputSchema.safeParse(await translate(input, sourceText, documentType))
      if (!result.success) throw new AppError(502, 'The model returned an incomplete or invalid translation. Nothing was saved. Try again or choose another model.')
      const language = translationLanguages[input.targetLanguage]
      const created = store.addVersion({
        baseId: sourceVersion ? sourceVersion.baseId : sourceBase!.id,
        baseText: sourceVersion ? sourceVersion.baseText : sourceText,
        role: sourceVersion ? sourceVersion.role : 'Base resume',
        company: sourceVersion ? sourceVersion.company : (sourceBase!.filename.replace(/\.pdf$/i, '').trim().slice(0, 150) || 'Base resume'),
        jobDescription: sourceVersion ? sourceVersion.jobDescription : '',
        documentType, language, generationId: randomUUID(),
        text: result.data.text,
        summary: `Translated the saved document into ${language.name}. This is a translation, not new job tailoring. Review completeness and accuracy against the translation source before use.`,
        keywords: [], gaps: [], provider: input.provider, model: input.model,
        translation: { sourceType: input.sourceType, sourceId: input.sourceId, sourceText },
      })
      awardMembershipPoints(store.db, res.locals.user.id as string)
      res.status(201).json(created)
    } finally { generating = false }
  })
  app.post('/api/versions', async (req, res) => {
    const store = res.locals.store as ReturnType<Store['forUser']>
    const input = generationSchema.parse(req.body)
    const base = store.base(input.baseId)
    if (!base) throw new AppError(404, 'Upload a base resume first.')
    if (generating) throw new AppError(409, 'Another document is being generated. Wait for it to finish.')
    generating = true
    try {
      const parsed = outputSchema.safeParse(await generate(input, base.text))
      if (!parsed.success) throw new AppError(502, 'The model returned an incomplete language pair. Nothing was saved. Please try again.')
      const result = parsed.data
      const shared = {
        baseId: base.id, baseText: base.text,
        role: input.role, company: input.company, jobDescription: input.jobDescription,
        provider: input.provider, model: input.model,
        documentType: input.documentType ?? 'resume' as const,
        generationId: randomUUID(),
      }
      const drafts = [{ ...shared, language: result.language, text: result.resumeText,
        summary: result.summary, keywords: result.keywords, gaps: result.gaps }]
      if (result.englishVersion) {
        const english = result.englishVersion
        drafts.push({ ...shared, language: { code: 'en', name: 'English' }, text: english.resumeText,
          summary: english.summary, keywords: english.keywords, gaps: english.gaps })
      }
      const [version, ...additionalVersions] = store.addVersions(drafts)
      awardMembershipPoints(store.db, res.locals.user.id as string, drafts.length)
      res.status(201).json(additionalVersions.length ? { ...version, additionalVersions } : version)
    } finally { generating = false }
  })
  app.patch('/api/versions/:id', (req, res) => {
    const store = res.locals.store as ReturnType<Store['forUser']>
    const patch = z.object({
      role: z.string().trim().min(1).max(150), company: z.string().trim().min(1).max(150),
      text: z.string().trim().min(50).max(50000), status: z.enum(['draft', 'ready', 'applied']),
    }).parse(req.body)
    const version = store.updateVersion(String(req.params.id), patch)
    if (!version) throw new AppError(404, 'Resume version not found.')
    awardMembershipPoints(store.db, res.locals.user.id as string)
    res.json(version)
  })
  app.delete('/api/versions/:id', (req, res) => {
    const store = res.locals.store as ReturnType<Store['forUser']>
    if (!store.deleteVersion(String(req.params.id))) throw new AppError(404, 'Resume version not found.')
    res.status(204).end()
  })
  app.get('/api/versions/:id/pdf', async (req, res) => {
    const store = res.locals.store as ReturnType<Store['forUser']>
    const version = store.version(String(req.params.id))
    if (!version) throw new AppError(404, 'Resume version not found.')
    const filename = `${version.company}-${version.role}`.replace(/[^a-z0-9-]/gi, '-').slice(0, 100)
      + (version.documentType === 'cover-letter' ? '-cover-letter' : '')
      + (version.language ? `-${version.language.code}` : '')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`)
    res.type('pdf').send(await exportPdf(version.text, `${version.role} — ${version.company}${version.documentType === 'cover-letter' ? ' — Cover letter' : ''}`, version.documentType))
  })
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint not found.' }))
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof z.ZodError) { res.status(400).json({ error: error.issues[0]?.message || 'Invalid input.' }); return }
    if (error instanceof multer.MulterError) { res.status(400).json({ error: _req.path === '/api/job-description/extract' ? 'Upload one PDF or UTF-8 text file, up to 10 MB.' : 'Upload one PDF file, up to 10 MB.' }); return }
    if (error instanceof AppError) { res.status(error.status).json({ error: error.message }); return }
    if (error.type === 'entity.too.large') { res.status(413).json({ error: 'Request is too large.' }); return }
    if (error instanceof SyntaxError) { res.status(400).json({ error: 'Invalid JSON request.' }); return }
    // Never log request bodies, resumes, or API keys.
    console.error('Request failed:', error instanceof Error ? error.name : 'Unknown error')
    res.status(500).json({ error: 'Something went wrong on the local server. Please try again.' })
  }
  app.use(errors)
  return app
}