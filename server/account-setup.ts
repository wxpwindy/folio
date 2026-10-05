import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, chmodSync, unlinkSync, renameSync } from 'node:fs'
import { resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { hashToken } from './auth.ts'

// Never serve or log this secret. OS filesystem access protects the first-owner
// claim; a website or a later registrant cannot claim unassigned personal data.
export function prepareAccountSetup(db: DatabaseSync, directory: string, rotate = false) {
  const path = resolve(directory, 'account-setup-code')
  if (Number(db.prepare("SELECT COUNT(*) AS count FROM users WHERE method != 'username'").get()!.count) > 0) {
    if (rotate) throw new Error('First-account setup is already complete.')
    if (existsSync(path)) unlinkSync(path)
    return
  }
  let code: string
  if (rotate) {
    code = randomBytes(32).toString('base64url')
    const temporary = `${path}.${randomBytes(12).toString('hex')}.tmp`
    try {
      writeFileSync(temporary, `${code}\n`, { mode: 0o600, flag: 'wx' })
      renameSync(temporary, path)
    } finally { if (existsSync(temporary)) unlinkSync(temporary) }
  } else if (existsSync(path)) {
    code = readFileSync(path, 'utf8').trim()
    if (!/^[A-Za-z0-9_-]{43}$/.test(code)) throw new Error('Invalid account setup code file. Move it aside and restart Folio.')
    chmodSync(path, 0o600)
  } else {
    code = randomBytes(32).toString('base64url')
    writeFileSync(path, `${code}\n`, { mode: 0o600, flag: 'wx' })
  }
  db.prepare('INSERT INTO account_setup(id, code_hash) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET code_hash = excluded.code_hash').run(hashToken(code))
}