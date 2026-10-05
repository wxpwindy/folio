import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { careerLevel, parseCareer } from '../src/career.ts'

describe('local career timeline extraction', () => {
  it('sorts jobs by start year, preserves overlaps and reads level from titles only', () => {
    const result = parseCareer('EXPERIENCE\nExample Labs | Senior Engineer | 2021 - Present\nOther Studio | Junior Developer | 2018–2022\nSenior Company | Software Engineer | 2020–2021', 2026)
    assert.deepEqual(result.jobs.map(job => [job.title, job.level, job.startYear, job.endYear, job.current]), [
      ['Junior Developer', 'Junior', 2018, 2022, false],
      ['Software Engineer', 'Not stated', 2020, 2021, false],
      ['Senior Engineer', 'Senior', 2021, 2026, true],
    ])
    assert.equal(result.jobs[2].source, 'Example Labs | Senior Engineer | 2021 - Present')
  })
  it('excludes education and project dates, even when they contain job-like words', () => {
    const text = 'EDUCATION\nExample University | Software Engineer Degree | 2010–2014\nWORK EXPERIENCE\nExample | Engineer | 2015–2020\nPROJECTS\nExample | Lead Developer | 2020–2021'
    assert.equal(parseCareer(text, 2026).jobs.length, 1)
    assert.equal(parseCareer(text, 2026).jobs[0].startYear, 2015)
  })
  it('accepts English months, numeric months, Chinese dates and French headings', () => {
    for (const dates of ['Jan 2020 - Dec 2022', '01/2020 - 12/2022', '2020.01 - 2022.12', '2020年1月–2022年12月']) {
      const jobs = parseCareer(`Experience\nExample | Senior Engineer | ${dates}`, 2026).jobs
      assert.equal(jobs.length, 1, dates)
      assert.deepEqual([jobs[0].startYear, jobs[0].endYear], [2020, 2022])
    }
    assert.equal(parseCareer('EXPÉRIENCE\nExample | Ingénieur logiciel | 2020–2022\nFORMATION\nEngineer | 2010–2014', 2026).jobs.length, 1)
    const chinese = parseCareer('工作经历\n示例公司 | 高级工程师 | 2020年至今', 2026).jobs
    assert.equal(chinese.length, 1)
    assert.equal(chinese[0].level, 'Senior')
    assert.equal(chinese[0].current, true)
  })
  it('uses adjacent role headers without crossing section boundaries', () => {
    const parsed = parseCareer('EXPERIENCE\nSenior Engineer\n2020–2022\nJunior Developer\nExample Company\n2018–2020\nSKILLS\nDirector\n2010–2011', 2026)
    assert.deepEqual(parsed.jobs.map(job => job.title), ['Junior Developer', 'Senior Engineer'])
    assert.match(parsed.jobs[0].source, /Example Company/)
  })
  it('omits invalid or future ranges and leaves ambiguous entries unplotted', () => {
    const result = parseCareer('EXPERIENCE\nEngineer | 2025–2020\nEngineer | 2020–2030\n2020–2021\nEngineer | 2020–2021, 2023–2024', 2026)
    assert.equal(result.jobs.length, 0)
    assert.equal(result.skipped, 4)
  })
  it('keeps same-year jobs, deduplicates repeated PDF headers and handles empty input', () => {
    const line = 'Example | Intern | 2020–2020'
    assert.equal(parseCareer(`${line}\n${line}`, 2026).jobs.length, 1)
    assert.deepEqual(parseCareer('', 2026), { jobs: [], skipped: 0 })
    assert.equal(parseCareer('SUMMARY\nEngineer with 2010–2020 experience.', 2026).jobs.length, 0)
  })
  it('does not derive seniority from years or company name', () => {
    assert.equal(careerLevel('Software Engineer'), 'Not stated')
    assert.equal(careerLevel('Staff Engineer'), 'Staff')
    assert.equal(careerLevel('Engineering Manager'), 'Manager / head')
    assert.equal(careerLevel('Principal Engineer'), 'Principal')
    assert.equal(careerLevel('Junior Engineer'), 'Junior')
  })

  it('keeps unfamiliar titles exactly as written instead of requiring a keyword', () => {
    const result = parseCareer('EXPERIENCE\nExample Studio | Scrum Master | Feb 2020 – Oct 2020\nExample Labs | Product Owner | Nov 2020 - Present\n职位：客户成功合伙人 | 公司：示例公司 | 2019年3月–2019年8月', new Date(2026, 9, 4))
    assert.deepEqual(result.jobs.map(job => job.title), ['客户成功合伙人', 'Scrum Master', 'Product Owner'])
    assert.equal(result.jobs[1].level, 'Not stated')
    assert.equal(result.jobs[1].dateLabel, 'Feb 2020 – Oct 2020')
    assert.equal(result.jobs[2].dateLabel, 'Nov 2020 - Present')
  })

  it('reads unfamiliar standalone or labelled titles before and after date headers', () => {
    for (const block of [
      'Product Owner\nFeb 2020 - Oct 2020',
      'Feb 2020 - Oct 2020\nProduct Owner',
      'Example Company | Feb 2020 - Oct 2020\nProduct Owner',
      'Title: Product Owner\nExample Company\nFeb 2020 - Oct 2020',
      'Product Owner at Example Company | Feb 2020 - Oct 2020',
      'Feb 2020 - Oct 2020 | Product Owner',
    ]) {
      const jobs = parseCareer(block, 2026).jobs
      assert.equal(jobs.length, 1, block)
      assert.equal(jobs[0].title, 'Product Owner', block)
    }
  })

  it('positions and orders roles by source months, including separate same-year stints', () => {
    const jobs = parseCareer('EXPERIENCE\nExample | Product Owner | Nov 2020–Dec 2020\nExample | Product Owner | 02/2020–04/2020', 2026).jobs
    assert.equal(jobs.length, 2)
    assert.equal(jobs[0].startMonth, 2)
    assert.equal(jobs[0].endMonth, 4)
    assert.equal(jobs[0].startValue, 2020 + 1 / 12)
    assert.equal(jobs[0].endValue, 2020 + 4 / 12)
    assert.equal(jobs[1].startMonth, 11)
    assert.equal(jobs[1].endValue, 2021)
  })

  it('keeps year-only precision and clips Present at the supplied current date', () => {
    const jobs = parseCareer('EXPERIENCE\nExample | Product Owner | 2020–2021\nExample | Product Owner | 2022-03–Present', new Date(2026, 9, 4)).jobs
    assert.equal(jobs[0].startMonth, undefined)
    assert.equal(jobs[0].endMonth, undefined)
    assert.equal(jobs[0].startValue, 2020)
    assert.equal(jobs[0].endValue, 2022)
    assert.equal(jobs[1].startMonth, 3)
    assert.equal(jobs[1].endMonth, undefined)
    assert.ok(jobs[1].endValue > 2026 + 9 / 12 && jobs[1].endValue < 2026 + 10 / 12)
  })

  it('rejects invalid months and reversed monthly ranges rather than falling back to years', () => {
    for (const dates of ['13/2020–12/2021', '2020.00–2021.01', 'May 2020–Feb 2020', '2027-01–Present']) {
      assert.equal(parseCareer(`EXPERIENCE\nProduct Owner | ${dates}`, new Date(2026, 9, 4)).jobs.length, 0, dates)
    }
    assert.equal(parseCareer('EXPERIENCE\nWorked on sales campaigns 2020–2021\n• Led project delivery 2021–2022', 2026).jobs.length, 0)
  })

  it('uses actual role headers rather than profile-export duration annotations', () => {
    const text = 'Experience\nExample Company\n4 years 2 months\nSenior Software Engineer\nJanuary 2024 - Present (2 years 9 months)\nExample City\nBuilt fictional applications.\n\nExample Studio\nSoftware Engineer\nAugust 2019 - August 2020 (1 year 1 month)'
    const jobs = parseCareer(text, new Date(2026, 9, 4)).jobs
    assert.deepEqual(jobs.map(job => job.title), ['Software Engineer', 'Senior Software Engineer'])
    assert.deepEqual(jobs.map(job => job.company), ['Example Studio', 'Example Company'])
    assert.equal(jobs[1].dateLabel, 'January 2024 - Present')
    assert.match(jobs[1].source, /Senior Software Engineer\nJanuary 2024 - Present \(2 years 9 months\)/)
    assert.equal(parseCareer('Experience\n2 years 4 months\nJanuary 2020 - May 2022 (2 years 4 months)', 2026).jobs.length, 0)
  })

  it('reads brand names before titles and dates across blank lines, not locations after dates', () => {
    for (const separator of ['\n', '\n\n', '\n\n\n']) {
      const block = ['atlaswear', 'Software Engineerng Director', 'August 2019 - August 2020 (1 year 1 month)', 'Example City'].join(separator)
      const { jobs } = parseCareer(`Experience\n${block}`, 2026)
      assert.equal(jobs.length, 1)
      assert.equal(jobs[0].title, 'Software Engineerng Director')
      assert.equal(jobs[0].company, 'atlaswear')
      assert.ok(jobs[0].source.startsWith('atlaswear'))
      assert.ok(!jobs[0].source.includes('Example City'))
    }
  })

  it('preserves unfamiliar and labelled titles and employers in profile blocks', () => {
    for (const [employer, role, company, title] of [
      ['nimbus', 'Product Owner', 'nimbus', 'Product Owner'],
      ['Company: Example Studio', 'Title: Scrum Master', 'Example Studio', 'Scrum Master'],
      ['示例公司', '客户成功合伙人', '示例公司', '客户成功合伙人'],
    ]) {
      const { jobs } = parseCareer(`Experience\n${employer}\n\n${role}\n\n2020–2022\nExample City`, 2026)
      assert.equal(jobs.length, 1)
      assert.equal(jobs[0].company, company)
      assert.equal(jobs[0].title, title)
    }
  })

  it('retains the employer for promotion rows under a company-total-tenure header', () => {
    const text = [
      'Experience', 'Example Labs', '', '6 years 1 month', '', 'Director', '', '2024–Present',
      'Example City', 'Built fictional software.', '', 'Senior Manager', '2020–2023',
      'Example City', 'Delivered fictional releases.', '',
      'atlaswear', 'Senior Manager', '2018–2019', '',
      'Junior Engineer', '2016–2017',
    ].join('\n')
    const { jobs } = parseCareer(text, 2026)
    assert.deepEqual(jobs.map(job => job.company), ['', 'atlaswear', 'Example Labs', 'Example Labs'])
    assert.match(jobs[2].source, /^Example Labs\n\n6 years 1 month\nSenior Manager\n2020–2023$/)
  })

  it('never guesses employers from locations, descriptions or other sections', () => {
    for (const text of [
      'Experience\nEngineer\n2020–2022\nExample City',
      'Experience\nEngineer\n2022–2023\nExample City\nJunior Engineer\n2020–2021',
      'Experience\nBuilt fictional software.\nSenior Engineer\n2020–2022',
      'Summary\nExample Labs\nExperience\nSenior Engineer\n2020–2022',
      'Experience\nExample Labs\n6 years\nSenior Engineer\n2020–2022\nSkills\nJunior Engineer\n2010–2011',
    ]) {
      const { jobs } = parseCareer(text, 2026)
      if (text.includes('6 years')) {
        assert.equal(jobs.length, 1)
        assert.equal(jobs[0].company, 'Example Labs')
      } else assert.ok(jobs.every(job => job.company === ''), text)
    }
  })

  it('finds employer blocks with blank lines after nested project headings', () => {
    const { jobs } = parseCareer('Experience\nExample | Engineer | 2022–2024\nProjects\nBuilt fictional software.\n\natlaswear\n\nSenior Manager\n\n2019–2021 (2 years)\n\nExample City\nEducation\nExample University\nSoftware Engineer Degree\n2010–2014', 2026)
    assert.deepEqual(jobs.map(job => [job.title, job.company]), [['Senior Manager', 'atlaswear'], ['Engineer', 'Example']])
  })

  it('resumes earlier employment after nested Projects but still excludes projects and education', () => {
    const text = [
      'Experience', 'Example Company', 'Senior Engineer', 'August 2019 - Present (7 years 2 months)',
      'Projects', 'Example Project | Lead Developer | 2019–2020', 'Built fictional project features.', '',
      'Fictional Employer', 'Software Engineer', 'July 2018 - August 2019 (1 year 2 months)',
      'Projects:', 'Example Project | Engineer | 2018–2019', '',
      'Another Employer', 'Junior Engineer', 'October 2004 - September 2005 (1 year)',
      'Education', 'Example University', 'Software Engineer Degree', '2000–2004 (4 years)',
      'Projects', 'Example | Director | 2001–2002',
    ].join('\n')
    const jobs = parseCareer(text, new Date(2026, 9, 4)).jobs
    assert.deepEqual(jobs.map(job => [job.title, job.startYear, job.startMonth]), [
      ['Junior Engineer', 2004, 10], ['Software Engineer', 2018, 7], ['Senior Engineer', 2019, 8],
    ])
    assert.ok(jobs.every(job => !job.title.includes('Degree') && !job.company.includes('Project')))
    assert.deepEqual(jobs.map(job => job.company), ['Another Employer', 'Fictional Employer', 'Example Company'])
  })

  it('does not reopen employment for a standalone Projects section or a bare dated project', () => {
    for (const text of [
      'Projects\nExample Employer\nLead Engineer\n2010–2011 (1 year)',
      'Experience\nExample | Engineer | 2020–2021\nProjects\nExample | Lead Engineer | 2010–2011 (1 year)',
      'Experience\nExample | Engineer | 2020–2021\nProjects\nProject Alpha\n2010–2011 (1 year)',
    ]) assert.equal(parseCareer(text, 2026).jobs.some(job => job.startYear === 2010), false)
  })
})