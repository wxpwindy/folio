import 'dotenv/config'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { createStore } from './store.ts'
import { initializeAdministrator } from './auth.ts'

// Intentionally interactive: no default plaintext password in source, argv,
// environment, shell history, or logs. No password-reset/backdoor on restart.
if (!process.stdin.isTTY) throw new Error('Run admin initialization in an interactive local terminal.')
process.umask(0o077)
const directory = resolve(process.env.DATA_DIR || 'data')
mkdirSync(directory, { recursive: true, mode: 0o700 })
const store = createStore(resolve(directory, 'folio.sqlite'))
const silent = new Writable({ write(_chunk, _encoding, callback) { callback() } })
const input = createInterface({ input: process.stdin, output: silent, terminal: true })
try {
  if (store.db.prepare("SELECT id FROM users WHERE role = 'admin' OR (method = 'username' AND identifier = 'wxpwindy')").get()) {
    throw new Error('An administrator already exists; initialization will not change it.')
  }
  process.stdout.write('Initial password for administrator wxpwindy (hidden; 10–128 characters): ')
  let password = await input.question('')
  process.stdout.write('\n')
  await initializeAdministrator(store.db, password)
  password = ''
  console.log('Administrator wxpwindy initialized. Log in with Username and change the initial password before proceeding.')
} catch (error) {
  // Zod diagnostics must not accidentally print credential input.
  console.error(error instanceof Error && error.name !== 'ZodError' ? error.message : 'Initialization failed. Use a password of 10–128 characters.')
  process.exitCode = 1
} finally { input.close(); store.db.close() }