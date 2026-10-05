import type { Page } from '@playwright/test'
import type { ChatAnswer, ChatMessage, ChatRequest } from '../src/types.ts'
import { test, expect, expectNoOverflow } from './helpers.ts'

const endpoint = 'http://127.0.0.1:3101/api/chat'
const modelsEndpoint = `${endpoint}/models`
const model = 'fictional-local-chat'
const searchLabel = 'Search the internet for this answer'
const consentLabel = (provider = 'DuckDuckGo') => `I allow automatically generated search terms from this conversation to be sent to ${provider} for this answer.`
const generatedQuery = 'fictional automatically extracted research'
const webAnswer = 'A fictional answer combining three search results [1], [2], and [3].'
const rankedSources: ChatAnswer['sources'] = [
  { title: 'Example research source', url: 'https://example.com/research', snippet: 'Synthetic search evidence for browser tests.' },
  { title: 'Second research source', url: 'https://example.com/research-two', snippet: 'Second ranked synthetic result.' },
  { title: 'Third research source', url: 'https://example.com/research-three', snippet: 'Third ranked synthetic result.' },
]
const localAnswer = (question: string) => `A fictional local answer to: ${question}`

async function expectNoManualQuery(page: Page) {
  await expect(page.getByRole('textbox', { name: /search terms|search query/i })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Local web chat' }).getByRole('textbox')).toHaveCount(1)
}

async function openChat(page: Page) {
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Web chat', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Local web chat' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'A little room to think.' })).toBeVisible()
}

async function expectReady(page: Page) {
  await expect(page.getByRole('combobox', { name: 'Chat model', exact: true })).toHaveValue(model)
  await expect(page.getByRole('button', { name: 'Refresh models', exact: true })).toBeEnabled()
}

async function sendMessage(page: Page, question: string): Promise<ChatRequest> {
  const answers = page.getByRole('article', { name: 'Assistant answer', exact: true })
  const count = await answers.count()
  const draft = page.getByRole('textbox', { name: 'Your message', exact: true })
  // Do not edit an already prepared prompt: any edit invalidates search consent.
  if (await draft.inputValue() !== question) await draft.fill(question)
  const pending = page.waitForResponse(response => response.url() === endpoint && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  const response = await pending
  expect(response.status()).toBe(200)
  await expect(answers).toHaveCount(count + 1)
  await expect(page.getByRole('article', { name: 'Your message', exact: true }).last()).toContainText(question.trim())
  await expect(page.getByRole('textbox', { name: 'Your message', exact: true })).toHaveValue('')
  const input = response.request().postDataJSON() as ChatRequest
  expect(input).not.toHaveProperty('searchQuery')
  return input
}

async function confirmAction(page: Page, action: () => Promise<unknown>, message: string, accept: boolean) {
  const pending = page.waitForEvent('dialog').then(async dialog => {
    expect(dialog.type()).toBe('confirm')
    expect(dialog.message()).toBe(message)
    if (accept) await dialog.accept()
    else await dialog.dismiss()
  })
  await action()
  await pending
}

async function expectEmpty(page: Page) {
  await expect(page.getByRole('log', { name: 'Chat messages' }).getByRole('article')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'What’s on your mind?' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Your message', exact: true })).toHaveValue('')
  await expect(page.getByRole('checkbox', { name: searchLabel, exact: true })).not.toBeChecked()
  await expectNoManualQuery(page)
  await expect(page.getByRole('checkbox', { name: /I allow automatically generated search terms/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
}

test('desktop local chat sends only the last five complete turns as follow-up context', async ({ page }) => {
  await openChat(page)
  await expectReady(page)
  await expectEmpty(page)
  await expect(page.getByText('Local only', { exact: true })).toBeVisible()
  await expect(page.getByText('No cloud model fallback.', { exact: false })).toBeVisible()
  const history: ChatMessage[] = []
  for (let turn = 1; turn <= 7; turn++) {
    const question = `Explain fictional interview topic ${turn}.`
    const input = await sendMessage(page, question)
    expect(input).toEqual({ model, messages: [...history.slice(-10), { role: 'user', content: question }], webSearch: false, searchConsent: false })
    await expect(page.getByRole('article', { name: 'Assistant answer', exact: true }).last()).toContainText(localAnswer(question))
    history.push({ role: 'user', content: question }, { role: 'assistant', content: localAnswer(question) })
  }
  await expect(page.getByRole('log', { name: 'Chat messages' }).getByRole('article')).toHaveCount(14)
  await expect(page.getByRole('heading', { name: 'Sources for this answer' })).toHaveCount(0)
  await expectNoOverflow(page)
})

test('automatic web search guards keyboard submission, renders all three ranked sources and resets consent', async ({ page }) => {
  await openChat(page)
  await expectReady(page)
  const draft = page.getByRole('textbox', { name: 'Your message', exact: true })
  const search = page.getByRole('checkbox', { name: searchLabel, exact: true })
  const consent = page.getByRole('checkbox', { name: consentLabel(), exact: true })
  const send = page.getByRole('button', { name: 'Send message', exact: true })
  const requests: ChatRequest[] = []
  page.on('request', request => {
    if (request.url() === endpoint && request.method() === 'POST') requests.push(request.postDataJSON() as ChatRequest)
  })
  const question = 'Compare these public interview preparation resources.'
  await draft.fill(question)
  await search.check()
  await expectNoManualQuery(page)
  await expect(page.getByText('Automatic search:', { exact: true })).toBeVisible()
  await expect(page.getByText('Only the generated query is sent to the search provider, not the conversation directly.', { exact: false })).toBeVisible()
  await expect(send).toBeDisabled()
  await draft.press('Enter') // Keyboard submission must enforce the same consent guard.
  await expect(draft).toHaveValue(question)
  await expect(page.getByRole('article', { name: 'Assistant answer', exact: true })).toHaveCount(0)
  expect(requests).toEqual([])
  await consent.check()
  await expect(send).toBeEnabled()
  await draft.fill(`${question} Include accessible resources.`)
  await expect(consent).not.toBeChecked()
  await expect(send).toBeDisabled()
  await draft.press('Enter')
  await expect(draft).toHaveValue(`${question} Include accessible resources.`)
  expect(requests).toEqual([])
  await draft.fill(question)
  await consent.check()
  await search.uncheck()
  await search.check()
  await expect(consent).not.toBeChecked()
  await expect(send).toBeDisabled()
  await consent.check()
  expect(await sendMessage(page, question)).toEqual({ model, messages: [{ role: 'user', content: question }], webSearch: true,
    searchConsent: true, searchProvider: 'DuckDuckGo' })
  const answer = page.getByRole('article', { name: 'Assistant answer', exact: true })
  await expect(answer).toContainText(webAnswer)
  await expect(answer).toContainText(`Searched: ${generatedQuery}`)
  await expect(answer).toContainText('Query generated by LM Studio · Top 3 usable results')
  await expect(answer).not.toContainText('Fewer than three usable results')
  await expect(answer).not.toContainText('This answer is not web-verified.')
  const sources = answer.locator('ol').getByRole('listitem')
  await expect(sources).toHaveCount(3)
  await expect(answer.getByRole('link')).toHaveCount(3)
  for (const [rank, expected] of rankedSources.entries()) {
    const item = sources.nth(rank)
    await expect(item).toContainText(expected.snippet)
    const source = item.getByRole('link', { name: expected.title, exact: true })
    // Inspect attributes only; the shared helper still blocks all external requests.
    await expect(source).toHaveAttribute('href', expected.url)
    await expect(source).toHaveAttribute('target', '_blank')
    await expect(source).toHaveAttribute('rel', 'noopener noreferrer')
  }
  await expect(search).not.toBeChecked()
  await expectNoManualQuery(page)
  await search.check()
  await expectNoManualQuery(page)
  await expect(consent).not.toBeChecked()
  await draft.fill('Summarize your previous answer.')
  await expect(send).toBeDisabled()
  await search.uncheck()
  expect(await sendMessage(page, 'Summarize your previous answer.')).toEqual({ model, webSearch: false, searchConsent: false,
    messages: [{ role: 'user', content: question }, { role: 'assistant', content: webAnswer },
      { role: 'user', content: 'Summarize your previous answer.' }] })
  expect(requests).toHaveLength(2)
  await expect(page.getByRole('article', { name: 'Assistant answer', exact: true }).last().getByRole('link')).toHaveCount(0)
})

test('Bing is an explicit no-key choice and changing search provider clears consent', async ({ page }) => {
  await openChat(page)
  await expectReady(page)
  await page.getByRole('textbox', { name: 'Your message', exact: true }).fill('Research a fictional public topic.')
  await page.getByRole('checkbox', { name: searchLabel, exact: true }).check()
  await page.getByRole('checkbox', { name: consentLabel(), exact: true }).check()
  await page.getByRole('combobox', { name: 'Search provider', exact: true }).selectOption('Bing')
  const consent = page.getByRole('checkbox', { name: consentLabel('Bing'), exact: true })
  await expect(page.getByRole('checkbox', { name: consentLabel(), exact: true })).toHaveCount(0)
  await expect(consent).not.toBeChecked()
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
  await expectNoManualQuery(page)
  await consent.check()
  const input = await sendMessage(page, 'Research a fictional public topic.')
  expect(input.searchProvider).toBe('Bing')
  expect(input.searchConsent).toBe(true)
  await expect(page.getByRole('link', { name: 'Example research source' })).toBeVisible()
})

test('shortcut prompts and model selection invalidate automatic-search consent', async ({ page }) => {
  const otherModel = 'fictional-second-chat'
  await page.route(modelsEndpoint, route => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ models: [model, otherModel], searchProvider: 'DuckDuckGo' }) }))
  await openChat(page)
  await expectReady(page)
  const draft = page.getByRole('textbox', { name: 'Your message', exact: true })
  const consent = page.getByRole('checkbox', { name: consentLabel(), exact: true })
  const send = page.getByRole('button', { name: 'Send message', exact: true })
  await draft.fill('A fictional draft before choosing a shortcut.')
  await page.getByRole('checkbox', { name: searchLabel, exact: true }).check()
  for (const prompt of ['Help me prepare for a technical interview.', 'Explain a complex topic in simple terms.']) {
    await consent.check()
    await expect(send).toBeEnabled()
    await page.getByRole('button', { name: prompt, exact: true }).click()
    await expect(draft).toHaveValue(prompt)
    await expect(draft).toBeFocused()
    await expect(consent).not.toBeChecked()
    await expect(send).toBeDisabled()
  }
  await consent.check()
  await page.getByRole('combobox', { name: 'Chat model', exact: true }).selectOption(otherModel)
  await expect(consent).not.toBeChecked()
  await expect(send).toBeDisabled()
  await expect(draft).toHaveValue('Explain a complex topic in simple terms.')
  await consent.check()
  const input = await sendMessage(page, 'Explain a complex topic in simple terms.')
  expect(input.model).toBe(otherModel)
  expect(input.searchConsent).toBe(true)
  await expect(page.getByRole('article', { name: 'Assistant answer', exact: true })).toContainText(otherModel)
})

test('keyboard preserves newlines and IME composition, and sends only with fresh consent', async ({ page }) => {
  await openChat(page)
  await expectReady(page)
  const draft = page.getByRole('textbox', { name: 'Your message', exact: true })
  const consent = page.getByRole('checkbox', { name: consentLabel(), exact: true })
  const requests: ChatRequest[] = []
  page.on('request', request => {
    if (request.url() === endpoint && request.method() === 'POST') requests.push(request.postDataJSON() as ChatRequest)
  })
  await page.getByRole('checkbox', { name: searchLabel, exact: true }).check()
  await consent.check()
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
  await draft.press('Enter')
  await expect(draft).toHaveValue('')
  await draft.fill('Fictional multiline question.')
  await consent.check()
  await draft.press('End')
  await draft.press('Shift+Enter')
  await expect(draft).toHaveValue('Fictional multiline question.\n')
  await expect(consent).not.toBeChecked()
  await draft.press('Enter')
  await expect(page.getByRole('article', { name: 'Assistant answer', exact: true })).toHaveCount(0)
  expect(requests).toEqual([])
  await consent.check()
  await draft.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true })
  await expect(consent).toBeChecked()
  await expect(draft).toHaveValue('Fictional multiline question.\n')
  expect(requests).toEqual([])
  const pending = page.waitForResponse(response => response.url() === endpoint && response.request().method() === 'POST')
  await draft.press('Enter')
  expect((await pending).status()).toBe(200)
  await expect(page.getByRole('article', { name: 'Assistant answer', exact: true })).toContainText(webAnswer)
  expect(requests).toEqual([{ model, messages: [{ role: 'user', content: 'Fictional multiline question.' }],
    webSearch: true, searchConsent: true, searchProvider: 'DuckDuckGo' }])
  await expect(draft).toHaveValue('')
})

for (const count of [0, 1, 2]) {
  test(`automatic search discloses ${count} usable results without inventing extra sources`, async ({ page }) => {
    const response: ChatAnswer = { model, searchQuery: generatedQuery, sources: rankedSources.slice(0, count),
      content: count ? 'A fictional answer based on limited evidence [1].' : 'A fictional local answer without web evidence.' }
    await page.route(endpoint, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) }), { times: 1 })
    await openChat(page)
    await expectReady(page)
    const question = 'Research a fictional topic with limited public evidence.'
    await page.getByRole('textbox', { name: 'Your message', exact: true }).fill(question)
    await page.getByRole('checkbox', { name: searchLabel, exact: true }).check()
    await page.getByRole('checkbox', { name: consentLabel(), exact: true }).check()
    await sendMessage(page, question)
    const answer = page.getByRole('article', { name: 'Assistant answer', exact: true })
    await expect(answer).toContainText(response.content)
    await expect(answer.getByRole('heading', { name: 'Sources for this answer' })).toBeVisible()
    await expect(answer).toContainText(`Searched: ${generatedQuery}`)
    await expect(answer).toContainText(`Query generated by LM Studio · Top ${count} usable results`)
    await expect(answer.locator('ol').getByRole('listitem')).toHaveCount(count)
    await expect(answer.getByRole('link')).toHaveCount(count)
    if (count) {
      await expect(answer).toContainText('Fewer than three usable results were available. Check the limited evidence carefully.')
      await expect(answer).not.toContainText('No search results found.')
      for (const [rank, source] of response.sources.entries()) {
        await expect(answer.getByRole('link').nth(rank)).toHaveText(source.title)
        await expect(answer.getByRole('link').nth(rank)).toHaveAttribute('href', source.url)
      }
    } else {
      await expect(answer).toContainText('No search results found. This answer is not web-verified.')
      await expect(answer).not.toContainText('Fewer than three usable results were available.')
    }
  })
}

test('failed automatic search preserves draft, requires fresh consent and retries without duplicating history', async ({ page, expectedHttpErrors }) => {
  expectedHttpErrors.push({ url: endpoint, status: 503 })
  await openChat(page)
  await expectReady(page)
  const first = 'Start a fictional research discussion.'
  await sendMessage(page, first)
  let releaseResponse!: () => void
  const responseGate = new Promise<void>(resolve => { releaseResponse = resolve })
  await page.route(endpoint, async route => {
    await responseGate
    await route.fulfill({ status: 503, contentType: 'application/json',
      body: JSON.stringify({ error: 'Fictional search provider unavailable. Please retry.' }) })
  }, { times: 1 })
  const question = 'Find public resources for that discussion.'
  const draft = page.getByRole('textbox', { name: 'Your message', exact: true })
  const consent = page.getByRole('checkbox', { name: consentLabel(), exact: true })
  await draft.fill(question)
  await page.getByRole('checkbox', { name: searchLabel, exact: true }).check()
  await consent.check()
  const failed = page.waitForResponse(response => response.url() === endpoint && response.status() === 503)
  try {
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    // Consent is consumed at the attempt, not only when a response succeeds.
    await expect(consent).not.toBeChecked()
    await expect(consent).toBeDisabled()
    await expect(draft).toBeDisabled()
    await expect(page.getByRole('article', { name: 'Your pending message', exact: true })).toContainText(question)
    await expect(page.getByRole('status')).toContainText('Extracting search terms, searching, and combining the top 3 results…')
  } finally { releaseResponse() }
  const failedInput = (await failed).request().postDataJSON()
  expect(failedInput).not.toHaveProperty('searchQuery')
  await expect(page.getByRole('alert')).toContainText('Fictional search provider unavailable. Please retry.')
  await expect(draft).toHaveValue(question)
  await expect(draft).toBeEnabled()
  await expectNoManualQuery(page)
  await expect(page.getByRole('checkbox', { name: searchLabel, exact: true })).toBeChecked()
  await expect(consent).not.toBeChecked()
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
  await expect(page.getByRole('article', { name: 'Your pending message', exact: true })).toHaveCount(0)
  await expect(page.getByRole('log', { name: 'Chat messages' }).getByRole('article')).toHaveCount(2)
  await consent.check()
  const retry = await sendMessage(page, question)
  expect(retry).toEqual(failedInput)
  expect(retry.messages).toEqual([{ role: 'user', content: first }, { role: 'assistant', content: localAnswer(first) }, { role: 'user', content: question }])
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByRole('log', { name: 'Chat messages' }).getByRole('article')).toHaveCount(4)
})

for (const state of ['empty', 'disconnected'] as const) {
  test(`${state} models disable sending and Refresh models recovers without losing the draft`, async ({ page, expectedHttpErrors }) => {
    if (state === 'disconnected') expectedHttpErrors.push({ url: modelsEndpoint, status: 503 })
    await page.route(modelsEndpoint, route => route.fulfill({ status: state === 'empty' ? 200 : 503, contentType: 'application/json',
      body: JSON.stringify(state === 'empty' ? { models: [], searchProvider: 'DuckDuckGo' } : { error: 'LM Studio is disconnected. Start the local server and refresh.' }) }), { times: 1 })
    await openChat(page)
    await expect(page.getByRole('alert')).toContainText(state === 'empty' ? 'No models found. Download and load a chat model in LM Studio, then refresh.' : 'LM Studio is disconnected.')
    await expect(page.getByRole('combobox', { name: 'Chat model', exact: true })).toBeDisabled()
    const question = 'Keep this fictional draft while reconnecting.'
    await page.getByRole('textbox', { name: 'Your message', exact: true }).fill(question)
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: 'Refresh models', exact: true }).click()
    await expectReady(page)
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(page.getByRole('textbox', { name: 'Your message', exact: true })).toHaveValue(question)
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled()
    await sendMessage(page, question)
    await expect(page.getByRole('article', { name: 'Assistant answer', exact: true })).toContainText(localAnswer(question))
  })
}

test('320px chat, search controls and source answers have no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 })
  await openChat(page)
  await expectReady(page)
  await expectNoOverflow(page)
  const question = `Explain this fictional identifier: ${'SyntheticLongTopic'.repeat(15)}`
  await page.getByRole('textbox', { name: 'Your message', exact: true }).fill(question)
  await page.getByRole('checkbox', { name: searchLabel, exact: true }).check()
  await expectNoManualQuery(page)
  await page.getByRole('checkbox', { name: consentLabel(), exact: true }).check()
  await expectNoOverflow(page)
  await sendMessage(page, question)
  for (const source of rankedSources) await expect(page.getByRole('link', { name: source.title, exact: true })).toBeVisible()
  await expect(page.getByText(`Searched: ${generatedQuery}`, { exact: true })).toBeVisible()
  await expectNoOverflow(page)
  const overflowing = await page.locator('.chat-layout, .chat-settings, .chat-panel, .chat-transcript, .chat-message, .chat-sources, .chat-composer').evaluateAll(elements =>
    elements.filter(element => element.scrollWidth > element.clientWidth + 1).map(element => element.className))
  expect(overflowing).toEqual([])
  for (const control of await page.locator('.chat-page button, .chat-page select, .chat-page textarea, .chat-page input').all()) {
    const bounds = await control.boundingBox()
    expect(bounds).not.toBeNull()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320)
  }
})

test('New chat and navigation guard drafts and conversations; accepting clears all temporary state', async ({ page }) => {
  await openChat(page)
  await expectReady(page)
  const draft = page.getByRole('textbox', { name: 'Your message', exact: true })
  const newChat = () => page.getByRole('button', { name: 'New chat', exact: true }).click()
  const overview = () => page.getByRole('button', { name: 'Overview', exact: true }).click()
  const clearMessage = 'Clear this conversation and draft? Chat is not saved.'
  const leaveMessage = 'Leave chat? This temporary conversation and draft will be cleared.'
  await draft.fill('A fictional unsent draft.')
  await expect(page.getByRole('button', { name: 'Change password', exact: true })).toBeDisabled()
  await confirmAction(page, newChat, clearMessage, false)
  await expect(draft).toHaveValue('A fictional unsent draft.')
  await confirmAction(page, overview, leaveMessage, false)
  await expect(draft).toHaveValue('A fictional unsent draft.')
  await sendMessage(page, 'A fictional completed conversation.')
  await draft.fill('A follow-up draft to clear.')
  await page.getByRole('checkbox', { name: searchLabel, exact: true }).check()
  await page.getByRole('checkbox', { name: consentLabel(), exact: true }).check()
  await confirmAction(page, newChat, clearMessage, false)
  await expect(page.getByRole('article', { name: 'Assistant answer', exact: true })).toHaveCount(1)
  await expect(draft).toHaveValue('A follow-up draft to clear.')
  await confirmAction(page, newChat, clearMessage, true)
  await expectEmpty(page)
  await expect(draft).toBeFocused()
  await expect(page.getByRole('button', { name: 'Change password', exact: true })).toBeEnabled()
  await page.getByRole('checkbox', { name: searchLabel, exact: true }).check()
  await expectNoManualQuery(page)
  await expect(page.getByRole('checkbox', { name: consentLabel(), exact: true })).not.toBeChecked()
  await page.getByRole('checkbox', { name: searchLabel, exact: true }).uncheck()
  expect((await sendMessage(page, 'A fresh fictional conversation.')).messages).toEqual([{ role: 'user', content: 'A fresh fictional conversation.' }])
  await confirmAction(page, overview, leaveMessage, false)
  await expect(page.getByRole('article', { name: 'Assistant answer', exact: true })).toHaveCount(1)
  await confirmAction(page, overview, leaveMessage, true)
  await expect(page.getByRole('heading', { name: 'Your experience. The right story.' })).toBeVisible()
  await openChat(page)
  await expectReady(page)
  await expectEmpty(page)
  expect((await sendMessage(page, 'After leaving chat.')).messages).toEqual([{ role: 'user', content: 'After leaving chat.' }])
})

test('reload does not persist conversation, draft, generated query, sources or consent', async ({ page, request }) => {
  const before = await request.get('/api/workspace')
  expect(before.status()).toBe(200)
  const workspace = await before.json()
  await openChat(page)
  await expectReady(page)
  await page.getByRole('textbox', { name: 'Your message', exact: true }).fill('Fictional reload conversation marker.')
  await page.getByRole('checkbox', { name: searchLabel, exact: true }).check()
  await page.getByRole('checkbox', { name: consentLabel(), exact: true }).check()
  await sendMessage(page, 'Fictional reload conversation marker.')
  await page.getByRole('textbox', { name: 'Your message', exact: true }).fill('Fictional reload draft marker.')
  await page.getByRole('checkbox', { name: searchLabel, exact: true }).check()
  await page.getByRole('checkbox', { name: consentLabel(), exact: true }).check()
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))
  for (const marker of ['Fictional reload conversation marker.', 'Fictional reload draft marker.', generatedQuery, webAnswer, ...rankedSources.flatMap(source => [source.title, source.url, source.snippet])]) {
    expect(storage).not.toContain(marker)
  }
  // Chromium may show beforeunload after user interaction. Accept if emitted,
  // without waiting for a dialog on browsers that do not show it.
  const acceptUnload = async (dialog: import('@playwright/test').Dialog) => {
    expect(dialog.type()).toBe('beforeunload')
    await dialog.accept()
  }
  page.on('dialog', acceptUnload)
  try { await page.reload() } finally { page.off('dialog', acceptUnload) }
  await expect(page.getByRole('heading', { name: 'Your experience. The right story.' })).toBeVisible()
  await openChat(page)
  await expectReady(page)
  await expectEmpty(page)
  await expect(page.getByRole('heading', { name: 'Sources for this answer' })).toHaveCount(0)
  await expect(page.getByText(`Searched: ${generatedQuery}`, { exact: true })).toHaveCount(0)
  await page.getByRole('checkbox', { name: searchLabel, exact: true }).check()
  await expectNoManualQuery(page)
  await expect(page.getByRole('checkbox', { name: consentLabel(), exact: true })).not.toBeChecked()
  await page.getByRole('checkbox', { name: searchLabel, exact: true }).uncheck()
  expect((await sendMessage(page, 'A new message after reload.')).messages).toEqual([{ role: 'user', content: 'A new message after reload.' }])
  const after = await request.get('/api/workspace')
  expect(after.status()).toBe(200)
  expect(await after.json()).toEqual(workspace)
})