import { test as base, expect } from '@playwright/test'
import type { Page, Request } from '@playwright/test'
import PDFDocument from 'pdfkit'
import { originalText, jobDescription } from './data.ts'

// Fictional credentials mirrored by fixture-server.ts, never production secrets.
export const testAccount = { id: 'e2e-default-user', method: 'email', identifier: 'alex@example.test', password: 'Fictional-password-2026!' } as const
export const testSetupCode = 'e2e-setup-code-fictional-only-not-a-secret'
export const testSettingsKey = `folio-ai-settings:${testAccount.id}`

// Existing string entries permit HTTP 400 only; other statuses require an exact
// endpoint/status pair. Never suppress arbitrary server or network failures.
type ExpectedHttpError = string | { url: string; status: number }
export const test = base.extend<{ anonymous: boolean; legacy: boolean; expectedHttpErrors: ExpectedHttpError[]; browserDiagnostics: void }>({
  anonymous: [false, { option: true }],
  legacy: [false, { option: true }],
  extraHTTPHeaders: { 'X-Folio-Request': '1' },
  // Playwright's standalone request fixture does NOT share browser cookies.
  // Use the context's request client so reset/login/logout Set-Cookie responses
  // and UI sessions refer to exactly the same account in both directions.
  request: async ({ context }, runTest) => { await runTest(context.request) },
  expectedHttpErrors: [[], { scope: 'test' }],
  browserDiagnostics: [async ({ page, context, request, anonymous, legacy, expectedHttpErrors }, runTest, testInfo) => {
    const errors: string[] = []
    const unexpected: string[] = []
    const externalRequests: string[] = []
    const failedRequests: string[] = []
    const completedDeleteAborts: string[] = []
    const completedAuthAborts: string[] = []
    const completedAdminAborts: string[] = []
    const responseStatuses = new Map<Request, number>()
    const expectedHttpError = (url: string, status: number) => expectedHttpErrors.some(entry => typeof entry === 'string'
      ? entry === url && status === 400 : entry.url === url && entry.status === status)
    context.on('response', response => responseStatuses.set(response.request(), response.status()))
    function observePage(observed: Page) {
      observed.on('pageerror', error => unexpected.push(error.message))
      observed.on('console', message => {
        if (message.type() !== 'error') return
        const text = message.text()
        const url = message.location().url
        errors.push(`${url}: ${text}`)
        const httpStatus = /^Failed to load resource: the server responded with a status of (\d{3})\b/.exec(text)
        const expected = httpStatus && expectedHttpError(url, Number(httpStatus[1]))
        if (!expected) unexpected.push(`${url}: ${text}`)
      })
    }
    observePage(page)
    context.on('page', observePage)
    context.on('requestfailed', request => {
      const failure = `${request.url()}: ${request.failure()?.errorText}`
      // Chromium may abort the unused empty body after fetch resolves a 204.
      // Keep this diagnostic, but only exempt an already-successful local DELETE.
      if (request.method() === 'DELETE' && responseStatuses.get(request) === 204
        && request.url().startsWith('http://127.0.0.1:3101/api/versions/')
        && request.failure()?.errorText === 'net::ERR_ABORTED') completedDeleteAborts.push(failure)
      // Auth invalidation deliberately aborts unread bodies after observing the
      // result. Exempt only confirmed logout 204 or explicitly expected 401s;
      // never hide unobserved responses, arbitrary aborts or network failures.
      else if (request.failure()?.errorText === 'net::ERR_ABORTED'
        && ((request.method() === 'POST' && request.url() === 'http://127.0.0.1:3101/api/auth/logout' && responseStatuses.get(request) === 204)
          || (responseStatuses.get(request) === 401 && expectedHttpError(request.url(), 401)))) completedAuthAborts.push(failure)
      // Same Chromium empty-body behavior for successful admin actions. Match
      // only this exact local UUID action route, POST method and observed 204.
      else if (request.method() === 'POST' && responseStatuses.get(request) === 204
        && /^http:\/\/127\.0\.0\.1:3101\/api\/admin\/users\/[a-f0-9-]{36}\/action$/.test(request.url())
        && request.failure()?.errorText === 'net::ERR_ABORTED') completedAdminAborts.push(failure)
      else failedRequests.push(failure)
    })
    await context.route(/^https?:\/\//, async route => {
      if (new URL(route.request().url()).origin !== 'http://127.0.0.1:3101') {
        externalRequests.push(route.request().url())
        await route.abort('blockedbyclient')
      } else await route.continue()
    })
    // A fixture runs for every importing spec. A module-level beforeEach hook
    // only registers in the first spec when helpers are cached by the worker.
    const reset = await request.post('/__test/reset', { data: { anonymous, legacy } })
    expect(reset.status()).toBe(204)
    if (anonymous) await context.clearCookies()
    const sessionResponse = await request.get('/api/auth/session')
    expect(sessionResponse.status()).toBe(200)
    const session = await sessionResponse.json()
    if (anonymous) expect(session).toEqual({ user: null, setupRequired: true })
    else expect(session).toEqual({ user: { id: testAccount.id, method: testAccount.method, identifier: testAccount.identifier, createdAt: expect.any(String), role: 'user', mustChangePassword: false }, setupRequired: false })
    await page.goto('/')
    if (anonymous) {
      await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible()
      await expect(page.getByLabel('Upload base resume PDF')).toHaveCount(0)
    } else {
      await expect(page.getByRole('heading', { name: 'Your experience. The right story.' })).toBeVisible()
      await expect(page.getByLabel('Upload base resume PDF')).toBeEnabled()
    }
    await runTest()
    await testInfo.attach('browser-diagnostics', {
      body: JSON.stringify({ consoleErrors: errors, unexpected, externalRequests, failedRequests, completedDeleteAborts, completedAuthAborts, completedAdminAborts }, null, 2),
      contentType: 'application/json',
    })
    expect(unexpected, 'Unexpected console errors / uncaught exceptions').toEqual([])
    expect(externalRequests, 'No cloud or other external browser requests').toEqual([])
    expect(failedRequests, 'No failed browser requests').toEqual([])
  }, { auto: true }],
})
export { expect }

export async function pdfBuffer(text = originalText): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({ size: 'A4', margin: 48 })
    const chunks: Buffer[] = []
    document.on('data', chunk => chunks.push(Buffer.from(chunk)))
    document.on('end', () => resolve(Buffer.concat(chunks)))
    document.on('error', reject)
    document.font('Helvetica').fontSize(11).text(text)
    document.end()
  })
}

export async function uploadResume(page: Page) {
  const buffer = await pdfBuffer()
  await page.getByLabel('Upload base resume PDF').setInputFiles({ name: 'alex-example.pdf', mimeType: 'application/pdf', buffer })
  await expect(page.getByRole('heading', { name: 'alex-example.pdf' })).toBeVisible()
  await expect(page.getByRole('article', { name: 'Resume preview' })).toContainText('ALEX EXAMPLE')
  return buffer
}

export async function createVersion(page: Page, role = 'Frontend Engineer', company = 'Example Labs', description = jobDescription) {
  await page.getByRole('button', { name: 'New version', exact: true }).click()
  const form = page.getByRole('dialog', { name: 'A resume for your next chapter.' })
  await form.getByLabel('Job title', { exact: true }).fill(role)
  await form.getByLabel('Company', { exact: true }).fill(company)
  await form.getByLabel('Job description', { exact: true }).fill(description)
  await form.getByRole('button', { name: 'Generate version', exact: true }).click()
  const detail = page.getByRole('dialog', { name: role, exact: true })
  await expect(detail).toBeVisible()
  await expect(detail.getByRole('article', { name: 'Resume preview' })).toContainText('ALEX EXAMPLE')
  return detail
}

export async function expectNoOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    dialogs: [...document.querySelectorAll('dialog[open]')].map(dialog => ({ width: dialog.clientWidth, scroll: dialog.scrollWidth })),
  }))
  expect(dimensions.document, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.viewport)
  expect(dimensions.body, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.viewport)
  for (const dialog of dimensions.dialogs) expect(dialog.scroll).toBeLessThanOrEqual(dialog.width)
}

export async function openCoverLetterForm(page: Page, description = jobDescription) {
  await page.getByRole('button', { name: 'New cover letter', exact: true }).click()
  const form = page.getByRole('dialog', { name: 'A cover letter for your next chapter.', exact: true })
  await expect(form.getByLabel('Document type', { exact: true })).toHaveValue('cover-letter')
  await form.getByLabel('Job title', { exact: true }).fill('Frontend Engineer')
  await form.getByLabel('Company', { exact: true }).fill('Example Labs')
  await form.getByLabel('Job description', { exact: true }).fill(description)
  return form
}