import { test, expect, pdfBuffer, expectNoOverflow } from './helpers.ts'

const resume = 'ALEX EXAMPLE\nFictional professional resume for chart tests.\nEXPERIENCE\nExample Labs | Senior Engineer | 2021–Present\nExample Studio | Junior Developer | 2018–2021\nEDUCATION\nExample University | Software Engineer Degree | 2014–2018'

test('career connectors join actual chronological dots across flat rows, gaps and overlaps', async ({ page }, testInfo) => {
  const text = [
    'ALEX EXAMPLE', 'Fictional connected career.', 'EXPERIENCE',
    'Example A | Java Developer | Jan 2004–Dec 2005',
    'Example B | Software Engineer | Jan 2007–Dec 2008',
    'Example C | Senior Manager | Jan 2010–Dec 2012',
    'Example D | Software Development Manager | Jan 2011–Dec 2015',
    'Example E | Software Engineering Director | Jan 2017–Present',
  ].join('\n')
  await page.getByLabel('Upload base resume PDF').setInputFiles({ name: 'connected-career.pdf', mimeType: 'application/pdf', buffer: await pdfBuffer(text) })
  const chart = page.getByRole('region', { name: 'Career path', exact: true })
  await expect(chart).toContainText('5 roles detected')
  await expect(chart.locator('.career-connector')).toHaveCount(4)
  const endpoints = []
  for (const company of ['Example A', 'Example B', 'Example C', 'Example D', 'Example E']) {
    const period = chart.locator('.career-period').filter({ has: page.locator('.career-company', { hasText: company }) })
    endpoints.push(await period.locator('.career-dot').evaluateAll(dots => dots.map(dot => ({ x: dot.getAttribute('cx'), y: dot.getAttribute('cy') }))))
  }
  const connections = await chart.locator('.career-connector').evaluateAll(lines => lines.map(line => ({
    x1: line.getAttribute('x1'), y1: line.getAttribute('y1'), x2: line.getAttribute('x2'), y2: line.getAttribute('y2'),
  })))
  for (let i = 0; i < connections.length; i++) {
    expect(connections[i]).toEqual({ x1: endpoints[i][1].x, y1: endpoints[i][1].y, x2: endpoints[i + 1][0].x, y2: endpoints[i + 1][0].y })
  }
  expect(connections[0].y1).toBe(connections[0].y2)
  expect(Number(connections[0].x1)).toBeLessThan(Number(connections[0].x2))
  expect(Number(connections[1].y1)).toBeGreaterThan(Number(connections[1].y2))
  expect(Number(connections[2].x1)).toBeGreaterThan(Number(connections[2].x2))
  expect(Number(connections[2].y1)).toBeLessThan(Number(connections[2].y2))
  await expect(chart.locator('.career-connection-note')).toContainText('do not imply continuous employment')
  await expect(chart.locator('.career-connector').first()).toHaveCSS('stroke-dasharray', '6px, 4px')
  await chart.screenshot({ path: testInfo.outputPath('career-connected-periods.png') })
  await chart.getByRole('button', { name: 'Regenerate career path', exact: true }).click()
  await expect(chart.getByRole('status')).toContainText('regenerated')
  await expect(chart.locator('.career-connector')).toHaveCount(4)
  await page.getByRole('button', { name: 'Overview', exact: true }).click()
  await expect(chart.locator('.career-connector')).toHaveCount(4)
  await page.reload()
  await expect(chart.locator('.career-connector')).toHaveCount(4)
  await page.setViewportSize({ width: 320, height: 1000 })
  await expectNoOverflow(page)
})

test('Java Developer and Software Engineer share one Y-row while senior roles stay separate', async ({ page, request }) => {
  const text = [
    'ALEX EXAMPLE', 'Fictional software career.', 'EXPERIENCE',
    'Example Labs | Java Developer | 2004–2005',
    'Example Studio | Software Engineer | 2005–2008',
    'Example Systems | Senior Java Developer | 2008–2012',
    'Example Tools | Senior Software Engineer | 2012–2015',
  ].join('\n')
  await page.getByLabel('Upload base resume PDF').setInputFiles({ name: 'developer-example.pdf', mimeType: 'application/pdf', buffer: await pdfBuffer(text) })
  const chart = page.getByRole('region', { name: 'Career path', exact: true })
  await expect(chart).toContainText('4 roles detected')
  const before = await (await request.get('/api/workspace')).json()
  const rows = chart.locator('.career-title-row')
  await expect(chart.locator('.career-job')).toHaveText(['Senior Software Engineer', 'Software Engineer'])
  for (const row of [rows.nth(0), rows.nth(1)]) {
    await expect(row.locator('.career-bar')).toHaveCount(2)
    const heights = await row.locator('.career-bar').evaluateAll(bars => bars.flatMap(bar => [bar.getAttribute('y1'), bar.getAttribute('y2')]))
    expect(new Set(heights).size).toBe(1)
  }
  const seniorY = await rows.nth(0).locator('.career-bar').first().getAttribute('y1')
  await expect(rows.nth(1).locator('.career-bar').first()).not.toHaveAttribute('y1', seniorY!)
  await expect(rows.nth(1).locator('.career-company')).toHaveText(['Example Studio', 'Example Labs'])
  await expect(rows.nth(1).locator('.career-period > title')).toContainText(['Software Engineer', 'Java Developer'])
  await chart.getByText('Review detected roles and source text', { exact: true }).click()
  await expect(chart.getByRole('heading', { name: 'Java Developer', exact: true })).toBeVisible()
  await chart.getByRole('button', { name: 'Regenerate career path', exact: true }).click()
  await expect(chart.getByRole('status')).toContainText('regenerated')
  await expect(rows).toHaveCount(2)
  await page.reload()
  await expect(rows).toHaveCount(2)
  await page.setViewportSize({ width: 320, height: 1000 })
  await expectNoOverflow(page)
  const after = await (await request.get('/api/workspace')).json()
  expect(after.base).toEqual(before.base)
  expect(after.versions).toEqual(before.versions)
})

test('equivalent manager and director titles stay flat across companies without rewriting source titles', async ({ page, request }, testInfo) => {
  const text = [
    'ALEX EXAMPLE', 'Fictional career with equivalent software leadership titles.', 'EXPERIENCE',
    'Example Labs | Software Development Manager | Dec 2015–Nov 2017',
    'Example Studio | Manager of Software Development | Jul 2018–Aug 2019',
    'Example Apparel | Software Engineer Director | Aug 2019–Aug 2020',
    'Example Toys | Director of Software Engineering | Nov 2020–Dec 2023',
    'Example Games | Software Engineerng Director | Jan 2024–Present',
    'Example Systems | Senior Software Engineering Manager | 2013–2014',
    'Example Tools | Software Engineer | 2010–2012',
  ].join('\n')
  await page.getByLabel('Upload base resume PDF').setInputFiles({ name: 'equivalent-titles.pdf', mimeType: 'application/pdf', buffer: await pdfBuffer(text) })
  const chart = page.getByRole('region', { name: 'Career path', exact: true })
  await expect(chart).toContainText('7 roles detected')
  const before = await (await request.get('/api/workspace')).json()
  const rows = chart.locator('.career-title-row')
  await expect(rows).toHaveCount(4)
  await expect(rows.nth(0).locator('.career-job')).toHaveText('Software Engineering Director')
  await expect(rows.nth(1).locator('title').first()).toHaveText('Senior Software Engineering Manager')
  await expect(rows.nth(2).locator('.career-job')).toHaveText('Software Engineering Manager')
  await expect(rows.nth(0).locator('.career-company')).toHaveText(['Example Games', 'Example Toys', 'Example Apparel'])
  await expect(rows.nth(1).locator('.career-company')).toHaveText(['Example Systems'])
  await expect(rows.nth(2).locator('.career-company')).toHaveText(['Example Studio', 'Example Labs'])
  await expect(rows.nth(2).locator('.career-tick')).toHaveText(['Jul 2018–Aug 2019', 'Dec 2015–Nov 2017'])
  for (const [index, count] of [[0, 3], [2, 2]]) {
    const bars = rows.nth(index).locator('.career-bar')
    await expect(bars).toHaveCount(count)
    const y = await bars.evaluateAll(lines => lines.flatMap(line => [line.getAttribute('y1'), line.getAttribute('y2')]))
    expect(new Set(y).size).toBe(1)
  }
  const rowHeights = await rows.evaluateAll(groups => groups.map(group => group.querySelector('.career-bar')!.getAttribute('y1')))
  expect(new Set(rowHeights).size).toBe(4)
  expect(Number(rowHeights[0])).toBeLessThan(Number(rowHeights[1]))
  expect(Number(rowHeights[1])).toBeLessThan(Number(rowHeights[2]))
  expect(Number(rowHeights[2])).toBeLessThan(Number(rowHeights[3]))
  await expect(chart.locator('.career-period > title')).toContainText(['Software Engineerng Director', 'Director of Software Engineering', 'Software Engineer Director', 'Senior Software Engineering Manager', 'Manager of Software Development', 'Software Development Manager', 'Software Engineer'])
  await chart.screenshot({ path: testInfo.outputPath('career-unified-title-rows.png') })
  await chart.getByText('Review detected roles and source text', { exact: true }).click()
  for (const title of ['Software Development Manager', 'Manager of Software Development', 'Software Engineer Director', 'Director of Software Engineering']) {
    await expect(chart.getByRole('heading', { name: title, exact: true })).toBeVisible()
  }
  await chart.getByRole('button', { name: 'Regenerate career path', exact: true }).click()
  await expect(chart.getByRole('status')).toContainText('regenerated')
  await expect(rows).toHaveCount(4)
  await page.reload()
  await expect(rows).toHaveCount(4)
  await expect(rows.nth(1).locator('.career-company')).toHaveText(['Example Systems'])
  await expect(rows.nth(2).locator('.career-company')).toHaveText(['Example Studio', 'Example Labs'])
  await page.setViewportSize({ width: 320, height: 1000 })
  await expectNoOverflow(page)
  const after = await (await request.get('/api/workspace')).json()
  expect(after.base).toEqual(before.base)
  expect(after.versions).toEqual(before.versions)
})

test('regeneration rebuilds employer labels from profile employer-title-date blocks', async ({ page, request }) => {
  await page.getByLabel('Upload base resume PDF').setInputFiles({ name: 'profile-example.pdf', mimeType: 'application/pdf', buffer: await pdfBuffer(resume) })
  const chart = page.getByRole('region', { name: 'Career path', exact: true })
  await expect(chart).toContainText('2 roles detected')
  const workspace = await (await request.get('/api/workspace')).json()
  const text = [
    'ALEX EXAMPLE', 'Experience', 'Example Labs', '6 years', 'Senior Manager', 'January 2024 - Present',
    'Example City', 'Built fictional software.', 'Senior Manager', 'November 2020 - December 2023',
    '', 'atlaswear', '', 'Software Engineerng Director', '', 'August 2019 - August 2020 (1 year 1 month)', '', 'Example City',
    'Projects', 'Built fictional software.', '', 'Earlier Studio', '', 'Engineer', '', '2015–2018 (3 years)',
    'Education', 'Example University', 'Software Engineer Degree', '2010–2014',
  ].join('\n')
  expect((await request.patch(`/api/base/${workspace.base.id}`, { data: { text } })).status()).toBe(200)
  await chart.getByRole('button', { name: 'Regenerate career path', exact: true }).click()
  await expect(chart.getByRole('status')).toContainText('regenerated')
  await expect(chart).toContainText('4 roles detected')
  await expect(chart.locator('.career-company')).toHaveText(['atlaswear', 'Example Labs', 'Example Labs', 'Earlier Studio'])
  const labs = chart.locator('.career-title-row').nth(1)
  await expect(labs.locator('.career-job')).toHaveText(['Senior Manager'])
  await expect(labs.locator('.career-bar')).toHaveCount(2)
  const company = chart.locator('.career-title-row').first()
  await expect(company.locator('.career-job')).toHaveText(['Software Engineering Director'])
  await expect(company.locator('.career-period > title')).toContainText(['Software Engineerng Director'])
  await expect(company.locator('.career-tick')).toHaveText(['August 2019 - August 2020'])
  await expect(chart.getByRole('img')).not.toContainText('Example City')
  await expect(chart.getByRole('img')).not.toContainText('Example University')
  await chart.getByText('Review detected roles and source text', { exact: true }).click()
  await expect(chart.locator('.career-evidence blockquote').filter({ hasText: 'atlaswear' })).toHaveCount(1)
  await expect(chart.locator('.career-evidence blockquote').filter({ hasText: 'Example Labs' })).toHaveCount(2)
  await page.reload()
  await expect(chart.locator('.career-company')).toHaveText(['atlaswear', 'Example Labs', 'Example Labs', 'Earlier Studio'])
  await page.setViewportSize({ width: 320, height: 1000 })
  await expectNoOverflow(page)
  const latest = await (await request.get('/api/workspace')).json()
  expect(latest.base.text).toBe(text)
  expect(latest.versions).toEqual(workspace.versions)
})

test('matching titles share the same Y-height across companies and separate employment periods', async ({ page }, testInfo) => {
  const text = [
    'ALEX EXAMPLE', 'Fictional career grouping example.', 'EXPERIENCE',
    'Example Labs | Senior Manager | Jan 2023–Present',
    'Example Labs | Senior Manager | Jan 2021–Dec 2022',
    'example labs | senior manager | Jan 2020–Jun 2021',
    'Example Labs | Engineer | 2018–2019',
    'Example Studio | Senior Manager | 2015–2017',
    'Junior Engineer | 2009–2011',
  ].join('\n')
  await page.getByLabel('Upload base resume PDF').setInputFiles({ name: 'grouped-career.pdf', mimeType: 'application/pdf', buffer: await pdfBuffer(text) })
  const chart = page.getByRole('region', { name: 'Career path', exact: true })
  await expect(chart).toContainText('6 roles detected')
  await expect(chart.locator('.career-company')).toHaveText(['Example Labs', 'Example Labs', 'example labs', 'Example Studio', 'Example Labs', 'Company not stated'])
  const rows = chart.locator('.career-title-row')
  await expect(rows).toHaveCount(3)
  await expect(chart.locator('.career-job')).toHaveText(['Senior Manager', 'Engineer', 'Junior Engineer'])
  const senior = rows.first()
  await expect(senior.locator('.career-bar')).toHaveCount(4)
  await expect(senior.locator('.career-company')).toHaveText(['Example Labs', 'Example Labs', 'example labs', 'Example Studio'])
  await expect(senior.locator('.career-tick')).toHaveText(['Jan 2023–Present', 'Jan 2021–Dec 2022', 'Jan 2020–Jun 2021', '2015–2017'])
  const bars = await senior.locator('.career-bar').evaluateAll(lines => lines.map(line => ({ x: line.getAttribute('x1'), y1: line.getAttribute('y1'), y2: line.getAttribute('y2') })))
  expect(new Set(bars.map(bar => bar.x)).size).toBe(4)
  expect(new Set(bars.flatMap(bar => [bar.y1, bar.y2])).size).toBe(1)
  await expect(senior.locator('.career-bar.current')).toHaveCount(1)
  await expect(rows.nth(1).locator('.career-bar')).not.toHaveAttribute('y1', bars[0].y1!)
  await expect(rows.nth(2).locator('.career-bar')).not.toHaveAttribute('y1', bars[0].y1!)
  await expect(chart.locator('.career-bar')).toHaveCount(6)
  await chart.getByText('Review detected roles and source text', { exact: true }).click()
  await expect(chart.locator('.career-evidence li')).toHaveCount(6)
  await expect(chart.locator('.career-evidence')).toContainText('example labs')
  await chart.getByText('Review detected roles and source text', { exact: true }).click()
  await chart.screenshot({ path: testInfo.outputPath('career-shared-title-rows.png') })
  await page.setViewportSize({ width: 320, height: 1000 })
  await expectNoOverflow(page)
  const scroll = chart.getByRole('region', { name: 'Scrollable career timeline' })
  await scroll.focus()
  await expect(scroll).toBeFocused()
  expect(await scroll.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true)
  await page.getByRole('button', { name: 'Overview', exact: true }).click()
  await expect(chart.locator('.career-title-row')).toHaveCount(3)
  await chart.getByRole('button', { name: 'Regenerate career path', exact: true }).click()
  await expect(chart.getByRole('status')).toContainText('regenerated')
  await expect(chart.locator('.career-bar')).toHaveCount(6)
  const regeneratedY = await rows.first().locator('.career-bar').evaluateAll(lines => lines.map(line => line.getAttribute('y1')))
  expect(new Set(regeneratedY).size).toBe(1)
})

test('regeneration includes earlier employment after nested project headings and uses real title lines', async ({ page, request }) => {
  await page.getByLabel('Upload base resume PDF').setInputFiles({ name: 'career-example.pdf', mimeType: 'application/pdf', buffer: await pdfBuffer(resume) })
  const chart = page.getByRole('region', { name: 'Career path', exact: true })
  await expect(chart).toContainText('2 roles detected')
  const workspace = await (await request.get('/api/workspace')).json()
  const text = [
    'ALEX EXAMPLE', 'Experience', 'Example Employer', 'Senior Engineer', 'August 2019 - Present (7 years 2 months)',
    'Projects', 'Example Project | Lead Engineer | 2019–2020', 'Built fictional project features.', '',
    'Another Employer', 'Software Engineer', 'July 2018 - August 2019 (1 year 2 months)',
    'Projects:', 'Example Project | Engineer | 2018–2019', '',
    'Earlier Employer', 'Junior Engineer', 'October 2004 - September 2005 (1 year)',
    'Education', 'Example University', 'Software Engineer Degree', '2000–2004 (4 years)',
  ].join('\n')
  expect((await request.patch(`/api/base/${workspace.base.id}`, { data: { text } })).status()).toBe(200)
  await chart.getByRole('button', { name: 'Regenerate career path', exact: true }).click()
  await expect(chart.locator('.career-job')).toHaveText(['Senior Engineer', 'Software Engineer', 'Junior Engineer'])
  await expect(chart.getByRole('img')).toContainText('October 2004 - September 2005')
  await expect(chart.getByRole('img')).toContainText('July 2018 - August 2019')
  await chart.getByText('Review detected roles and source text', { exact: true }).click()
  await expect(chart.getByRole('heading', { name: 'Junior Engineer', exact: true })).toBeVisible()
  await expect(chart).not.toContainText('Software Engineer Degree')
  await page.setViewportSize({ width: 320, height: 1000 })
  await expectNoOverflow(page)
})

test('career bars use original titles and month dates from the resume', async ({ page }, testInfo) => {
  const text = 'ALEX EXAMPLE\nFictional resume with month-specific employment history.\nEXPERIENCE\nExample Studio | Scrum Master | Feb 2020 - Oct 2020\nExample Labs | Product Owner | Nov 2020 - Present'
  const pdf = await pdfBuffer(text)
  await page.getByLabel('Upload base resume PDF').setInputFiles({ name: 'monthly-career.pdf', mimeType: 'application/pdf', buffer: pdf })
  const chart = page.getByRole('region', { name: 'Career path', exact: true })
  await expect(chart).toContainText('2 roles detected')
  await expect(chart.locator('.career-job')).toHaveText(['Product Owner', 'Scrum Master'])
  await expect(chart.getByRole('img')).toContainText('Feb 2020 - Oct 2020')
  await expect(chart.getByRole('img')).toContainText('Nov 2020 - Present')
  const bar = chart.locator('.career-bar').last()
  const before = await bar.getAttribute('x1')
  await page.getByRole('button', { name: 'Edit extracted text', exact: true }).click()
  await page.getByLabel('Base resume text').fill(text.replace('Feb 2020', 'May 2020'))
  await expect(bar).toHaveAttribute('x1', before!)
  await page.getByRole('button', { name: 'Save text', exact: true }).click()
  await expect(chart.getByRole('img')).toContainText('May 2020 - Oct 2020')
  await expect(bar).not.toHaveAttribute('x1', before!)
  await chart.getByText('Review detected roles and source text', { exact: true }).click()
  await expect(chart.getByRole('heading', { name: 'Scrum Master', exact: true })).toBeVisible()
  await chart.screenshot({ path: testInfo.outputPath('career-source-dates.png') })
})

for (const width of [1440, 320]) {
  test(`career path uses saved base text and fits ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 })
    const pdf = await pdfBuffer(resume)
    await page.getByLabel('Upload base resume PDF').setInputFiles({ name: 'career-example.pdf', mimeType: 'application/pdf', buffer: pdf })
    const chart = page.getByRole('region', { name: 'Career path', exact: true })
    await expect(chart).toContainText('2 roles detected')
    await expect(chart.getByRole('img', { name: /Career path by year/ })).toBeVisible()
    await expect(chart).toContainText('Job title / level')
    await expect(chart).toContainText('Year')
    await expectNoOverflow(page)
    await chart.getByText('Review detected roles and source text', { exact: true }).click()
    await expect(chart.getByRole('heading', { name: 'Senior Engineer', exact: true })).toBeVisible()
    await expect(chart).not.toContainText('Software Engineer Degree')

    await page.getByRole('button', { name: 'Edit extracted text', exact: true }).click()
    await page.getByLabel('Base resume text').fill(resume.replace('Senior Engineer', 'Principal Engineer'))
    await expect(chart.getByRole('button', { name: 'Regenerate career path', exact: true })).toBeDisabled()
    await expect(chart).toContainText('Save or discard your base resume edits before regenerating.')
    await expect(chart).not.toContainText('Principal Engineer')
    await page.getByRole('button', { name: 'Save text', exact: true }).click()
    await expect(chart).toContainText('Principal Engineer')
    await expect(chart.getByRole('button', { name: 'Regenerate career path', exact: true })).toBeEnabled()
    await page.getByRole('button', { name: 'Overview', exact: true }).click()
    await expect(chart).toContainText('Principal Engineer')
    await page.reload()
    await expect(chart).toContainText('Principal Engineer')
    await expectNoOverflow(page)

    await page.getByRole('button', { name: 'Base resume', exact: true }).click()
    await page.getByRole('button', { name: 'Edit extracted text', exact: true }).click()
    await page.getByLabel('Base resume text').fill('ALEX EXAMPLE\nSUMMARY\nSoftware engineer building accessible products. Dates and career history have not been provided.')
    await page.getByRole('button', { name: 'Save text', exact: true }).click()
    await expect(chart).toContainText('No dated roles detected yet')
    await expect(chart.getByRole('img')).toHaveCount(0)
    await expect(chart.locator('.career-connector')).toHaveCount(0)
    await expectNoOverflow(page)
  })
}

test('regenerate loads latest saved base edits and replacement without modifying stored versions', async ({ page, request }) => {
  const pdf = await pdfBuffer(resume)
  await page.getByLabel('Upload base resume PDF').setInputFiles({ name: 'career-example.pdf', mimeType: 'application/pdf', buffer: pdf })
  const chart = page.getByRole('region', { name: 'Career path', exact: true })
  await expect(chart).toContainText('Senior Engineer')
  const original = await (await request.get('/api/workspace')).json()
  const updated = resume.replace('Senior Engineer', 'Principal Engineer').replace('2021–Present', '2023–Present')
  expect((await request.patch(`/api/base/${original.base.id}`, { data: { text: updated } })).status()).toBe(200)
  await expect(chart).not.toContainText('Principal Engineer')
  await chart.getByRole('button', { name: 'Regenerate career path', exact: true }).click()
  await expect(chart).toContainText('Principal Engineer')
  await expect(chart.getByRole('status')).toHaveText('Career path regenerated from the latest saved base resume.')
  await expect(chart).toContainText('2023–Present')
  await expect(page.getByRole('article', { name: 'Resume preview' })).toContainText('Principal Engineer')

  const replacementText = 'ALEX EXAMPLE\nFictional replacement resume with a different career.\nEXPERIENCE\nExample Studio | Product Owner | Feb 2022 - Present'
  const replacement = await pdfBuffer(replacementText)
  expect((await request.post('/api/base', { multipart: { resume: { name: 'replacement.pdf', mimeType: 'application/pdf', buffer: replacement } } })).status()).toBe(201)
  await page.getByRole('button', { name: 'Overview', exact: true }).click()
  await chart.getByRole('button', { name: 'Regenerate career path', exact: true }).click()
  await expect(chart.locator('.career-job')).toHaveText(['Product Owner'])
  await expect(chart.locator('.career-connector')).toHaveCount(0)
  await expect(chart.locator('.career-connection-note')).toHaveCount(0)
  await expect(chart).not.toContainText('Principal Engineer')
  await expect(page.locator('.base-file strong')).toHaveText('replacement.pdf')
  const latest = await (await request.get('/api/workspace')).json()
  expect(latest.versions).toEqual(original.versions)
  expect(latest.base.id).not.toBe(original.base.id)
  // An unchanged source can also be explicitly regenerated.
  await chart.getByRole('button', { name: 'Regenerate career path', exact: true }).click()
  await expect(chart.getByRole('status')).toHaveText('Career path regenerated from the latest saved base resume.')
})

test('regeneration preserves chart on failure, locks editing and deduplicates pending requests', async ({ page, expectedHttpErrors }) => {
  const pdf = await pdfBuffer(resume)
  await page.getByLabel('Upload base resume PDF').setInputFiles({ name: 'career-example.pdf', mimeType: 'application/pdf', buffer: pdf })
  const chart = page.getByRole('region', { name: 'Career path', exact: true })
  await expect(chart).toContainText('Senior Engineer')
  expectedHttpErrors.push({ url: 'http://127.0.0.1:3101/api/workspace', status: 503 })
  await page.route('**/api/workspace', route => route.fulfill({ status: 503, json: { error: 'Fictional refresh failure.' } }), { times: 1 })
  await chart.getByRole('button', { name: 'Regenerate career path', exact: true }).click()
  await expect(chart.getByRole('alert')).toContainText('Fictional refresh failure.')
  await expect(chart).toContainText('Senior Engineer')

  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let arrived!: () => void
  const intercepted = new Promise<void>(resolve => { arrived = resolve })
  let requests = 0
  await page.route('**/api/workspace', async route => {
    requests++
    arrived()
    await gate
    await route.continue()
  })
  try {
    await chart.getByRole('button', { name: 'Regenerate career path', exact: true }).click()
    await intercepted
    const busy = chart.getByRole('button', { name: 'Regenerating…', exact: true })
    await expect(busy).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Edit extracted text', exact: true })).toBeDisabled()
    await expect(page.getByLabel('Upload base resume PDF')).toBeDisabled()
    await busy.evaluate(button => button.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await expectNoOverflow(page)
  } finally { release() }
  await expect(chart.getByRole('status')).toContainText('regenerated from the latest saved base resume')
  expect(requests).toBe(1)
  await expect(chart.getByRole('alert')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Edit extracted text', exact: true })).toBeEnabled()
})