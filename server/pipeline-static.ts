import express from 'express'
import type { Express } from 'express'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { LocalPipeline } from './pipeline.ts'

/** Switch frontend assets without restarting the API or modifying the database. */
export function installPipelineStatic(app: Express, pipeline: LocalPipeline, fallback: string) {
  app.use('/releases/:id', (req, res, next) => {
    const id = z.string().uuid().safeParse(req.params.id)
    if (!id.success) { res.sendStatus(404); return }
    express.static(pipeline.releaseDirectory(id.data), { index: false, dotfiles: 'deny', fallthrough: false })(req, res, next)
  })
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) { res.status(404).json({ error: 'API endpoint not found.' }); return }
    const directory = pipeline.activeDirectory() ?? fallback
    express.static(directory, { index: false, dotfiles: 'deny' })(req, res, next)
  })
  // Preserve lazy-loaded hashed assets for tabs opened before the first deployment.
  app.use('/assets', express.static(join(fallback, 'assets'), { index: false, dotfiles: 'deny' }))
  app.get('/{*path}', (req, res) => {
    const directory = pipeline.activeDirectory() ?? fallback
    // Never return HTML for a missing JS/CSS asset.
    if (!req.accepts('html') || req.path.startsWith('/assets/') || !existsSync(join(directory, 'index.html'))) { res.sendStatus(404); return }
    res.setHeader('Cache-Control', 'no-store')
    res.sendFile('index.html', { root: directory, dotfiles: 'deny' })
  })
}