import { careerLevel, type CareerJob } from './career.ts'

interface CareerRow {
  key: string
  title: string
  jobs: CareerJob[]
  y: number
  top: number
  height: number
}

interface CareerConnection {
  from: { job: CareerJob; y: number }
  to: { job: CareerJob; y: number }
}

const identity = (value: string) => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase()

const qualification = '(senior|sr\\.?|junior|jr\\.?|assistant|associate|acting|interim|deputy)'
const softwareDiscipline = 'software (?:development|engineering|engineer|engineerng)'
const disciplineFirst = new RegExp(`^(?:${qualification} )?${softwareDiscipline} (?:${qualification} )?(manager|director)$`)
const leadershipFirst = new RegExp(`^(?:${qualification} )?(manager|director)(?: of(?: the)?|,| -)? ${softwareDiscipline}$`)
const contributorTitle = /^(?:(senior|sr\.?|junior|jr\.?|lead|staff|principal|assistant|associate|acting|interim|deputy) )?(?:java developer|software engineer)$/

/** Bounded, transparent aliases for equivalent software titles. */
export function unifyCareerTitle(title: string): string {
  const normalized = identity(title)
  const contributor = contributorTitle.exec(normalized)
  const trailing = disciplineFirst.exec(normalized)
  const leading = leadershipFirst.exec(normalized)
  // Don't flatten two qualifications or silently discard unknown responsibilities.
  if (trailing?.[1] && trailing[2]) return title
  const role = trailing?.[3] ?? leading?.[2]
  if (!contributor && !role) return title
  const qualifier = contributor?.[1] ?? trailing?.[1] ?? trailing?.[2] ?? leading?.[1]
  const expanded = qualifier?.replace(/^sr\.?$/, 'senior').replace(/^jr\.?$/, 'junior')
  const prefix = expanded ? `${expanded[0].toUpperCase()}${expanded.slice(1)} ` : ''
  if (contributor) return `${prefix}Software Engineer`
  return `${prefix}Software Engineering ${role === 'manager' ? 'Manager' : 'Director'}`
}

// A title-based display guide, not a cross-company compensation or authority scale.
// Dates and employer names must never place a manager above a senior manager.
function titleDisplayRank(title: string): number {
  const normalized = identity(title)
  const level = careerLevel(normalized)
  const ranks: Record<string, number> = {
    Executive: 90, 'Vice president': 80, Director: 70, 'Manager / head': 60,
    Principal: 50, Staff: 45, Lead: 40, Senior: 30, 'Not stated': 20,
    Junior: 10, 'Intern / trainee': 0,
  }
  const rank = ranks[level] ?? 20
  if (level === 'Manager / head' || level === 'Director' || level === 'Vice president') {
    if (/\b(?:senior|sr)\b|高级|资深/.test(normalized)) return rank + 2
    if (/\b(?:junior|jr)\b|初级/.test(normalized)) return rank - 2
  }
  return rank
}

/** A single Y coordinate per unified job title across ALL employers. */
export function layoutCareer(jobs: readonly CareerJob[]): { rows: CareerRow[]; connections: CareerConnection[]; height: number } {
  const titles = new Map<string, CareerRow>()
  const newestFirst = [...jobs].sort((a, b) => b.startValue - a.startValue || b.endValue - a.endValue)
  for (const job of newestFirst) {
    const title = unifyCareerTitle(job.title)
    const key = identity(title)
    let row = titles.get(key)
    if (!row) {
      row = { key, title, jobs: [], y: 0, top: 0, height: 0 }
      titles.set(key, row)
    }
    // Employer, date intervals and evidence remain separate for every period.
    row.jobs.push(job)
  }
  let top = 65
  // Stable sorting retains newest-start order only for equal display ranks.
  // SVG Y grows downward, so the highest title level must come first.
  const rows = [...titles.values()].sort((a, b) => titleDisplayRank(b.title) - titleDisplayRank(a.title))
  for (const row of rows) {
    row.top = top
    row.y = top + 26
    // Each period has an employer/date label lane; the bars still share one Y.
    row.height = 64 + row.jobs.length * 36
    top += row.height + 12
  }
  // Connect actual end/start dots in chronological start-date order, not Y order.
  // Overlaps may run backward in X; never move dates to imply a clean handoff.
  const chronological = rows.flatMap(row => row.jobs.map(job => ({ job, y: row.y })))
    .sort((a, b) => a.job.startValue - b.job.startValue || a.job.endValue - b.job.endValue
      || a.job.title.localeCompare(b.job.title) || a.job.company.localeCompare(b.job.company))
  const connections = chronological.slice(1).map((to, i) => ({ from: chronological[i], to }))
  return { rows, connections, height: top + 25 }
}