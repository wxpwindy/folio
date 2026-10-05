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
import { chatService, chatInputSchema, chatOutputSchema, chatModelsSchema } from './chat.ts'
import { installPipelineApi } from './pipeline-api.ts'
import type { PipelineService } from './pipeline.ts'

export function createApp(store: Store, generate: typeof generateResume = generateResume, translate: typeof translateDocument = translateDocument, resetSetup?: () => void, chat: typeof chatService = chatService, chatRateLimitStore?: RateLimitStore, authRateLimitStores?: AuthRateLimitStores, pipeline?: PipelineService) {
  const app = express()
  app.disable('x-powered-by')
  app.use((req, res, next) => {
    const host = req.hostname
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return res.status(403).json({ error: 'Only local access is allowed.' })
    const origin = req.headers.origin
    const permitted = new Set(['http://127.0.0.1:5173', 'http://localhost:5173', 'http://127.0.0.1:4173', 'http://localhost:4173', `http://${req.headers.host}`])
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
  app.get('/api/workspace', (_req, res) => {
    const store = res.locals.store as ReturnType<Store['forUser']>
    res.json({ base: store.base(), versions: store.versions(), config: {
      openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
      ollamaModel: process.env.OLLAMA_MODEL || 'llama3.2',
      openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    } })
  })
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
      res.status(201).json(store.addBase({ filename: req.file.originalname, text, pages: result.total }, req.file.buffer))
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
      res.status(201).json(store.addVersion({
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
      }))
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
    if (error instanceof multer.MulterError) { res.status(400).json({ error: 'Upload one PDF file, up to 10 MB.' }); return }
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