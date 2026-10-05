import type { Express } from 'express'
import { rateLimit } from 'express-rate-limit'
import { z } from 'zod'
import { AppError } from './ai.ts'
import type { PipelineService } from './pipeline.ts'

/** Mounted after installAuth: /api/admin inherits current-session and admin checks. */
export function installPipelineApi(app: Express, pipeline?: PipelineService) {
  const service = () => { if (!pipeline) throw new AppError(503, 'The local pipeline is not configured in this server.'); return pipeline }
  const empty = z.object({}).strict()
  const id = z.string().uuid()
  const mutationLimiter = rateLimit({ windowMs: 60_000, limit: 12, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'Too many pipeline actions. Wait a minute and retry.' } })
  app.get('/api/admin/pipeline', (_req, res) => res.json(pipeline?.snapshot() ?? { available: false, busy: false, canCancel: false, runs: [], activeRelease: null, previousRelease: null }))
  app.post('/api/admin/pipeline/runs', mutationLimiter, (req, res) => { empty.parse(req.body); res.status(202).json(service().start()) })
  app.post('/api/admin/pipeline/runs/:id/cancel', mutationLimiter, (req, res) => { empty.parse(req.body); service().cancel(id.parse(req.params.id)); res.json({ ok: true }) })
  app.post('/api/admin/pipeline/runs/:id/deploy', mutationLimiter, (req, res) => { empty.parse(req.body); service().deploy(id.parse(req.params.id)); res.json({ ok: true }) })
  app.post('/api/admin/pipeline/rollback', mutationLimiter, (req, res) => { empty.parse(req.body); service().rollback(); res.json({ ok: true }) })
}