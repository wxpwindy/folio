import 'dotenv/config'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createStore } from './store.ts'
import { createApp } from './app.ts'
import { prepareAccountSetup } from './account-setup.ts'
import { LocalPipeline } from './pipeline.ts'
import { installPipelineStatic } from './pipeline-static.ts'

process.umask(0o077)
const directory = resolve(process.env.DATA_DIR || 'data')
mkdirSync(directory, { recursive: true, mode: 0o700 })
const store = createStore(resolve(directory, 'folio.sqlite'))
prepareAccountSetup(store.db, directory)
const pipeline = new LocalPipeline({ root: resolve('.') })
const app = createApp(store, undefined, undefined, () => prepareAccountSetup(store.db, directory, true), undefined, undefined, undefined, pipeline)
installPipelineStatic(app, pipeline, resolve('dist'))
const server = app.listen(3001, '127.0.0.1', () => console.log('Folio API: http://127.0.0.1:3001'))
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { void pipeline.close().finally(() => server.close(() => { store.db.close(); process.exit(0) })) })
}