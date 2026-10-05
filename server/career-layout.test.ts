import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseCareer } from '../src/career.ts'
import { layoutCareer, unifyCareerTitle } from '../src/career-layout.ts'

const jobsFrom = (...lines: string[]) => parseCareer(['EXPERIENCE', ...lines].join('\n'), 2026).jobs

describe('shared-title career layout across employers', () => {
  it('connects chronological end/start dots across flat rows, gaps and level changes', () => {
    const jobs = jobsFrom(
      'Example A | Java Developer | Jan 2004–Dec 2005',
      'Example B | Software Engineer | Jan 2007–Dec 2008',
      'Example C | Senior Manager | Jan 2010–Dec 2012',
      'Example D | Software Development Manager | Jan 2014–Dec 2015',
    )
    const original = structuredClone(jobs)
    const { rows, connections } = layoutCareer(jobs)
    assert.equal(connections.length, 3)
    assert.deepEqual(connections.map(({ from, to }) => [from.job.company, to.job.company]), [
      ['Example A', 'Example B'], ['Example B', 'Example C'], ['Example C', 'Example D'],
    ])
    assert.equal(connections[0].from.y, connections[0].to.y)
    assert.ok(connections[0].from.job.endValue < connections[0].to.job.startValue)
    assert.ok(connections[1].from.y > connections[1].to.y)
    assert.ok(connections[2].from.y < connections[2].to.y)
    for (const { from, to } of connections) {
      assert.equal(from.y, rows.find(row => row.jobs.includes(from.job))!.y)
      assert.equal(to.y, rows.find(row => row.jobs.includes(to.job))!.y)
    }
    assert.deepEqual(jobs, original)
  })

  it('preserves overlapping dates and gives equal-start periods a deterministic sequence', () => {
    const jobs = jobsFrom(
      'Example B | Senior Manager | 2020–2023',
      'Example A | Senior Manager | 2020–2023',
      'Example C | Software Engineer | 2021–Present',
    )
    const { connections } = layoutCareer(jobs)
    assert.equal(connections.length, 2)
    assert.deepEqual(connections.map(({ from, to }) => [from.job.company, to.job.company]), [
      ['Example A', 'Example B'], ['Example B', 'Example C'],
    ])
    assert.ok(connections.every(({ from, to }) => from.job.endValue > to.job.startValue))
    assert.deepEqual(layoutCareer([...jobs].reverse()).connections, connections)
  })

  it('only connects displayed inputs and leaves empty or single-role charts unconnected', () => {
    assert.deepEqual(layoutCareer([]).connections, [])
    const jobs = jobsFrom('Example A | Software Engineer | 2000–2001', 'Example B | Senior Engineer | 2005–2008', 'Example C | Director | 2010–Present')
    assert.deepEqual(layoutCareer(jobs.slice(-1)).connections, [])
    const { connections } = layoutCareer(jobs.slice(-2))
    assert.equal(connections.length, 1)
    assert.equal(connections[0].from.job.company, 'Example B')
    assert.equal(connections[0].to.job.company, 'Example C')
  })

  it('places newer software manager roles below older senior managers and below directors', () => {
    const jobs = jobsFrom(
      'Example Systems | Senior Manager of Software Development | 2012–2015',
      'Example Marketplace | Software Development Manager | 2015–2017',
      'Example Travel | Manager of Software Development | 2018–2019',
      'Example Studio | Director of Software Engineering | 2010–2011',
      'Example Labs | Software Engineer | 2024–Present',
    )
    const original = structuredClone(jobs)
    const { rows } = layoutCareer(jobs)
    assert.deepEqual(rows.map(row => row.title), [
      'Software Engineering Director', 'Senior Software Engineering Manager',
      'Software Engineering Manager', 'Software Engineer',
    ])
    assert.ok(rows[0].y < rows[1].y && rows[1].y < rows[2].y && rows[2].y < rows[3].y)
    assert.deepEqual(rows[2].jobs.map(job => job.company), ['Example Travel', 'Example Marketplace'])
    assert.deepEqual(jobs, original)
    assert.deepEqual(layoutCareer([...jobs].reverse()).rows.map(row => row.title), rows.map(row => row.title))
  })

  it('orders generic and abbreviated senior manager titles above unqualified software managers', () => {
    const { rows } = layoutCareer(jobsFrom(
      'Example Systems | Sr. Manager | 2008–2010',
      'Example Tools | Senior Manager | 2010–2012',
      'Example Studio | Software Manager | 2022–Present',
      'Example Labs | Junior Software Engineering Manager | 2020–2021',
    ))
    assert.deepEqual(rows.map(row => row.title), ['Senior Manager', 'Sr. Manager', 'Software Manager', 'Junior Software Engineering Manager'])
  })

  it('uses recency only to order equally ranked or unclassified rows', () => {
    const { rows } = layoutCareer(jobsFrom(
      'Example Systems | Hardware Engineering Manager | 2022–2024',
      'Example Tools | Software Engineering Manager | 2020–2021',
      'Example Studio | Product Owner | 2024–Present',
      'Example Labs | Scrum Master | 2018–2019',
    ))
    assert.deepEqual(rows.map(row => row.title), ['Hardware Engineering Manager', 'Software Engineering Manager', 'Product Owner', 'Scrum Master'])
  })

  it('puts Java Developer and Software Engineer on one row without changing source data', () => {
    for (const title of ['Java Developer', 'Software Engineer', '  JAVA   DEVELOPER ', 'Ｊａｖａ Developer']) {
      assert.equal(unifyCareerTitle(title), 'Software Engineer')
    }
    const jobs = jobsFrom('Example Labs | Java Developer | 2004–2005', 'Example Studio | Software Engineer | 2005–2008')
    const original = structuredClone(jobs)
    const { rows } = layoutCareer(jobs)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].title, 'Software Engineer')
    assert.deepEqual(rows[0].jobs.map(job => job.title), ['Software Engineer', 'Java Developer'])
    assert.deepEqual(rows[0].jobs.map(job => job.company), ['Example Studio', 'Example Labs'])
    assert.deepEqual(jobs, original)
  })

  it('aligns matching developer/engineer qualifications without collapsing levels', () => {
    const qualifiers = ['', 'Junior ', 'Senior ', 'Lead ', 'Staff ', 'Principal ', 'Associate ']
    const { rows } = layoutCareer(jobsFrom(...qualifiers.flatMap(prefix => [
      `Example Labs | ${prefix}Java Developer | 2018–2019`,
      `Example Studio | ${prefix}Software Engineer | 2020–2022`,
    ])))
    assert.equal(rows.length, qualifiers.length)
    assert.equal(new Set(rows.map(row => row.y)).size, qualifiers.length)
    assert.ok(rows.every(row => row.jobs.length === 2))
    assert.equal(unifyCareerTitle('Sr. Java Developer'), 'Senior Software Engineer')
    assert.equal(unifyCareerTitle('Jr. Software Engineer'), 'Junior Software Engineer')
  })

  it('does not absorb other languages, leadership or compound Java titles into Software Engineer', () => {
    for (const title of ['JavaScript Developer', 'Java Developer Manager', 'Java Developer / Architect',
      'Senior Java Developer II', 'Java Developer Intern', 'Hardware Engineer', 'Python Developer']) {
      assert.equal(unifyCareerTitle(title), title)
    }
  })

  it('unifies software manager wording and keeps 2015–2019 employment on one row', () => {
    const titles = ['Software Development Manager', 'Manager of Software Development', 'Software Engineering Manager', 'Manager of Software Engineering']
    for (const title of titles) assert.equal(unifyCareerTitle(title), 'Software Engineering Manager')
    const jobs = jobsFrom(
      'Example Labs | Software Development Manager | Dec 2015–Nov 2017',
      'Example Studio | Manager of Software Development | Jul 2018–Aug 2019',
    )
    const original = structuredClone(jobs)
    const { rows } = layoutCareer(jobs)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].title, 'Software Engineering Manager')
    assert.equal(rows[0].jobs.length, 2)
    assert.deepEqual(rows[0].jobs.map(job => job.dateLabel), ['Jul 2018–Aug 2019', 'Dec 2015–Nov 2017'])
    assert.deepEqual(jobs, original)
    assert.deepEqual(rows[0].jobs.map(job => job.title), [titles[1], titles[0]])
  })

  it('unifies software director wording and the Engineerng variant across employers', () => {
    const titles = ['Software Engineer Director', 'Director of Software Engineering', 'Software Engineerng Director', 'Software Development Director', 'Director, Software Engineering', 'Director - Software Engineering']
    for (const title of titles) assert.equal(unifyCareerTitle(title), 'Software Engineering Director')
    const jobs = jobsFrom(...titles.map((title, i) => `Example Company ${i} | ${title} | ${2015 + i}–${2016 + i}`))
    const { rows } = layoutCareer(jobs)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].jobs.length, titles.length)
    assert.equal(new Set(rows[0].jobs.map(job => job.company)).size, titles.length)
    assert.ok(rows[0].jobs.every(job => job.source.includes(job.title)))
  })

  it('normalizes aliases with cosmetic differences and retains leadership qualifications', () => {
    for (const title of ['  MANAGER OF SOFTWARE   DEVELOPMENT ', 'Ｍａｎａｇｅｒ of Software Development']) {
      assert.equal(unifyCareerTitle(title), 'Software Engineering Manager')
    }
    assert.equal(unifyCareerTitle('Senior Manager of Software Development'), 'Senior Software Engineering Manager')
    assert.equal(unifyCareerTitle('Software Development Sr. Manager'), 'Senior Software Engineering Manager')
    assert.equal(unifyCareerTitle('Jr. Software Development Manager'), 'Junior Software Engineering Manager')
    for (const qualifier of ['Assistant', 'Associate', 'Acting', 'Interim', 'Deputy']) {
      assert.equal(unifyCareerTitle(`${qualifier} Director of Software Engineering`), `${qualifier} Software Engineering Director`)
    }
  })

  it('does not conflate software managers with directors, senior roles, other disciplines or compound titles', () => {
    const titles = ['Software Engineering Manager', 'Software Engineering Director', 'Senior Software Engineering Manager',
      'Software Engineer', 'Product Development Manager', 'Business Development Manager', 'Hardware Engineering Manager',
      'Manager of Software Development and Operations', 'Assistant to Director of Software Engineering',
      'Senior Software Engineering Assistant Director', 'Regional Director of Software Engineering']
    for (const title of titles) assert.equal(unifyCareerTitle(title), title)
    const { rows } = layoutCareer(jobsFrom(...titles.map(title => `Example Labs | ${title} | 2020–2022`)))
    assert.equal(rows.length, titles.length)
    assert.equal(new Set(rows.map(row => row.y)).size, titles.length)
  })

  it('shares one title row across companies without merging date intervals or mutating the source', () => {
    const jobs = jobsFrom(
      'Example Labs | Senior Manager | 2023–Present',
      'Example Studio | Senior Manager | 2021–2022',
      'Example Labs | Senior Manager | 2018–2020',
      'Example Labs | Engineer | 2015–2017',
    )
    const original = structuredClone(jobs)
    const { rows, height } = layoutCareer(jobs)
    assert.deepEqual(rows.map(row => row.title), ['Senior Manager', 'Engineer'])
    assert.deepEqual(rows[0].jobs.map(job => job.dateLabel), ['2023–Present', '2021–2022', '2018–2020'])
    assert.deepEqual(rows[0].jobs.map(job => job.company), ['Example Labs', 'Example Studio', 'Example Labs'])
    assert.ok(rows[0].y < rows[1].y)
    assert.ok(rows[0].top + rows[0].height < rows[1].top)
    assert.ok(rows[1].top + rows[1].height < height)
    assert.deepEqual(jobs, original)
  })

  it('ignores cosmetic title differences regardless of employer but never guesses equivalent levels', () => {
    const base = jobsFrom('Example Labs | Senior Manager | 2020–2022')[0]
    const jobs = [base,
      { ...base, company: '  EXAMPLE   Labs ', title: ' senior  manager ', startValue: 2023 },
      { ...base, company: 'Ｅｘａｍｐｌｅ Labs', title: 'Ｓｅｎｉｏｒ Manager', startValue: 2024 },
      { ...base, company: 'Example Laboratories' },
      { ...base, title: 'Sr. Manager' },
      { ...base, title: 'Senior Engineering Manager' },
    ]
    const { rows } = layoutCareer(jobs)
    assert.equal(rows.length, 3)
    assert.equal(rows[0].jobs.length, 4)
    assert.equal(rows[0].title, 'Ｓｅｎｉｏｒ Manager')
    assert.equal(rows[0].jobs[3].company, 'Example Laboratories')
  })

  it('aligns titles with missing employers without inventing or replacing company names', () => {
    const base = jobsFrom('Example Labs | Engineer | 2020–2022')[0]
    const { rows } = layoutCareer([
      { ...base, company: '' }, { ...base, company: '  ', startValue: 2021 },
      { ...base, company: 'Company not stated' },
    ])
    assert.equal(rows.length, 1)
    assert.equal(rows[0].jobs.length, 3)
    assert.deepEqual(rows[0].jobs.map(job => job.company), ['  ', '', 'Company not stated'])
  })

  it('retains overlapping periods on one title row and reserves space for every date label', () => {
    const { rows } = layoutCareer(jobsFrom(
      'Example Labs | Senior Manager | 2021–2024',
      'Example Labs | Senior Manager | 2020–2022',
      'Example Labs | Junior Manager | 2018–2019',
    ))
    const [senior, junior] = rows
    assert.equal(senior.jobs.length, 2)
    assert.ok(junior.y - senior.y > 42 + 36 * senior.jobs.length)
    assert.ok(junior.y + 42 < junior.top + junior.height)
  })

  it('aligns each of engineer, engineering manager and senior manager across employers', () => {
    const titles = ['Software Engineer', 'Software Engineering Manager', 'Senior Manager']
    const { rows } = layoutCareer(jobsFrom(...titles.flatMap((title, i) => [
      `Example Labs | ${title} | ${2010 + i * 2}–${2011 + i * 2}`,
      `Example Studio | ${title} | ${2017 + i * 2}–${2018 + i * 2}`,
    ])))
    assert.equal(rows.length, 3)
    assert.equal(new Set(rows.map(row => row.y)).size, 3)
    for (const title of titles) {
      const matching = rows.filter(row => row.title === title)
      assert.equal(matching.length, 1)
      assert.equal(matching[0].jobs.length, 2)
      assert.deepEqual(matching[0].jobs.map(job => job.company), ['Example Studio', 'Example Labs'])
    }
  })

  it('handles empty input without invalid chart dimensions', () => {
    const { rows, height } = layoutCareer([])
    assert.deepEqual(rows, [])
    assert.ok(Number.isFinite(height) && height > 0)
  })
})