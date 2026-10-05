export interface CareerJob {
  title: string
  company: string
  level: string
  startYear: number
  endYear: number
  startMonth?: number
  endMonth?: number
  startValue: number
  endValue: number
  dateLabel: string
  current: boolean
  source: string
}

const experienceHeading = /^(?:(?:professional|work|relevant|employment)\s+experience|experience|employment(?:\s+history)?|(?:career|work|professional)\s+history|expérience(?:s)?(?:\s+professionnelle(?:s)?)?|工作经历|工作经验|职业经历|任职经历)\s*[:：]?$/i
const otherHeading = /^(?:education|academic(?:\s+background)?|qualifications|skills|technical skills|projects|certifications?|awards|summary|profile|publications|volunteering|interests|references|formation|compétences|profil|教育(?:经历|背景)?|学历|项目经历|专业技能|技能|个人简介|证书)\s*[:：]?$/i
const roleWord = /\b(?:engineer|developer|designer|analyst|manager|director|officer|consultant|specialist|coordinator|administrator|intern|assistant|associate|lead|president|researcher|scientist|teacher|nurse|accountant|architect|technician|founder|head|ingénieur|développeur)\b|工程师|经理|总监|主管|专员|顾问|设计师|实习/i
const monthNames = 'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?'
const yearToken = '(?:19|20)\\d{2}'
const dateToken = `(?:(?:${monthNames})\\.?\\s+${yearToken}|\\d{1,2}[/.-]${yearToken}|${yearToken}(?:年(?:\\s*\\d{1,2}月)?|[./-]\\d{1,2}(?!\\d))?)`
const range = new RegExp(`(?<![\\p{L}\\d/.-])(?<start>${dateToken})\\s*(?:[-–—~～]|to|至|到)\\s*(?<end>${dateToken}|present|current|now|至今|今|现在|aujourd’hui|aujourd'hui)(?![\\d\\p{L}/.]|[-]\\d)`, 'iu')
const titleLabel = /^(?:job\s+title|title|role|position|职位|职务|岗位)\s*[:：]\s*/i
const companyLabel = /^(?:company|employer|organization|公司)\s*[:：]\s*/i
const companyWord = /\b(?:inc\.?|ltd\.?|llc|corporation|company|studio|labs|limited|group|university)\b|公司|集团|大学/i
const description = /^(?:[•*-]\s|built\b|worked\b|developed\b|managed\b|led\b|responsible\b|achieved\b|delivered\b|负责|参与|完成)/i
const projectsHeading = /^(?:projects|项目经历)\s*[:：]?$/i
const durationAnnotation = /\s*\((?:\d+\s*(?:years?|yrs?|months?|mos?)\s*)+\)\s*$/i
const durationOnly = /^(?:\d+\s*(?:years?|yrs?|months?|mos?)\s*)+$/i
const clean = (value: string) => value.replace(/^[\s|,;:()–—-]+|[\s|,;:()–—-]+$/g, '').trim()
const partsOf = (value: string) => clean(value).split(/\s*[|｜•]\s*|\s+[–—]\s+|\t+|\s{2,}/).filter(Boolean)

function dateParts(value: string): { year: number; month?: number } | null {
  const year = Number(value.match(/(?:19|20)\d{2}/)?.[0])
  if (!year) return null
  const named = value.match(new RegExp(`^(${monthNames})`, 'i'))
  const numeric = value.match(/^\d{4}[./-](\d{1,2})$|^(\d{1,2})[/.-]\d{4}$|^\d{4}年\s*(\d{1,2})月$/)
  const month = named ? ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(named[0].slice(0, 3).toLowerCase()) + 1
    : numeric ? Number(numeric[1] ?? numeric[2] ?? numeric[3]) : undefined
  if (month !== undefined && (month < 1 || month > 12)) return null
  return { year, month }
}

function titleFrom(parts: string[], inSection: boolean): { title: string; company: string } | null {
  const at = parts.length === 1 ? parts[0].match(/^(.+?)\s+(?:at|@)\s+(.+)$/i) : null
  if (at) parts = [at[1], at[2]]
  const labelled = parts.findIndex(part => titleLabel.test(part))
  const known = parts.findIndex(part => roleWord.test(part) && !companyWord.test(part) && !companyLabel.test(part))
  const nonCompany = parts.findIndex(part => !companyWord.test(part) && !companyLabel.test(part))
  // Keywords disambiguate order but never restrict which titles can be charted.
  // Unlabelled company | title headers use the second column by convention.
  const index = labelled >= 0 ? labelled : at ? 0 : known >= 0 ? known
    : parts.length > 1 ? (nonCompany >= 0 && parts.some(part => companyWord.test(part) || companyLabel.test(part)) ? nonCompany : 1)
      : inSection && nonCompany === 0 ? 0 : -1
  if (index < 0) return null
  const title = parts[index].replace(titleLabel, '').trim()
  if (!title || title.length > 160 || description.test(title) || durationOnly.test(title) || range.test(title)) return null
  return { title, company: parts.filter((_, i) => i !== index).map(part => part.replace(companyLabel, '')).join(' · ') }
}

function previousHeaderLine(lines: string[], index: number, sectionStart: number): number {
  for (let cursor = index - 1; cursor >= Math.max(sectionStart, index - 8); cursor--) {
    if (lines[cursor]) return cursor
  }
  return -1
}

/** Profile exports use employer / optional total tenure / title / employment dates. */
function profileHeaderBefore(lines: string[], dateIndex: number, sectionStart: number) {
  const roleIndex = previousHeaderLine(lines, dateIndex, sectionStart)
  if (roleIndex < 0) return null
  const role = lines[roleIndex]
  if (experienceHeading.test(role) || otherHeading.test(role)) return null
  const header = titleFrom(partsOf(role), true)
  if (!header || header.company) return null
  let employerIndex = previousHeaderLine(lines, roleIndex, sectionStart)
  if (employerIndex < 0) return null
  const hasTotalTenure = durationOnly.test(lines[employerIndex])
  const tenureIndex = employerIndex
  if (hasTotalTenure) employerIndex = previousHeaderLine(lines, employerIndex, sectionStart)
  if (employerIndex < 0) return null
  const employer = lines[employerIndex]
  const explicitlyCompany = companyLabel.test(employer) || companyWord.test(employer)
  // Do not use the preceding role's location, bullet or trailing prose as a brand.
  const boundary = employerIndex === sectionStart || !lines[employerIndex - 1]
    || experienceHeading.test(lines[employerIndex - 1])
  if (!employer || employer.length > 160 || description.test(employer)
    || range.test(employer) || durationOnly.test(employer) || titleLabel.test(employer)
    || otherHeading.test(employer) || experienceHeading.test(employer)
    || partsOf(employer).length !== 1 || (!explicitlyCompany && roleWord.test(employer))
    || (!explicitlyCompany && /[.!?。！？]$/.test(employer))
    || !(boundary || hasTotalTenure || explicitlyCompany)) return null
  const beforeEmployer = previousHeaderLine(lines, employerIndex, sectionStart)
  if (beforeEmployer === employerIndex - 1 && beforeEmployer >= 0 && range.test(lines[beforeEmployer])) return null
  const company = employer.replace(companyLabel, '').trim()
  if (!company) return null
  return { title: header.title, company, employerIndex, roleIndex, hasTotalTenure,
    companySource: lines.slice(employerIndex, (hasTotalTenure ? tenureIndex : employerIndex) + 1).join('\n') }
}

export function careerLevel(title: string): string {
  const levels: [RegExp, string][] = [
    [/\b(?:chief|ceo|cto|cfo|coo|cio)\b|首席|总裁/i, 'Executive'],
    [/\b(?:vice president|vp)\b|副总裁/i, 'Vice president'],
    [/\bdirector\b|总监/i, 'Director'],
    [/\bprincipal\b/i, 'Principal'],
    [/\bstaff\b/i, 'Staff'],
    [/\b(?:manager|head)\b|经理/i, 'Manager / head'],
    [/\blead\b|主管/i, 'Lead'],
    [/\b(?:senior|sr\.?)\b|高级|资深/i, 'Senior'],
    [/\b(?:junior|jr\.?)\b|初级/i, 'Junior'],
    [/\b(?:intern|internship|trainee)\b|实习/i, 'Intern / trainee'],
  ]
  return levels.find(([pattern]) => pattern.test(title))?.[1] ?? 'Not stated'
}

/** Conservative local extraction, not an assessment of seniority or promotions. */
export function parseCareer(text: string, asOf: Date | number = new Date()): { jobs: CareerJob[]; skipped: number } {
  const now = typeof asOf === 'number' ? new Date(asOf, 0, 1) : asOf
  const currentYear = now.getFullYear()
  const currentMonth = now.getMonth() + 1
  const currentValue = currentYear + (currentMonth - 1 + (now.getDate() - 1) / new Date(currentYear, currentMonth, 0).getDate()) / 12
  const lines = text.split(/\r?\n/).map(line => line.trim())
  const hasSections = lines.some(line => experienceHeading.test(line))
  let inExperience = !hasSections
  let inExperienceProjects = false
  let sectionStart = 0
  let parentCompany: { company: string; source: string } | null = null
  let skipped = 0
  const jobs: CareerJob[] = []
  const seen = new Set<string>()
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (experienceHeading.test(line)) { inExperience = true; inExperienceProjects = false; sectionStart = i + 1; parentCompany = null; continue }
    if (otherHeading.test(line)) {
      // Projects can be a subsection inside a job, not the end of all work
      // history. Suspend extraction until a clear employment header resumes it.
      inExperienceProjects = projectsHeading.test(line) && hasSections && (inExperience || inExperienceProjects)
      inExperience = false
      sectionStart = i + 1
      parentCompany = null
      continue
    }
    if (!inExperience && !inExperienceProjects) continue
    const match = range.exec(line)
    if (!match) continue
    const rest = clean(line.replace(match[0], '').replace(durationAnnotation, ''))
    const profile = !rest ? profileHeaderBefore(lines, i, sectionStart) : null
    if (!inExperience) {
      // Profile-export job blocks: employer, role, date range (duration).
      // Do not resume for dated project bullets or ordinary project rows.
      if (!profile || !durationAnnotation.test(line)
        || !(roleWord.test(profile.title) || titleLabel.test(lines[profile.roleIndex]))) continue
      inExperience = true
      inExperienceProjects = false
      sectionStart = profile.employerIndex
    }
    const start = dateParts(match.groups!.start)
    const current = !/\d/.test(match.groups!.end)
    const end = current ? { year: currentYear, month: currentMonth } : dateParts(match.groups!.end)
    if (!start || !end || start.year > end.year || end.year > currentYear
      || (end.year === currentYear && end.month !== undefined && end.month > currentMonth)
      || (start.year === end.year && start.month !== undefined && end.month !== undefined && start.month > end.month)
      || range.test(line.slice(match.index + match[0].length))) { skipped++; continue }
    let header = profile ? { title: profile.title, company: profile.company } : titleFrom(partsOf(rest), true)
    let source = profile ? lines.slice(profile.employerIndex, i + 1).join('\n') : line
    let adjacentRoleIndex = profile?.roleIndex ?? -1
    // Look only within this entry's adjacent header lines, never across another
    // date range, section heading or bullet. Dates and titles remain source text.
    if (!header && (!rest || companyWord.test(rest) || companyLabel.test(rest))) {
      const candidates: { index: number; value: NonNullable<ReturnType<typeof titleFrom>>; explicit: boolean }[] = []
      for (const direction of [-1, 1]) {
        let nonempty = 0
        for (let distance = 1; distance <= 8 && nonempty < 3; distance++) {
          const index = i + distance * direction
          if (index < sectionStart || index >= lines.length) break
          const candidate = lines[index]
          if (range.test(candidate) || experienceHeading.test(candidate) || otherHeading.test(candidate) || description.test(candidate)) break
          if (!candidate) continue
          nonempty++
          const value = titleFrom(partsOf(candidate), true)
          if (value) candidates.push({ index, value, explicit: titleLabel.test(candidate) || roleWord.test(value.title) })
        }
      }
      candidates.sort((a, b) => Number(b.explicit) - Number(a.explicit) || Math.abs(a.index - i) - Math.abs(b.index - i))
      const candidate = candidates[0]
      if (candidate) {
        header = candidate.value
        adjacentRoleIndex = candidate.index
        if (!header.company && rest) header.company = rest.replace(companyLabel, '')
        source = lines.slice(Math.min(candidate.index, i), Math.max(candidate.index, i) + 1).join('\n')
      }
    }
    if (!header) { skipped++; continue }
    if (profile) {
      parentCompany = profile.hasTotalTenure ? { company: profile.company, source: profile.companySource } : null
    } else if (header.company) {
      parentCompany = null
    } else if (parentCompany && !rest && adjacentRoleIndex === previousHeaderLine(lines, i, sectionStart)) {
      // Only explicit company-total-tenure headers govern following promotion rows.
      // Ordinary roles without employers never inherit an unrelated prior company.
      header.company = parentCompany.company
      source = `${parentCompany.source}\n${source}`
    }
    const { title, company } = header
    const startValue = start.year + ((start.month ?? 1) - 1) / 12
    // Month/year end dates are inclusive periods, not invented exact days.
    const endValue = current ? currentValue : end.year + (end.month ?? 12) / 12
    if (startValue > endValue) { skipped++; continue }
    const key = `${title}|${company}|${start.year}-${start.month ?? ''}|${current ? 'present' : `${end.year}-${end.month ?? ''}`}`
    if (seen.has(key)) continue
    seen.add(key)
    jobs.push({ title, company, level: careerLevel(title), startYear: start.year, endYear: end.year,
      startMonth: start.month, endMonth: current ? undefined : end.month,
      startValue, endValue, dateLabel: match[0], current, source })
  }
  jobs.sort((a, b) => a.startValue - b.startValue || a.endValue - b.endValue)
  return { jobs, skipped }
}