import type { APIRequestContext, Page } from '@playwright/test'
import type { AuthSession, Workspace } from '../src/types.ts'
import { test, expect, testAccount, testSetupCode, testSettingsKey, uploadResume, createVersion, expectNoOverflow } from './helpers.ts'
import { originalText } from './data.ts'

const origin = 'http://127.0.0.1:3101'
type Credentials = { method: 'email' | 'phone'; identifier: string; password: string }
const phoneAccount: Credentials = { method: 'phone', identifier: '+12025550123', password: 'Fictional-phone-password!' }
const otherAccount: Credentials = { method: 'email', identifier: 'other@example.test', password: 'Fictional-other-password!' }

async function workspace(request: APIRequestContext): Promise<Workspace> {
  const response = await request.get('/api/workspace')
  expect(response.status()).toBe(200)
  return response.json()
}

async function credentials(page: Page, account: Credentials) {
  await page.getByRole('combobox', { name: 'Sign-in method', exact: true }).selectOption(account.method)
  await page.getByLabel(account.method === 'email' ? 'Email address' : 'Mobile phone', { exact: true }).fill(account.identifier)
  await page.getByLabel('Password', { exact: true }).fill(account.password)
}

async function authenticate(page: Page, account: Credentials, signup = false, setupCode?: string): Promise<AuthSession> {
  await credentials(page, account)
  if (signup) await page.getByLabel('Confirm password', { exact: true }).fill(account.password)
  if (setupCode !== undefined) await page.getByLabel('Setup code', { exact: true }).fill(setupCode)
  const endpoint = `${origin}/api/auth/${signup ? 'signup' : 'login'}`
  const pending = page.waitForResponse(response => response.url() === endpoint && response.request().method() === 'POST')
  await page.getByRole('button', { name: signup ? 'Sign up' : 'Log in', exact: true }).click()
  const response = await pending
  expect(response.status()).toBe(signup ? 201 : 200)
  expect(response.request().postDataJSON()).toEqual({
    method: account.method, identifier: account.identifier.trim(), password: account.password,
    ...(setupCode === undefined ? {} : { setupCode }),
  })
  expect(await response.request().headerValue('X-Folio-Request')).toBe('1')
  const session: AuthSession = await response.json()
  expect(session).toEqual({ user: { id: expect.any(String), method: account.method, identifier: account.identifier.trim().toLowerCase(), createdAt: expect.any(String), role: 'user', mustChangePassword: false }, setupRequired: false })
  await expect(page.getByRole('heading', { name: 'Your experience. The right story.' })).toBeVisible()
  await expect(page.getByLabel('Upload base resume PDF')).toBeEnabled()
  return session
}

async function signOut(page: Page) {
  const pending = page.waitForResponse(response => response.url() === `${origin}/api/auth/logout`)
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  expect((await pending).status()).toBe(204)
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
  await expect(page.getByRole('status')).toHaveText('You have signed out.')
  await expect(page.getByLabel('Upload base resume PDF')).toHaveCount(0)
  await expect(page.locator('.version-card, dialog[open], .app-shell')).toHaveCount(0)
}

async function settings(page: Page) {
  await page.getByRole('button', { name: 'Open AI settings', exact: true }).click()
  return page.getByRole('dialog', { name: 'Your AI, your choice.' })
}

test.describe('first account', () => {
  test.use({ anonymous: true, legacy: true })

  test('email setup claims legacy documents once; real session and original PDF survive reload', async ({ page, context, request }) => {
    await expect(page.getByText('First account setup', { exact: true })).toBeVisible()
    await expect(page.getByLabel('Setup code', { exact: true })).toHaveValue('')
    await expect(page.locator('body')).not.toContainText(originalText)
    await expect(page.locator('body')).not.toContainText(testSetupCode)
    expect((await request.get('/api/workspace')).status()).toBe(401)
    expect((await request.post('/__test/legacy')).status()).toBe(401)
    const first = await authenticate(page, { ...testAccount, identifier: 'FIRST@example.test' }, true, testSetupCode)
    const before = await workspace(request)
    expect(before.base).toMatchObject({ filename: 'legacy-resume.pdf', text: originalText })
    expect(before.versions).toHaveLength(1)
    expect(before.versions[0]).toMatchObject({ baseId: before.base!.id, baseText: originalText, text: originalText })
    expect(before.versions[0].language).toBeUndefined()
    const pdf = await request.get(`/api/base/${before.base!.id}/pdf`)
    expect(pdf.status()).toBe(200)
    expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-')
    const cookies = await context.cookies()
    expect(cookies).toHaveLength(1)
    expect(cookies[0]).toMatchObject({ name: 'folio_session', value: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), httpOnly: true, sameSite: 'Strict', path: '/', secure: false })
    expect(cookies[0].expires - Date.now() / 1000).toBeGreaterThan(7 * 86400 - 60)
    expect(cookies[0].expires - Date.now() / 1000).toBeLessThanOrEqual(7 * 86400)
    expect(await page.evaluate(() => document.cookie)).not.toContain('folio_session')
    await page.reload()
    await expect(page.locator('.version-card')).toHaveCount(1)
    expect(await (await request.get('/api/auth/session')).json()).toEqual(first)
    expect(await workspace(request)).toEqual(before)
    await page.locator('.version-card').click()
    const detail = page.getByRole('dialog', { name: 'Frontend Engineer', exact: true })
    await expect(detail.getByRole('article')).toContainText('Software engineer building accessible web applications')
    await detail.getByRole('button', { name: 'Close dialog', exact: true }).click()
    await signOut(page)
    await page.getByRole('button', { name: 'Create an account', exact: true }).click()
    await expect(page.getByLabel('Setup code', { exact: true })).toHaveCount(0)
    await authenticate(page, otherAccount, true)
    expect(await workspace(request)).toMatchObject({ base: null, versions: [] })
    expect((await request.get(`/api/base/${before.base!.id}/pdf`)).status()).toBe(404)
    await signOut(page)
    await authenticate(page, { ...testAccount, identifier: 'first@example.test' })
    expect(await workspace(request)).toEqual(before)
  })
})

test('320px phone signup and email/phone login keep workspaces and document access isolated', async ({ page, request }) => {
  await page.setViewportSize({ width: 320, height: 844 })
  await uploadResume(page)
  const detail = await createVersion(page)
  await detail.getByRole('button', { name: 'Close dialog', exact: true }).click()
  const emailWorkspace = await workspace(request)
  const emailVersion = emailWorkspace.versions[0]
  await signOut(page)
  await expectNoOverflow(page)
  await page.getByRole('button', { name: 'Create an account', exact: true }).click()
  await page.getByRole('combobox', { name: 'Sign-in method', exact: true }).selectOption('phone')
  await expect(page.getByLabel('Mobile phone', { exact: true })).toHaveAttribute('type', 'tel')
  await expect(page.getByText(/no email or SMS is sent/)).toBeVisible()
  await expectNoOverflow(page)
  await authenticate(page, phoneAccount, true)
  expect(await workspace(request)).toMatchObject({ base: null, versions: [] })
  await expect(page.locator('.version-card')).toHaveCount(0)
  await expectNoOverflow(page)
  // Real middleware and scoped routes, not route mocks or fabricated UI state.
  expect((await request.get(`/api/base/${emailWorkspace.base!.id}/pdf`)).status()).toBe(404)
  expect((await request.get(`/api/versions/${emailVersion.id}/pdf`)).status()).toBe(404)
  expect((await request.patch(`/api/base/${emailWorkspace.base!.id}`, { data: { text: originalText } })).status()).toBe(404)
  expect((await request.delete(`/api/versions/${emailVersion.id}`)).status()).toBe(404)
  expect((await request.post('/api/translations', { data: { sourceType: 'version', sourceId: emailVersion.id, targetLanguage: 'en', provider: 'ollama', model: 'e2e-local-model' } })).status()).toBe(404)
  await uploadResume(page)
  const phoneWorkspace = await workspace(request)
  expect(phoneWorkspace.base!.id).not.toBe(emailWorkspace.base!.id)
  await signOut(page)
  await authenticate(page, testAccount)
  expect(await workspace(request)).toEqual(emailWorkspace)
  expect((await request.get(`/api/base/${phoneWorkspace.base!.id}/pdf`)).status()).toBe(404)
  await signOut(page)
  await authenticate(page, phoneAccount)
  expect(await workspace(request)).toEqual(phoneWorkspace)
  await expectNoOverflow(page)
})

test('sign out guards dirty work, clears keys and consent, and switches account-scoped preferences', async ({ page, request, context }) => {
  await uploadResume(page)
  const before = await workspace(request)
  const fakeKey = 'e2e-account-switch-not-a-real-api-key'
  let form = await settings(page)
  await expect(page.getByRole('button', { name: 'Sign out', exact: true, includeHidden: true })).toBeDisabled()
  await form.getByRole('button', { name: /OpenAI Cloud processing/ }).click()
  await form.getByLabel('OpenAI model').fill('e2e-first-account-model')
  await form.getByLabel(/^API key/).fill(fakeKey)
  await form.getByRole('button', { name: 'Save settings', exact: true }).click()
  await page.getByRole('button', { name: 'New version', exact: true }).click()
  const generation = page.getByRole('dialog', { name: 'A resume for your next chapter.' })
  const consent = generation.getByRole('checkbox', { name: 'I agree to send my base resume and this job description to OpenAI for this generation.', exact: true })
  await consent.check()
  await expect(page.getByRole('button', { name: 'Sign out', exact: true, includeHidden: true })).toBeDisabled()
  await generation.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await page.getByRole('button', { name: 'Edit extracted text', exact: true }).click()
  const unsaved = `${before.base!.text}\nE2E-UNSAVED-ACCOUNT-EDIT`
  await page.getByLabel('Base resume text', { exact: true }).fill(unsaved)
  const cancel = page.waitForEvent('dialog').then(async dialog => {
    expect(dialog.message()).toBe('Discard your unsaved base resume changes and sign out?')
    await dialog.dismiss()
  })
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await cancel
  await expect(page.getByLabel('Base resume text', { exact: true })).toHaveValue(unsaved)
  const discard = page.waitForEvent('dialog').then(dialog => dialog.accept())
  await signOut(page)
  await discard
  expect(await context.cookies()).toEqual([])
  await expect(page.locator('body')).not.toContainText('E2E-UNSAVED-ACCOUNT-EDIT')
  await page.getByRole('button', { name: 'Create an account', exact: true }).click()
  const other = await authenticate(page, otherAccount, true)
  expect(await workspace(request)).toMatchObject({ base: null, versions: [] })
  form = await settings(page)
  await expect(form.getByRole('button', { name: /Ollama Local & private/ })).toHaveAttribute('aria-pressed', 'true')
  await form.getByRole('button', { name: /OpenAI Cloud processing/ }).click()
  await expect(form.getByLabel('OpenAI model')).toHaveValue('e2e-cloud-model')
  await expect(form.getByLabel(/^API key/)).toHaveValue('')
  await form.getByRole('button', { name: 'Close dialog', exact: true }).click()
  const storage = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }))
  expect(storage.local).not.toHaveProperty('folio-ai-settings')
  expect(JSON.parse(storage.local[testSettingsKey])).toEqual({ provider: 'openai', ollamaModel: 'e2e-local-model', openaiModel: 'e2e-first-account-model' })
  expect(JSON.parse(storage.local[`folio-ai-settings:${other.user!.id}`])).toEqual({ provider: 'ollama', ollamaModel: 'e2e-local-model', openaiModel: 'e2e-cloud-model' })
  for (const data of [storage, await context.cookies(), await workspace(request)]) {
    expect(JSON.stringify(data)).not.toContain(fakeKey)
    expect(JSON.stringify(data)).not.toMatch(/cloudConsent|"consent"/i)
    expect(JSON.stringify(data)).not.toContain(testAccount.password)
  }
  await signOut(page)
  await authenticate(page, testAccount)
  expect(await workspace(request)).toEqual(before)
  form = await settings(page)
  await expect(form.getByRole('button', { name: /OpenAI Cloud processing/ })).toHaveAttribute('aria-pressed', 'true')
  await expect(form.getByLabel('OpenAI model')).toHaveValue('e2e-first-account-model')
  await expect(form.getByLabel(/^API key/)).toHaveValue('')
  await form.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await page.getByRole('button', { name: 'New version', exact: true }).click()
  await expect(consent).not.toBeChecked()
  await expect(generation.getByLabel('OpenAI API key', { exact: true })).toHaveValue('')
  await generation.getByRole('button', { name: 'Close dialog', exact: true }).click()
})

test('logout in another tab makes a protected save return 401 and immediately removes the open document', async ({ page, context, request, expectedHttpErrors }) => {
  await uploadResume(page)
  const detail = await createVersion(page)
  const before = await workspace(request)
  const version = before.versions[0]
  await detail.getByRole('button', { name: 'Edit resume', exact: true }).click()
  await detail.getByLabel('Resume text', { exact: true }).fill(`${version.text}\nE2E-UNSAVED-REVOKED-SESSION`)
  const otherTab = await context.newPage()
  await otherTab.goto('/')
  await expect(otherTab.locator('.version-card')).toHaveCount(1)
  await signOut(otherTab)
  // No artificial 401: this save goes through the real revoked-session check.
  const endpoint = `${origin}/api/versions/${version.id}`
  expectedHttpErrors.push({ url: endpoint, status: 401 })
  const pending = page.waitForResponse(response => response.url() === endpoint && response.request().method() === 'PATCH')
  await detail.getByRole('button', { name: 'Save changes', exact: true }).click()
  expect((await pending).status()).toBe(401)
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
  await expect(page.getByRole('status')).toContainText('Your session expired. Log in again to continue. Unsaved changes were not saved.')
  await expect(page.locator('dialog[open], .app-shell')).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText('E2E-UNSAVED-REVOKED-SESSION')
  expect((await request.get('/api/workspace')).status()).toBe(401)
  await authenticate(page, testAccount)
  expect(await workspace(request)).toEqual(before)
  await page.locator('.version-card').click()
  await expect(detail.getByRole('article')).not.toContainText('E2E-UNSAVED-REVOKED-SESSION')
  await detail.getByRole('button', { name: 'Close dialog', exact: true }).click()
  await otherTab.close()
})

for (const action of ['upload', 'download', 'logout'] as const) {
  test(`stale A tab ${action} after B login returns 401 without changing B data or session`, async ({ page, context, request, expectedHttpErrors }) => {
    const buffer = await uploadResume(page)
    const beforeA = await workspace(request)
    const otherTab = await context.newPage()
    await otherTab.goto('/')
    await expect(otherTab.locator('.base-file strong')).toHaveText('alex-example.pdf')
    await signOut(otherTab)
    await otherTab.getByRole('button', { name: 'Create an account', exact: true }).click()
    await authenticate(otherTab, otherAccount, true)
    await signOut(otherTab)
    const sessionB = await authenticate(otherTab, otherAccount)
    await uploadResume(otherTab)
    const beforeB = await workspace(request)
    const cookiesB = await context.cookies()
    // A stays mounted while the browser's HttpOnly cookie now authenticates B.
    await expect(page.getByRole('heading', { name: 'alex-example.pdf' })).toBeVisible()
    const endpoint = `${origin}/api/${action === 'upload' ? 'base' : action === 'logout' ? 'auth/logout' : `base/${beforeA.base!.id}/pdf`}`
    expectedHttpErrors.push({ url: endpoint, status: 401 })
    const downloads: string[] = []
    page.on('download', download => downloads.push(download.suggestedFilename()))
    const pending = page.waitForResponse(response => response.url() === endpoint)
    if (action === 'upload') {
      const replace = page.waitForEvent('dialog').then(async dialog => {
        expect(dialog.message()).toBe('Replace your active base resume? Existing versions and their source snapshots will be kept.')
        await dialog.accept()
      })
      await page.getByLabel('Upload base resume PDF').setInputFiles({ name: 'stale-a.pdf', mimeType: 'application/pdf', buffer })
      await replace
    } else {
      await page.getByRole('button', { name: action === 'logout' ? 'Sign out' : 'Original PDF', exact: true }).click()
    }
    const denied = await pending
    expect(denied.status()).toBe(401)
    expect(await denied.request().headerValue('X-Folio-User')).toBe(testAccount.id)
    expect(denied.headers()['set-cookie']).toBeUndefined()
    await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
    await expect(page.getByRole('status')).toContainText('Your session expired.')
    await expect(page.locator('dialog[open], .app-shell')).toHaveCount(0)
    expect(downloads).toEqual([])
    expect(await context.cookies()).toEqual(cookiesB)
    expect(await (await request.get('/api/auth/session')).json()).toEqual(sessionB)
    expect(await workspace(request)).toEqual(beforeB)
    await otherTab.reload()
    await expect(otherTab.locator('.base-file strong')).toHaveText('alex-example.pdf')
    // A's expired gate can explicitly accept B; its first workspace request is
    // bound to B, not the cleared A identity (login 401 remains covered below).
    const refreshed = page.waitForResponse(response => response.url() === `${origin}/api/workspace`)
    await authenticate(page, otherAccount)
    expect(await (await refreshed).request().headerValue('X-Folio-User')).toBe(sessionB.user!.id)
    expect(await workspace(request)).toEqual(beforeB)
    await otherTab.close()
  })
}

test('expired server session gates PDF access without a download and login rotates the session', async ({ page, request, context, expectedHttpErrors }) => {
  await uploadResume(page)
  const before = await workspace(request)
  const token = (await context.cookies()).find(cookie => cookie.name === 'folio_session')!.value
  expect((await request.post('/__test/expire-session')).status()).toBe(204)
  const endpoint = `${origin}/api/base/${before.base!.id}/pdf`
  expectedHttpErrors.push({ url: endpoint, status: 401 })
  const downloads: string[] = []
  page.on('download', download => downloads.push(download.suggestedFilename()))
  const pending = page.waitForResponse(response => response.url() === endpoint)
  await page.getByRole('button', { name: 'Original PDF', exact: true }).click()
  expect((await pending).status()).toBe(401)
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
  await expect(page.getByRole('status')).toContainText('Your session expired.')
  await expect(page.locator('.app-shell')).toHaveCount(0)
  expect(downloads).toEqual([])
  expect(await (await request.get('/api/auth/session')).json()).toEqual({ user: null, setupRequired: false })
  await authenticate(page, testAccount)
  expect((await context.cookies()).find(cookie => cookie.name === 'folio_session')!.value).not.toBe(token)
  expect(await workspace(request)).toEqual(before)
  const pdf = await request.get(`/api/base/${before.base!.id}/pdf`)
  expect(pdf.status()).toBe(200)
  expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-')
})

test.describe('anonymous validation', () => {
  test.use({ anonymous: true, viewport: { width: 320, height: 844 }, isMobile: true, hasTouch: true })

  test('320px signup validates locally, rejects a bad setup code and shows safe login errors without leakage', async ({ page, request, context, expectedHttpErrors }) => {
    const posts: string[] = []
    page.on('request', request => { if (request.method() === 'POST' && request.url().startsWith(`${origin}/api/auth/`)) posts.push(request.url()) })
    await expectNoOverflow(page)
    await credentials(page, testAccount)
    const password = page.getByLabel('Password', { exact: true })
    await expect(password).toHaveAttribute('minlength', '12')
    await expect(password).toHaveAttribute('maxlength', '128')
    await expect(password).toHaveAttribute('type', 'password')
    await page.getByLabel('Confirm password', { exact: true }).fill('Fictional-mismatch-password!')
    await page.getByLabel('Setup code', { exact: true }).fill(testSetupCode)
    await page.getByRole('button', { name: 'Sign up', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText('Passwords do not match.')
    await expect(page.getByRole('alert')).toBeFocused()
    await credentials(page, { ...phoneAccount, identifier: '2025550123' })
    await page.getByLabel('Confirm password', { exact: true }).fill(phoneAccount.password)
    await page.getByRole('button', { name: 'Sign up', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText('Enter a valid international mobile phone number, including + and the country code.')
    await expectNoOverflow(page)
    await credentials(page, testAccount)
    await password.fill('short')
    await password.press('End')
    await password.press('x')
    await page.getByRole('button', { name: 'Sign up', exact: true }).click()
    expect(await password.evaluate((input: HTMLInputElement) => input.validity.tooShort)).toBe(true)
    expect(posts).toEqual([])
    await credentials(page, testAccount)
    await page.getByLabel('Confirm password', { exact: true }).fill(testAccount.password)
    await page.getByLabel('Setup code', { exact: true }).fill('incorrect-fictional-setup-code')
    expectedHttpErrors.push({ url: `${origin}/api/auth/signup`, status: 403 })
    const rejected = page.waitForResponse(response => response.url() === `${origin}/api/auth/signup`)
    await page.getByRole('button', { name: 'Sign up', exact: true }).click()
    expect((await rejected).status()).toBe(403)
    await expect(page.getByRole('alert')).toHaveText('A valid local setup code is required to create the first account.')
    await expect(password).toHaveValue('')
    await expect(page.getByLabel('Confirm password', { exact: true })).toHaveValue('')
    expect(await (await request.get('/api/auth/session')).json()).toEqual({ user: null, setupRequired: true })
    expect((await request.get('/api/workspace')).status()).toBe(401)
    await expectNoOverflow(page)
    await authenticate(page, testAccount, true, testSetupCode)
    await signOut(page)
    await credentials(page, { ...testAccount, password: 'Fictional-incorrect-password!' })
    expectedHttpErrors.push({ url: `${origin}/api/auth/login`, status: 401 })
    const invalid = page.waitForResponse(response => response.url() === `${origin}/api/auth/login`)
    await page.getByRole('button', { name: 'Log in', exact: true }).click()
    expect((await invalid).status()).toBe(401)
    await expect(page.getByRole('alert')).toHaveText('Invalid credentials. Check your email, phone number or username and password.')
    await expect(page.getByRole('alert')).toBeFocused()
    await expect(page.getByLabel('Password', { exact: true })).toHaveValue('')
    await expect(page.getByRole('status')).not.toContainText('Your session expired.')
    await expectNoOverflow(page)
    expect((await request.post('/api/auth/login', { headers: { 'X-Folio-Request': '' }, data: testAccount })).status()).toBe(403)
    expect(await context.cookies()).toEqual([])
    const storage = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }))
    for (const secret of [testAccount.password, phoneAccount.password, testSetupCode, 'incorrect-fictional-setup-code', 'Fictional-incorrect-password!']) {
      expect(JSON.stringify(storage)).not.toContain(secret)
      await expect(page.locator('body')).not.toContainText(secret)
    }
    await authenticate(page, testAccount)
    expect(await workspace(request)).toMatchObject({ base: null, versions: [] })
  })
})