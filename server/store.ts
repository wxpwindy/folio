import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import type { FeatureKey } from '../src/types.js'

export interface BaseResume {
  id: string
  filename: string
  text: string
  pages: number
  createdAt: string
}

export interface ResumeVersion {
  id: string
  baseId: string
  baseText: string
  role: string
  company: string
  jobDescription: string
  text: string
  summary: string
  keywords: string[]
  gaps: string[]
  provider: 'ollama' | 'openai'
  model: string
  // Optional for older saved versions; metadata is immutable after creation.
  documentType?: 'resume' | 'cover-letter'
  language?: { code: string; name: string }
  generationId?: string
  translation?: { sourceType: 'base' | 'version'; sourceId: string; sourceText: string }
  status: 'draft' | 'ready' | 'applied'
  createdAt: string
  updatedAt: string
}

export function createStore(filename: string) {
  const db = new DatabaseSync(filename)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, method TEXT NOT NULL, identifier TEXT NOT NULL,
      password_hash TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(method, identifier)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS account_setup (
      id INTEGER PRIMARY KEY CHECK(id = 1), code_hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bases (
      id TEXT PRIMARY KEY, document TEXT NOT NULL, pdf BLOB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS versions (
      id TEXT PRIMARY KEY, base_id TEXT NOT NULL REFERENCES bases(id), document TEXT NOT NULL
    );
    -- Add features table for administrative control of app features
    CREATE TABLE IF NOT EXISTS features (
      key TEXT PRIMARY KEY CHECK(key IN ('webChat')),
      value INTEGER NOT NULL CHECK(value IN (0, 1)) DEFAULT 1
    );
  `)
  // Additive migration: retain PDFs and immutable JSON snapshots byte-for-byte.
  // Unassigned legacy rows are inaccessible until protected first-account setup.
  db.exec('BEGIN IMMEDIATE')
  try {
    const userColumns = db.prepare('PRAGMA table_info(users)').all()
    for (const [name, definition] of Object.entries({
      role: "TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user', 'admin'))",
      disabled: 'INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0, 1))',
      must_change_password: 'INTEGER NOT NULL DEFAULT 0 CHECK(must_change_password IN (0, 1))',
    })) {
      if (!userColumns.some(column => column.name === name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${definition}`)
    }
    for (const table of ['bases', 'versions']) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all()
      if (!columns.some(column => column.name === 'owner_id')) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN owner_id TEXT REFERENCES users(id)`)
      }
      db.exec(`CREATE INDEX IF NOT EXISTS ${table}_owner_idx ON ${table}(owner_id)`)
    }
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); db.close(); throw error }
  const forUser = (ownerId: string | null) => scopedStore(db, ownerId)
  return { ...forUser(null), forUser }
}

// Null scope is reserved for migration and low-level legacy storage tests. HTTP
// handlers always obtain a non-null owner from the validated cookie session.
function scopedStore(db: DatabaseSync, ownerId: string | null) {
  const base = (id?: string): BaseResume | null => {
    const row = id
      ? db.prepare('SELECT document FROM bases WHERE id = ? AND owner_id IS ?').get(id, ownerId)
      : db.prepare('SELECT document FROM bases WHERE owner_id IS ? ORDER BY rowid DESC LIMIT 1').get(ownerId)
    return row ? JSON.parse(String(row.document)) : null
  }
  const version = (id: string): ResumeVersion | null => {
    const row = db.prepare('SELECT document FROM versions WHERE id = ? AND owner_id IS ?').get(id, ownerId)
    return row ? JSON.parse(String(row.document)) : null
  }
  const addVersion = (input: Omit<ResumeVersion, 'id' | 'createdAt' | 'updatedAt' | 'status'>) => {
    if (!base(input.baseId)) throw new Error('FOREIGN KEY constraint failed: base is outside the account')
    const now = new Date().toISOString()
    const document: ResumeVersion = { ...input, id: randomUUID(), status: 'draft', createdAt: now, updatedAt: now }
    db.prepare('INSERT INTO versions (id, base_id, document, owner_id) VALUES (?, ?, ?, ?)')
      .run(document.id, document.baseId, JSON.stringify(document), ownerId)
    return document
  }
  return {
    db, base, version,
    versions: (): ResumeVersion[] => db.prepare('SELECT document FROM versions WHERE owner_id IS ? ORDER BY rowid DESC')
      .all(ownerId).map(row => JSON.parse(String(row.document))),
    addBase(input: Omit<BaseResume, 'id' | 'createdAt'>, pdf: Buffer) {
      const document: BaseResume = { ...input, id: randomUUID(), createdAt: new Date().toISOString() }
      db.prepare('INSERT INTO bases (id, document, pdf, owner_id) VALUES (?, ?, ?, ?)').run(document.id, JSON.stringify(document), pdf, ownerId)
      return document
    },
    updateBase(id: string, text: string) {
      const document = base(id)
      if (!document) return null
      document.text = text
      db.prepare('UPDATE bases SET document = ? WHERE id = ? AND owner_id IS ?').run(JSON.stringify(document), id, ownerId)
      return document
    },
    pdf(id: string) {
      return db.prepare('SELECT pdf FROM bases WHERE id = ? AND owner_id IS ?').get(id, ownerId)?.pdf as Uint8Array | undefined
    },
    addVersion,
    addVersions(inputs: Parameters<typeof addVersion>[0][]) {
      db.exec('BEGIN IMMEDIATE')
      try {
        const documents = inputs.map(addVersion)
        db.exec('COMMIT')
        return documents
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
    updateVersion(id: string, patch: Pick<ResumeVersion, 'text' | 'role' | 'company' | 'status'>) {
      const old = version(id)
      if (!old) return null
      const document = { ...old, ...patch, updatedAt: new Date().toISOString() }
      db.prepare('UPDATE versions SET document = ? WHERE id = ? AND owner_id IS ?').run(JSON.stringify(document), id, ownerId)
      return document
    },
    deleteVersion(id: string) {
      return db.prepare('DELETE FROM versions WHERE id = ? AND owner_id IS ?').run(id, ownerId).changes > 0
    },
    // Feature management: admin can toggle features, all users inherit the same state
    getFeature(key: FeatureKey): boolean {
      const row = db.prepare('SELECT value FROM features WHERE key = ?').get(key)
      return row ? (row.value as number) === 1 : true
    },
    setFeature(key: FeatureKey, value: boolean) {
      // NOTE: 'all' is not a valid FeatureKey; this guard is intentional
      // TypeScript linter complains but it is needed for runtime error prevention
      // @ts-ignore - intentional runtime guard for invalid key
      if (key === 'all') throw new Error('Cannot toggle all features; toggle individually.')
      db.prepare('INSERT OR REPLACE INTO features (key, value) VALUES (?, ?)').run(key, value ? 1 : 0)
    },
    // Check if a feature request should be allowed based on feature flags
    isFeatureAllowed(key: FeatureKey): boolean {
      return this.getFeature(key)
    },
  }
}
export type Store = ReturnType<typeof createStore>
export type UserStore = ReturnType<Store['forUser']>