import { test, expect, expectNoOverflow } from './helpers.ts'

test('disabled chat stays hidden for ordinary users and tab focus refreshes an open chat', async ({ page }) => {
  let enabled = false
  let chatRequests = 0
  page.on('request', req => { if (new URL(req.url()).pathname.startsWith('/api/chat')) chatRequests++ })
  await page.route('**/api/features', route => route.fulfill({ json: { features: { webChat: enabled } } }))
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Your experience. The right story.' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Web chat', exact: true })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Local web chat' })).toHaveCount(0)
  expect(chatRequests).toBe(0)
  await expectNoOverflow(page)

  enabled = true
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.getByRole('button', { name: 'Web chat', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Local web chat' })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Chat model' })).toBeEnabled()
  await page.getByRole('textbox', { name: 'Message' }).fill('Fictional temporary draft')
  await expect(page.getByRole('button', { name: 'Change password', exact: true })).toBeDisabled()

  enabled = false
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(page.getByRole('button', { name: 'Web chat', exact: true })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Local web chat' })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Your experience. The right story.' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Change password', exact: true })).toBeEnabled()

  enabled = true
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.getByRole('button', { name: 'Web chat', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('')
})

test('feature status failure hides chat without blocking resumes and can be retried', async ({ page, expectedHttpErrors }) => {
  expectedHttpErrors.push({ url: 'http://127.0.0.1:3101/api/features', status: 503 })
  let fail = true
  await page.route('**/api/features', route => route.fulfill(fail
    ? { status: 503, json: { error: 'Fictional feature service unavailable.' } }
    : { json: { features: { webChat: true } } }))
  await page.reload()
  await expect(page.getByRole('alert')).toContainText('Could not load feature availability.')
  await expect(page.getByRole('button', { name: 'Web chat', exact: true })).toHaveCount(0)
  await expect(page.getByLabel('Upload base resume PDF')).toBeEnabled()
  fail = false
  await page.getByRole('button', { name: 'Retry features' }).click()
  await expect(page.getByRole('button', { name: 'Web chat', exact: true })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
})