import assert from 'node:assert/strict'
import { it } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createStore } from './store.ts'
import type { Store } from './store.ts'

function pairInputs(baseId: string, baseText: string): Parameters<Store['addVersions']>[0] {
  const shared = {
    baseId, baseText, role: 'Engineer', company: 'Example', jobDescription: 'Description du poste fictif.',
    provider: 'ollama' as const, model: 'test-model', generationId: randomUUID(),
  }
  return [
    { ...shared, language: { code: 'fr', name: 'French' }, text: 'CV français fictif', summary: 'Résumé des changements', keywords: ['tests'], gaps: ['Certification non attestée'] },
    { ...shared, language: { code: 'en', name: 'English' }, text: 'Fictional English resume', summary: 'Summary of changes', keywords: ['testing'], gaps: ['Certification not evidenced'] },
  ]
}

it('persists originals, source snapshots, edits, and deletions across database restarts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'folio-storage-test-'))
  const filename = join(directory, 'test.sqlite')
  let store = createStore(filename)
  try {
    const pdf = Buffer.from('%PDF-test-only')
    const base = store.addBase({ filename: 'resume.pdf', text: 'Original source text', pages: 1 }, pdf)
    const version = store.addVersion({
      baseId: base.id, baseText: base.text, role: 'Engineer', company: 'Example',
      jobDescription: 'Example test description', text: 'Tailored test text', summary: 'Test summary',
      keywords: ['TypeScript'], gaps: [], provider: 'ollama', model: 'test-model',
    })
    store.updateBase(base.id, 'Later source text')
    store.updateVersion(version.id, { role: 'Engineer', company: 'Example', text: 'Edited version text', status: 'ready' })
    store.db.close()
    store = createStore(filename)
    assert.equal('language' in store.version(version.id)!, false)
    assert.equal('generationId' in store.version(version.id)!, false)
    assert.equal('documentType' in store.version(version.id)!, false)
    assert.equal(store.base()?.text, 'Later source text')
    assert.deepEqual(Buffer.from(store.pdf(base.id)!), pdf)
    assert.equal(store.version(version.id)?.baseText, 'Original source text')
    assert.equal(store.version(version.id)?.text, 'Edited version text')
    assert.equal(store.version(version.id)?.status, 'ready')
    assert.equal(store.versions().length, 1)
    store.deleteVersion(version.id)
    store.db.close()
    store = createStore(filename)
    assert.deepEqual(store.versions(), [])
    assert.equal(store.base()?.id, base.id)
  } finally {
    store.db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

for (const documentType of ['resume', 'cover-letter'] as const) it(`persists an atomic bilingual ${documentType} batch and independent edits/deletions across restarts with immutable snapshots`, () => {
  const directory = mkdtempSync(join(tmpdir(), 'folio-bilingual-storage-test-'))
  const filename = join(directory, 'test.sqlite')
  let store = createStore(filename)
  try {
    const pdf = Buffer.from('%PDF-test-only')
    const base = store.addBase({ filename: 'resume.pdf', text: 'Original source text', pages: 1 }, pdf)
    const inputs = pairInputs(base.id, base.text).map(input => ({ ...input, documentType }))
    const [primary, english] = store.addVersions(inputs)
    assert.notEqual(primary.id, english.id)
    assert.equal(primary.generationId, english.generationId)
    for (const [index, version] of [primary, english].entries()) {
      assert.deepEqual(version, {
        ...inputs[index], id: version.id, status: 'draft', createdAt: version.createdAt, updatedAt: version.createdAt,
      })
      assert.match(version.id, /^[\da-f-]{36}$/i)
      assert.ok(Number.isFinite(Date.parse(version.createdAt)))
    }
    store.db.close()
    store = createStore(filename)
    assert.deepEqual(store.versions(), [english, primary])

    const fetched = store.version(primary.id)!
    fetched.language!.code = 'de'
    fetched.keywords.push('invented')
    const listed = store.versions()
    listed[0].language!.name = 'Mutated'
    listed[0].gaps.push('invented')
    assert.deepEqual(store.versions(), [english, primary], 'nested metadata and arrays are detached')

    store.updateBase(base.id, 'Later source text')
    const replacement = store.addBase({ filename: 'replacement.pdf', text: 'Replacement source text', pages: 1 }, Buffer.from('%PDF-replacement-test'))
    const patch = { role: 'Reviewed Engineer', company: 'Reviewed Example', text: 'Edited French version text', status: 'ready' as const }
    const edited = store.updateVersion(primary.id, patch)!
    assert.deepEqual(edited, { ...primary, ...patch, updatedAt: edited.updatedAt })
    assert.deepEqual(store.version(english.id), english)
    assert.equal(store.version(primary.id)?.baseText, base.text)
    assert.equal(store.version(english.id)?.baseText, base.text)
    store.db.close()
    store = createStore(filename)
    assert.deepEqual(store.versions(), [english, edited])
    assert.deepEqual(store.base(), replacement)
    assert.deepEqual(Buffer.from(store.pdf(base.id)!), pdf)
    assert.equal(store.deleteVersion(primary.id), true)
    store.db.close()
    store = createStore(filename)
    assert.deepEqual(store.versions(), [english])
    assert.equal(store.version(primary.id), null)
    assert.equal(store.base(base.id)?.text, 'Later source text')
    assert.deepEqual(store.base(), replacement)
  } finally {
    store.db.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it('rolls back every earlier batch insert on a later foreign-key failure and can commit again', () => {
  const store = createStore(':memory:')
  try {
    const pdf = Buffer.from('%PDF-test-only')
    const base = store.addBase({ filename: 'resume.pdf', text: 'Original source text', pages: 1 }, pdf)
    const existing = store.addVersion(pairInputs(base.id, base.text)[0])
    const inputs = pairInputs(base.id, base.text)
    assert.throws(() => store.addVersions([inputs[0], { ...inputs[1], baseId: randomUUID() }]), /FOREIGN KEY constraint failed/)
    assert.deepEqual(store.versions(), [existing], 'the valid first insert must not survive')
    assert.deepEqual(store.base(), base)
    assert.deepEqual(Buffer.from(store.pdf(base.id)!), pdf)
    const [primary, english] = store.addVersions(inputs)
    assert.deepEqual(store.versions(), [english, primary, existing])
    assert.equal(primary.generationId, english.generationId)
    assert.notEqual(primary.generationId, existing.generationId)
    assert.deepEqual(store.addVersions([]), [])
    assert.deepEqual(store.versions(), [english, primary, existing])
  } finally {
    store.db.close()
  }
})