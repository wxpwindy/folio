import { readFile } from 'node:fs/promises'
import { PDFParse } from 'pdf-parse'
import type { APIRequestContext, Locator, Page } from '@playwright/test'
import type { ResumeVersion, TranslationTargetLanguage, Workspace } from '../src/types.ts'
import { test, expect, uploadResume, createVersion, expectNoOverflow, openCoverLetterForm, testSettingsKey } from './helpers.ts'
import { chineseLetterTranslationText, chineseTranslationText, englishLetterText, frenchJobDescription, originalText } from './data.ts'

const endpoint = 'http://127.0.0.1:3101/api/translations'
const consentLabel = 'I agree to send this document text to OpenAI for this translation.'
const dirtyHint = 'Save changes before translating. Only the current saved text is translated.'
async function workspace(request: APIRequestContext): Promise<Workspace> {
  const response = await request.get('/api/workspace')
  expect(response.status()).toBe(200)
  return response.json()
}
async function openTranslation(page: Page, source: Page | Locator, target: TranslationTargetLanguage = 'zh-Hans') {
  await source.getByRole('button', { name: target === 'en' ? 'Translate to English' : 'Translate to Chinese', exact: true }).click()
  const form = page.getByRole('dialog', { name: 'Translate document', exact: true })
  await expect(form).toBeVisible()
  await expect(page.locator('dialog[open]')).toHaveCount(1)
  await expect(form.getByRole('combobox', { name: 'Target language', exact: true })).toHaveValue(target)
  await expect(form.getByRole('combobox', { name: 'Target language' }).locator('option')).toHaveText(['Chinese (Simplified)', 'English'])
  return form
}
async function submitTranslation(page: Page, form: Locator, button = 'Translate document') {
  const pending = page.waitForResponse(response => response.url() === endpoint && response.request().method() === 'POST')
  await form.getByRole('button', { name: button, exact: true }).click()
  const response = await pending
  expect(response.status()).toBe(201)
  const version: ResumeVersion = await response.json()
  const detail = page.getByRole('dialog', { name: version.role, exact: true })
  await expect(detail.locator('.translation-badge')).toHaveText('Translation')
  await expect(page.locator('dialog[open]')).toHaveCount(1)
  await expect(detail.getByRole('heading', { name: 'Translated, not tailored.', exact: true })).toBeVisible()
  await expect(detail.getByRole('heading', { name: 'Highlighted keywords' })).toHaveCount(0)
  await expect(detail.getByRole('heading', { name: 'Worth reviewing' })).toHaveCount(0)
  await expect(detail.getByRole('combobox', { name: 'Language version', exact: true })).toHaveCount(0)
  await expect(detail.getByRole('article')).toHaveAttribute('lang', version.language!.code)
  expect(version).toMatchObject({ status: 'draft', keywords: [], gaps: [], generationId: expect.any(String) })
  expect(version).not.toHaveProperty('additionalVersions')
  return { version, detail }
}
async function expectPdf(page: Page, detail: Locator, filename: string, text: string) {
  const pending = page.waitForEvent('download')
  await detail.getByRole('button', { name: 'Export PDF', exact: true }).click()
  const download = await pending
  expect(download.suggestedFilename()).toBe(filename)
  const buffer = await readFile((await download.path())!)
  expect(buffer.subarray(0, 5).toString()).toBe('%PDF-')
  const parser = new PDFParse({ data: new Uint8Array(buffer) })
  try {
    const parsed = await parser.getText({ pageJoiner: '\n' })
    // CJK extraction may add spaces at glyph boundaries; ignore whitespace only,
    // requiring all saved characters, not merely a PDF header or candidate name.
    expect(parsed.text.replace(/\s+/g, '')).toContain(text.replace(/\s+/g, ''))
  } finally { await parser.destroy() }
  await expect(detail.getByRole('button', { name: 'Export PDF', exact: true })).toBeEnabled()
}
async function deleteDocument(page: Page, detail: Locator, version: ResumeVersion) {
  const confirmation = page.waitForEvent('dialog').then(async dialog => {
    expect(dialog.type()).toBe('confirm')
    expect(dialog.message()).toBe(`Delete the ${version.role} ${version.documentType === 'cover-letter' ? 'cover letter' : 'resume'} for ${version.company}? This cannot be undone.`)
    await dialog.accept()
  })
  const response = page.waitForResponse(response => response.request().method() === 'DELETE' && response.url().endsWith(`/api/versions/${version.id}`))
  await detail.getByRole('button', { name: version.documentType === 'cover-letter' ? 'Delete cover letter' : 'Delete', exact: true }).click()
  await confirmation
  expect((await response).status()).toBe(204)
  await expect(detail).not.toBeVisible()
}
async function expectTranslationLayout(page: Page) {
  await expectNoOverflow(page)
  const overflow = await page.locator('.translation-actions, .version-card, dialog[open] .modal-body, dialog[open] .tabs, dialog[open] .modal-footer, dialog[open] .resume-editor, dialog[open] .language-toolbar, dialog[open] .translation-source-text').evaluateAll(elements =>
    elements.filter(element => element.scrollWidth > element.clientWidth + 1).map(element => element.className))
  expect(overflow).toEqual([])
  for (const control of await page.locator('dialog[open] input, dialog[open] select, dialog[open] textarea, .translation-actions button').all()) {
    const bounds = await control.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width)
  }
}

test('base translations: independent Chinese and English drafts, Unicode PDFs, edits, reload and result-only deletion', async ({ page, request }) => {
  const originalPdf = await uploadResume(page)
  const savedBase = `${originalText}\nE2E-SAVED-BASE-42`
  await page.getByRole('button', { name: 'Edit extracted text', exact: true }).click()
  await page.getByRole('textbox', { name: 'Base resume text', exact: true }).fill(savedBase)
  for (const name of ['Translate to Chinese', 'Translate to English']) await expect(page.getByRole('button', { name, exact: true })).toBeDisabled()
  await expect(page.getByText(dirtyHint, { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Save text', exact: true }).click()
  await expect(page.getByRole('article')).toContainText('E2E-SAVED-BASE-42')
  const before = await workspace(request)
  const copies: ResumeVersion[] = []
  // Repeating a target must create another independent draft, not reuse a pair.
  for (const target of ['zh-Hans', 'en', 'zh-Hans'] as const) {
    const form = await openTranslation(page, page, target)
    const { version, detail } = await submitTranslation(page, form)
    const expectedText = `${target === 'en' ? originalText : chineseTranslationText}\nE2E-SAVED-BASE-42`
    expect(version).toMatchObject({ role: 'Base resume', company: 'alex-example', documentType: 'resume', baseId: before.base!.id,
      baseText: savedBase, jobDescription: '', text: expectedText,
      language: { code: target, name: target === 'en' ? 'English' : 'Chinese (Simplified)' },
      translation: { sourceType: 'base', sourceId: before.base!.id, sourceText: savedBase } })
    await detail.getByRole('tab', { name: 'Job description', exact: true }).click()
    await expect(detail.getByText('No job description; translated from base resume text, not tailored to a job.', { exact: true })).toBeVisible()
    await detail.getByRole('tab', { name: 'Translation source', exact: true }).click()
    await expect(detail.locator('pre[aria-label="Translation source text"]')).toHaveText(savedBase)
    if (copies.length < 2) await expectPdf(page, detail, `alex-example - Base resume - ${target}.pdf`, expectedText)
    copies.push(version)
    await detail.getByRole('button', { name: 'Close dialog', exact: true }).click()
  }
  expect(new Set(copies.map(copy => copy.id)).size).toBe(3)
  expect(new Set(copies.map(copy => copy.generationId)).size).toBe(3)
  const pdfResponse = await request.get(`/api/base/${before.base!.id}/pdf`)
  expect(pdfResponse.status()).toBe(200)
  expect(await pdfResponse.body()).toEqual(originalPdf)
  await page.getByRole('button', { name: 'Resume versions', exact: true }).click()
  const cards = page.locator('.version-card')
  await expect(cards).toHaveCount(3)
  await expect(cards.locator('.translation-badge')).toHaveText(['Translation', 'Translation', 'Translation'])
  await cards.filter({ has: page.locator('.language-badge', { hasText: /^English$/ }) }).click()
  const detail = page.getByRole('dialog', { name: 'Base resume', exact: true })
  const edited = `${copies[1].text}\nReviewed translation only.`
  await detail.getByRole('button', { name: 'Edit resume', exact: true }).click()
  await detail.getByRole('textbox', { name: 'Resume text', exact: true }).fill(edited)
  await detail.getByRole('combobox', { name: 'Version status' }).selectOption('ready')
  await expect(detail.getByRole('button', { name: 'Export PDF', exact: true })).toBeDisabled()
  await detail.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(detail.getByRole('article')).toContainText('Reviewed translation only.')
  await expectPdf(page, detail, 'alex-example - Base resume - en.pdf', edited)
  await detail.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await page.reload()
  await cards.filter({ has: page.locator('.language-badge', { hasText: /^English$/ }) }).click()
  await expect(detail.getByRole('article')).toContainText('Reviewed translation only.')
  await expect(detail.getByRole('combobox', { name: 'Version status' })).toHaveValue('ready')
  const persisted = await workspace(request)
  expect(persisted.versions.find(copy => copy.id === copies[1].id)).toMatchObject({ ...copies[1], text: edited, status: 'ready', updatedAt: expect.any(String) })
  await deleteDocument(page, detail, copies[1])
  await page.reload()
  await expect(cards).toHaveCount(2)
  const after = await workspace(request)
  expect(after.base).toEqual(before.base)
  expect(after.versions).toEqual(expect.arrayContaining([copies[0], copies[2]]))
  expect(after.versions).toHaveLength(2)
})

test('legacy resume translation uses saved edits, cancellation restores selection and source deletion retains both snapshots', async ({ page, request }) => {
  await uploadResume(page)
  const seeded = await request.post('/__test/legacy')
  expect(seeded.status()).toBe(201)
  const legacy: ResumeVersion = await seeded.json()
  expect(legacy.language).toBeUndefined()
  expect(legacy.documentType).toBeUndefined()
  expect(legacy.generationId).toBeUndefined()
  await page.reload()
  await page.locator('.version-card').click()
  const detail = page.getByRole('dialog', { name: 'Frontend Engineer', exact: true })
  const savedText = `${legacy.text}\nE2E-SAVED-LEGACY-73`
  await detail.getByRole('button', { name: 'Edit resume', exact: true }).click()
  await detail.getByRole('textbox', { name: 'Resume text', exact: true }).fill(savedText)
  for (const name of ['Translate to Chinese', 'Translate to English']) await expect(detail.getByRole('button', { name, exact: true })).toBeDisabled()
  await expect(detail.getByText(dirtyHint, { exact: true })).toBeVisible()
  await detail.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(detail.getByRole('article')).toContainText('E2E-SAVED-LEGACY-73')
  const saved = (await workspace(request)).versions[0]
  const confirmation = await openTranslation(page, detail)
  await expect(detail).toHaveCount(0)
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(page.locator('dialog[open]')).toHaveCount(1)
  await expect(detail.getByRole('article')).toContainText('E2E-SAVED-LEGACY-73')
  expect((await workspace(request)).versions).toEqual([saved])
  await detail.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await page.getByRole('button', { name: 'Base resume', exact: true }).click()
  await page.getByRole('button', { name: 'Edit extracted text', exact: true }).click()
  await page.getByRole('textbox', { name: 'Base resume text', exact: true }).fill(`${originalText}\nE2E-SAVED-LATER-BASE-99`)
  await page.getByRole('button', { name: 'Save text', exact: true }).click()
  await expect(page.getByRole('article')).toContainText('E2E-SAVED-LATER-BASE-99')
  await page.getByRole('button', { name: 'Resume versions', exact: true }).click()
  await page.locator('.version-card').click()
  const { version } = await submitTranslation(page, await openTranslation(page, detail))
  expect(version).toMatchObject({ documentType: 'resume', role: saved.role, company: saved.company, baseId: saved.baseId,
    baseText: saved.baseText, jobDescription: saved.jobDescription, text: `${chineseTranslationText}\nE2E-SAVED-LEGACY-73`,
    translation: { sourceType: 'version', sourceId: saved.id, sourceText: savedText } })
  await detail.getByRole('tab', { name: 'Base snapshot', exact: true }).click()
  await expect(detail.getByRole('article')).not.toContainText('E2E-SAVED-')
  await detail.getByRole('tab', { name: 'Translation source', exact: true }).click()
  await expect(detail.locator('pre[aria-label="Translation source text"]')).toHaveText(savedText)
  await detail.getByRole('button', { name: 'Close dialog', exact: true }).click()
  expect((await workspace(request)).versions.find(item => item.id === saved.id)).toEqual(saved)
  await page.locator('.version-card').filter({ hasNot: page.locator('.translation-badge') }).click()
  await deleteDocument(page, detail, saved)
  await page.reload()
  await expect(page.locator('.version-card')).toHaveCount(1)
  await page.locator('.version-card').click()
  await detail.getByRole('tab', { name: 'Translation source', exact: true }).click()
  await expect(detail.locator('pre[aria-label="Translation source text"]')).toHaveText(savedText)
  const after = await workspace(request)
  expect(after.versions).toEqual([version])
  expect(after.base!.text).toContain('E2E-SAVED-LATER-BASE-99')
})

test('saved bilingual resume translation stays outside language pairs and cancellation restores the selected counterpart', async ({ page, request }) => {
  await uploadResume(page)
  const detail = await createVersion(page, 'Frontend Engineer', 'Example Labs', frenchJobDescription)
  const before = await workspace(request)
  const french = before.versions.find(version => version.language?.code === 'fr')!
  const english = before.versions.find(version => version.language?.code === 'en')!
  const switcher = detail.getByRole('combobox', { name: 'Language version', exact: true })
  await switcher.selectOption(english.id)
  const cancelled = await openTranslation(page, detail)
  await cancelled.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(switcher).toHaveValue(english.id)
  await expect(detail.getByRole('article')).toHaveAttribute('lang', 'en')
  await switcher.selectOption(french.id)
  const { version } = await submitTranslation(page, await openTranslation(page, detail, 'en'))
  expect(version).toMatchObject({ language: { code: 'en', name: 'English' }, documentType: 'resume', role: french.role, company: french.company,
    baseId: french.baseId, baseText: french.baseText, jobDescription: frenchJobDescription,
    translation: { sourceType: 'version', sourceId: french.id, sourceText: french.text } })
  expect(version.generationId).not.toBe(french.generationId)
  expect(version.id).not.toBe(english.id)
  await detail.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await page.reload()
  await expect(page.locator('.version-card')).toHaveCount(3)
  await page.locator('.version-card').filter({ has: page.locator('.language-badge', { hasText: /^French$/ }) }).click()
  await expect(switcher.locator('option')).toHaveCount(2)
  expect((await switcher.locator('option').allTextContents()).sort()).toEqual(['English', 'French'])
  expect((await switcher.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value))).sort()).toEqual([french.id, english.id].sort())
  const after = await workspace(request)
  expect(after.base).toEqual(before.base)
  expect(after.versions.filter(item => !item.translation)).toEqual(before.versions)
  expect(after.versions.find(item => item.id === version.id)).toEqual(version)
})

test('cover letter translation preserves type, saved body, metadata and Chinese PDF through edit and reload', async ({ page, request }) => {
  await uploadResume(page)
  const form = await openCoverLetterForm(page)
  await form.getByRole('button', { name: 'Generate cover letter', exact: true }).click()
  const detail = page.getByRole('dialog', { name: 'Frontend Engineer', exact: true })
  await expect(detail.getByRole('article', { name: 'Cover letter preview' })).toBeVisible()
  await detail.getByRole('button', { name: 'Edit cover letter', exact: true }).click()
  const savedText = `${englishLetterText}\n\nE2E-SAVED-LETTER-25`
  await detail.getByRole('textbox', { name: 'Cover letter text', exact: true }).fill(savedText)
  await detail.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(detail.getByRole('article')).toContainText('E2E-SAVED-LETTER-25')
  const before = await workspace(request)
  const source = before.versions[0]
  const { version } = await submitTranslation(page, await openTranslation(page, detail))
  expect(version).toMatchObject({ documentType: 'cover-letter', role: source.role, company: source.company, baseId: source.baseId,
    baseText: source.baseText, jobDescription: source.jobDescription, language: { code: 'zh-Hans', name: 'Chinese (Simplified)' },
    text: `${chineseLetterTranslationText}\nE2E-SAVED-LETTER-25`,
    translation: { sourceType: 'version', sourceId: source.id, sourceText: savedText } })
  expect(version.generationId).not.toBe(source.generationId)
  await expect(detail.getByRole('article', { name: 'Cover letter preview' }).locator('h3')).toHaveCount(0)
  await detail.getByRole('button', { name: 'Edit cover letter', exact: true }).click()
  const reviewed = `${version.text}\n\n已核对姓名、日期和工作经历。`
  await detail.getByRole('textbox', { name: 'Cover letter text', exact: true }).fill(reviewed)
  await detail.getByRole('combobox', { name: 'Version status' }).selectOption('applied')
  await detail.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(detail.getByRole('article')).toContainText('已核对姓名、日期和工作经历。')
  await expectPdf(page, detail, 'Example Labs - Frontend Engineer - cover-letter - zh-Hans.pdf', reviewed)
  await detail.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await page.reload()
  await page.getByRole('combobox', { name: 'Filter by document type' }).selectOption('cover-letter')
  await expect(page.locator('.version-card')).toHaveCount(2)
  await page.locator('.version-card').filter({ has: page.locator('.translation-badge') }).click()
  await expect(detail.getByRole('article', { name: 'Cover letter preview' })).toHaveAttribute('lang', 'zh-Hans')
  await expect(detail.getByRole('combobox', { name: 'Version status' })).toHaveValue('applied')
  await detail.getByRole('tab', { name: 'Translation source', exact: true }).click()
  await expect(detail.locator('pre[aria-label="Translation source text"]')).toHaveText(savedText)
  const after = await workspace(request)
  expect(after.versions.find(item => item.id === source.id)).toEqual(source)
  expect(after.versions.find(item => item.id === version.id)).toMatchObject({ ...version, text: reviewed, status: 'applied', updatedAt: expect.any(String) })
  expect(after.base).toEqual(before.base)
})

test('OpenAI translation requires fresh consent, resets on target and key changes and sends only source identity', async ({ page, request, context }) => {
  await uploadResume(page)
  const detail = await createVersion(page)
  await detail.getByRole('button', { name: 'Close dialog', exact: true }).click()
  const before = await workspace(request)
  const source = before.versions[0]
  expect(before.config.openaiConfigured).toBe(false)
  await page.getByRole('button', { name: 'Open AI settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Your AI, your choice.' })
  await settings.getByRole('button', { name: /OpenAI Cloud processing/ }).click()
  await settings.getByRole('button', { name: 'Save settings', exact: true }).click()
  await page.getByRole('button', { name: 'Resume versions', exact: true }).click()
  await page.locator('.version-card').click()
  const form = await openTranslation(page, detail)
  const consent = form.getByRole('checkbox', { name: consentLabel, exact: true })
  // Password inputs have no implicit textbox role.
  const key = form.getByLabel(/^OpenAI API key/)
  const submit = form.getByRole('button', { name: 'Translate document', exact: true })
  const posts: unknown[] = []
  page.on('request', request => { if (request.url() === endpoint && request.method() === 'POST') posts.push(request.postDataJSON()) })
  await expect(key).toHaveValue('')
  await expect(key).toHaveAttribute('type', 'password')
  await expect(consent).not.toBeChecked()
  await expect(submit).toBeDisabled()
  await consent.check()
  await expect(submit).toBeDisabled()
  const firstKey = 'e2e-translation-fake-key-one'
  const finalKey = 'e2e-translation-fake-key-two'
  await key.fill(firstKey)
  await expect(consent).not.toBeChecked()
  for (const target of ['en', 'zh-Hans']) {
    await consent.check()
    await expect(submit).toBeEnabled()
    await form.getByRole('combobox', { name: 'Target language' }).selectOption(target)
    await expect(consent).not.toBeChecked()
    await expect(submit).toBeDisabled()
  }
  await consent.check()
  await key.fill(finalKey)
  await expect(consent).not.toBeChecked()
  await expect(submit).toBeDisabled()
  expect(posts).toEqual([])
  expect((await workspace(request)).versions).toEqual(before.versions)
  await consent.check()
  const { version } = await submitTranslation(page, form)
  // Exact keys reject accidental client inclusion of the JD, base, source text,
  // type or provenance. The server resolves the saved document from its ID.
  expect(posts).toEqual([{ sourceType: 'version', sourceId: source.id, targetLanguage: 'zh-Hans', provider: 'openai', model: 'e2e-cloud-model', apiKey: finalKey, cloudConsent: true }])
  expect(version.translation).toEqual({ sourceType: 'version', sourceId: source.id, sourceText: source.text })
  await openTranslation(page, detail, 'en')
  await expect(consent).not.toBeChecked()
  await expect(key).toHaveValue('')
  await form.getByRole('button', { name: 'Cancel', exact: true }).click()
  await detail.getByRole('button', { name: 'Close dialog', exact: true }).click()
  const storage = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }))
  for (const data of [storage, await context.cookies(), await workspace(request)]) {
    expect(JSON.stringify(data)).not.toContain(firstKey)
    expect(JSON.stringify(data)).not.toContain(finalKey)
    expect(JSON.stringify(data)).not.toMatch(/cloudConsent|"consent"/i)
  }
  expect(storage.local).not.toHaveProperty('folio-ai-settings')
  expect(JSON.parse(storage.local[testSettingsKey])).toEqual({ provider: 'openai', ollamaModel: 'e2e-local-model', openaiModel: 'e2e-cloud-model', lmstudioModel: 'google/gemma-4-12b', lmstudioDefaultModel: 'google/gemma-4-12b', byokBaseUrl: '', byokModel: '' })
  await page.reload()
  await page.locator('.version-card').filter({ has: page.locator('.translation-badge') }).click()
  await openTranslation(page, detail)
  await expect(consent).not.toBeChecked()
  await expect(key).toHaveValue('')
  await expect(submit).toBeDisabled()
})

test('320px translation failure and retry: busy guard, no saved failure, four tabs, editor and cards without overflow', async ({ page, request, expectedHttpErrors }) => {
  await page.setViewportSize({ width: 320, height: 844 })
  await uploadResume(page)
  await expectTranslationLayout(page)
  const before = await workspace(request)
  const message = 'Synthetic translation provider unavailable. Nothing was saved.'
  expectedHttpErrors.push({ url: endpoint, status: 502 })
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  // Hold just the first request to inspect busy UI deterministically, then fail
  // it at the browser boundary. Retry reaches the real isolated API/store.
  await page.route(endpoint, async route => {
    expect(route.request().method()).toBe('POST')
    await gate
    await route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: message }) })
  }, { times: 1 })
  const form = await openTranslation(page, page)
  await expectTranslationLayout(page)
  const failed = page.waitForResponse(response => response.url() === endpoint)
  await form.getByRole('button', { name: 'Translate document', exact: true }).click()
  try {
    await expect(form.getByRole('button', { name: 'Translating…', exact: true })).toBeDisabled()
    await expect(form.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled()
    await expect(form.getByRole('button', { name: 'Close dialog', exact: true })).toBeDisabled()
    await expect(form.getByRole('combobox', { name: 'Target language' })).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(form).toBeVisible()
    await expect(page.locator('dialog[open]')).toHaveCount(1)
    for (const button of await page.locator('.base-page .translation-actions button').all()) await expect(button).toBeDisabled()
    await expect(page.locator('.base-page .translation-actions .field-hint')).toHaveText('Wait for the current operation to finish before translating.')
    await expectTranslationLayout(page)
  } finally { release() }
  expect((await failed).status()).toBe(502)
  await expect(form.getByRole('alert')).toContainText(message)
  await expect(form.getByRole('alert')).toContainText('Check your AI settings and connection, then choose Retry translation.')
  await expect(form.getByRole('combobox', { name: 'Target language' })).toHaveValue('zh-Hans')
  expect(await workspace(request)).toEqual(before)
  await expectTranslationLayout(page)
  const { detail, version } = await submitTranslation(page, form, 'Retry translation')
  expect((await workspace(request)).versions).toEqual([version])
  await expect(detail.getByRole('tab')).toHaveCount(4)
  for (const name of ['Resume', 'Job description', 'Base snapshot', 'Translation source']) {
    await detail.getByRole('tab', { name, exact: true }).click()
    if (name === 'Translation source') await expect(detail.locator('pre[aria-label="Translation source text"]')).toHaveText(before.base!.text)
    await expectTranslationLayout(page)
  }
  await detail.getByRole('tab', { name: 'Resume', exact: true }).click()
  await detail.getByRole('button', { name: 'Edit resume', exact: true }).click()
  const editor = detail.getByRole('textbox', { name: 'Resume text', exact: true })
  await expect(editor).toHaveAttribute('lang', 'zh-Hans')
  await editor.fill(`${version.text}\n已核对。`)
  await expect(detail.getByText(dirtyHint, { exact: true })).toBeVisible()
  await expectTranslationLayout(page)
  await detail.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(detail.getByRole('article')).toContainText('已核对。')
  await detail.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await page.getByRole('button', { name: 'Resume versions', exact: true }).click()
  await expect(page.locator('.version-card')).toHaveCount(1)
  await expect(page.locator('.version-card .translation-badge')).toHaveText('Translation')
  await expectTranslationLayout(page)
})