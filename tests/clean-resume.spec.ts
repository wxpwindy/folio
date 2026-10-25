import { test, expect, uploadResume, expectNoOverflow, testSettingsKey } from './helpers.ts'
import type { ResumeVersion, Workspace } from '../src/types.ts'

const endpoint = 'http://127.0.0.1:3101/api/base/clean'
const action = 'Create clean English + Chinese'

test('clean base resumes: generate both, independently edit, switch, export and reload at 320px', async ({ page, request }) => {
  await page.setViewportSize({ width: 320, height: 900 })
  const originalPdf = await uploadResume(page)
  const before: Workspace = await (await request.get('/api/workspace')).json()
  await page.getByRole('button', { name: 'Edit extracted text', exact: true }).click()
  const baseEditor = page.getByRole('textbox', { name: 'Base resume text', exact: true })
  await baseEditor.fill(`${before.base!.text}\nSaved source correction.`)
  await expect(page.getByRole('button', { name: action, exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Save text', exact: true }).click()
  await page.getByRole('button', { name: action, exact: true }).click()
  const form = page.getByRole('dialog', { name: 'Create clean base resumes', exact: true })
  await expect(form).toContainText('Simplified Chinese')
  await expect(form.getByRole('textbox', { name: 'Job description' })).toHaveCount(0)
  await expectNoOverflow(page)
  const response = page.waitForResponse(response => response.url() === endpoint && response.request().method() === 'POST')
  await form.getByRole('button', { name: 'Generate both versions', exact: true }).click()
  const result = await response
  expect(result.status()).toBe(201)
  const { versions }: { versions: ResumeVersion[] } = await result.json()
  expect(versions).toHaveLength(2)
  const detail = page.getByRole('dialog', { name: 'Clean base resume', exact: true })
  await expect(detail.getByRole('heading', { name: 'Cleaned, not tailored.' })).toBeVisible()
  await expect(detail.getByRole('heading', { name: 'Made for this role.' })).toHaveCount(0)
  await expect(detail.getByRole('combobox', { name: 'Language version' }).locator('option')).toHaveText(['English', 'Chinese (Simplified)'])
  for (const version of versions) {
    await detail.getByRole('combobox', { name: 'Language version' }).selectOption(version.id)
    await expect(detail.getByRole('article')).toHaveAttribute('lang', version.language!.code)
    await detail.getByRole('button', { name: 'Edit resume', exact: true }).click()
    await detail.getByRole('textbox', { name: 'Resume text', exact: true }).fill(`${version.text}\nReviewed ${version.language!.code} only.`)
    await expect(detail.getByRole('button', { name: 'Export PDF', exact: true })).toBeDisabled()
    await detail.getByRole('button', { name: 'Save changes', exact: true }).click()
    await expect(detail.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled()
    const download = page.waitForEvent('download')
    await detail.getByRole('button', { name: 'Export PDF', exact: true }).click()
    expect((await download).suggestedFilename()).toContain(version.language!.code)
    await expect(detail.getByRole('button', { name: 'Export PDF', exact: true })).toBeEnabled()
    await expectNoOverflow(page)
  }
  await detail.getByRole('tab', { name: 'Base snapshot', exact: true }).click()
  await expect(detail.getByRole('article')).toContainText('Saved source correction.')
  await detail.getByRole('button', { name: 'Close dialog', exact: true }).click()
  const section = page.getByRole('region', { name: 'Clean base resumes', exact: true })
  await expect(section.locator('.clean-base-card')).toHaveCount(2)
  await expectNoOverflow(page)
  await page.reload()
  await page.getByRole('button', { name: 'Base resume', exact: true }).click()
  for (const version of versions) {
    await section.locator('.clean-base-card').filter({ hasText: version.language!.name }).click()
    await expect(detail.getByRole('article')).toContainText(`Reviewed ${version.language!.code} only.`)
    await detail.getByRole('button', { name: 'Close dialog', exact: true }).click()
  }
  const after: Workspace = await (await request.get('/api/workspace')).json()
  expect(after.base!.text).toBe(`${before.base!.text}\nSaved source correction.`)
  expect(await (await request.get(`/api/base/${before.base!.id}/pdf`)).body()).toEqual(originalPdf)
  for (const version of versions) {
    expect(after.versions.find(item => item.id === version.id)!.text).toBe(`${version.text}\nReviewed ${version.language!.code} only.`)
  }
})

test('clean generation guards pending requests and retries a failure without losing the source', async ({ page, request, expectedHttpErrors }) => {
  expectedHttpErrors.push({ url: endpoint, status: 502 })
  await uploadResume(page)
  let release!: () => void
  const pending = new Promise<void>(done => { release = done })
  let calls = 0
  await page.route('**/api/base/clean', async route => {
    calls++
    await pending
    await route.fulfill({ status: 502, json: { error: 'Incomplete language pair. Neither draft was saved.' } })
  })
  await page.getByRole('button', { name: action, exact: true }).click()
  const form = page.getByRole('dialog', { name: 'Create clean base resumes', exact: true })
  await form.getByRole('button', { name: 'Generate both versions', exact: true }).click()
  await expect(form.getByRole('button', { name: 'Creating both drafts…', exact: true })).toBeDisabled()
  await expect(form.getByRole('button', { name: 'Close dialog', exact: true })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(form).toBeVisible()
  release()
  await expect(form.getByRole('alert')).toContainText('Neither draft was saved')
  expect(calls).toBe(1)
  const saved: Workspace = await (await request.get('/api/workspace')).json()
  expect(saved.versions).toHaveLength(0)
  await page.unroute('**/api/base/clean')
  await form.getByRole('button', { name: 'Retry generation', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Clean base resume', exact: true })).toBeVisible()
})

test('clean OpenAI generation needs fresh consent and keeps credentials out of storage', async ({ page }) => {
  await uploadResume(page)
  await page.evaluate(key => localStorage.setItem(key, JSON.stringify({ provider: 'openai', openaiModel: 'fictional-model' })), testSettingsKey)
  await page.reload()
  await page.getByRole('button', { name: 'Base resume', exact: true }).click()
  await page.getByRole('button', { name: action, exact: true }).click()
  const form = page.getByRole('dialog', { name: 'Create clean base resumes', exact: true })
  const submit = form.getByRole('button', { name: 'Generate both versions', exact: true })
  const consent = form.getByRole('checkbox')
  await expect(submit).toBeDisabled()
  await form.getByLabel('OpenAI API key').fill('fictional-key')
  await consent.check()
  await expect(submit).toBeEnabled()
  await form.getByLabel('OpenAI API key').fill('fictional-key-2')
  await expect(consent).not.toBeChecked()
  await consent.check()
  await form.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.getByRole('button', { name: action, exact: true }).click()
  await expect(consent).not.toBeChecked()
  await expect(form.getByLabel('OpenAI API key')).toHaveValue('')
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('fictional-key')
})