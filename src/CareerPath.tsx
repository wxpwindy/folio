import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { BriefcaseBusiness, RefreshCw, TrendingUp } from 'lucide-react'
import { errorMessage } from './api'
import { parseCareer } from './career'
import { layoutCareer } from './career-layout'
import './CareerPath.css'

export function CareerPath({ text, onRegenerate, disabledReason = '' }: { text: string; onRegenerate: () => Promise<void>; disabledReason?: string }) {
  const id = useId()
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ source: string; message: string } | null>(null)
  const [message, setMessage] = useState('')
  const pending = useRef(false)
  const active = useRef(true)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  async function regenerate() {
    if (pending.current || disabledReason) return
    pending.current = true
    setBusy(true); setError(null); setMessage('')
    try {
      await onRegenerate()
      if (active.current) {
        setRevision(value => value + 1)
        setMessage('Career path regenerated from the latest saved base resume.')
      }
    } catch (e) { if (active.current) setError({ source: text, message: `Could not regenerate career path. ${errorMessage(e)}` }) }
    finally { pending.current = false; if (active.current) setBusy(false) }
  }
  const today = new Date()
  const year = today.getFullYear(), month = today.getMonth(), day = today.getDate()
  const { jobs, skipped } = useMemo(() => {
    // Explicit regeneration also rebuilds an unchanged saved source.
    void revision
    return parseCareer(text, new Date(year, month, day))
  }, [text, year, month, day, revision])
  const shown = jobs.slice(-30).reverse()
  const start = shown.length ? Math.floor(Math.min(...shown.map(job => job.startValue))) : year
  const end = Math.max(start + 1, Math.ceil(Math.max(...shown.map(job => job.endValue))))
  const step = Math.max(1, Math.ceil((end - start) / 7))
  const ticks = Array.from({ length: Math.floor((end - start) / step) + 1 }, (_, i) => start + i * step)
  if (ticks.at(-1) !== end) ticks.push(end)
  const x = (value: number) => 300 + (value - start) / (end - start) * 600
  const { rows, connections, height } = layoutCareer(shown)
  const short = (value: string, limit = 34) => value.length > limit ? `${value.slice(0, limit - 1)}…` : value
  return <section className="career-path" aria-labelledby={`${id}-heading`} aria-busy={busy}>
    <div className="career-heading"><div><span className="eyebrow">YOUR EXPERIENCE OVER TIME</span><h2 id={`${id}-heading`}><TrendingUp size={23} aria-hidden="true" />Career path</h2></div><div className="career-actions"><span className="career-count"><BriefcaseBusiness size={15} aria-hidden="true" />{jobs.length} {jobs.length === 1 ? 'role' : 'roles'} detected</span><button type="button" className="button secondary small" disabled={busy || !!disabledReason} aria-describedby={disabledReason ? `${id}-refresh-hint` : undefined} onClick={() => void regenerate()}><RefreshCw size={15} className={busy ? 'spin' : undefined} aria-hidden="true" />{busy ? 'Regenerating…' : 'Regenerate career path'}</button></div></div>
    {disabledReason && <p id={`${id}-refresh-hint`} className="career-note">{disabledReason}</p>}
    {error?.source === text && <p className="inline-error" role="alert">{error.message}</p>}
    {message && <p className="career-note" role="status">{message}</p>}
    <p className="career-note">Built from your saved base resume. X: year · Y: unified job title / level. Higher title levels appear above lower ones: Director → Senior Manager → Manager → Engineer. Equivalent titles stay flat across companies. Recent start dates only break ties between equally ranked rows.</p>
    {shown.length ? <>
      <div className="career-scroll" tabIndex={0} role="region" aria-label="Scrollable career timeline">
        <svg viewBox={`0 0 950 ${height}`} width="950" height={height} role="img" aria-labelledby={`${id}-title ${id}-desc`}>
          <title id={`${id}-title`}>Career path by year, job and level across companies</title>
          <desc id={`${id}-desc`}>Rows are ordered by title level from highest at the top to lowest at the bottom. Senior Manager is above Software Manager regardless of employment dates or company. Equivalent titles share one row across employers. Dashed lines connect each role’s end dot to the next role’s start dot in start-date order. Connections show sequence only, not continuous employment or confirmed promotions; overlapping dates are not changed. Each period retains its bar, employer and dates. Labels are staggered for readability, not to indicate different levels. Original titles and source text are available below.</desc>
          <text x="18" y="25" className="career-axis-title">Job title / level</text>
          <text x="600" y="25" textAnchor="middle" className="career-axis-title">Year</text>
          {rows.map(row => <rect key={row.key} x="8" y={row.top} width="934" height={row.height} rx="8" className="career-row-band" />)}
          {ticks.map(tick => <g key={tick}><line x1={x(tick)} x2={x(tick)} y1="55" y2={height - 35} className="career-grid" /><text x={x(tick)} y="47" textAnchor="middle" className="career-tick">{tick}</text></g>)}
          {connections.map((connection, i) => <line key={i}
            x1={x(connection.from.job.endValue)} y1={connection.from.y}
            x2={x(connection.to.job.startValue)} y2={connection.to.y}
            className="career-connector">
            <title>{connection.from.job.title} → {connection.to.job.title} · Career sequence, not an employment period</title>
          </line>)}
          {rows.map(row => <g key={row.key} className="career-title-row">
            <title>{row.title}</title>
            <text x="18" y={row.y - 5} className="career-job">{short(row.title)}</text>
            <text x="18" y={row.y + 14} className="career-level">{row.jobs[0].level}</text>
            {row.jobs.map((job, i) => {
              const company = job.company.trim() || 'Company not stated'
              const labelX = Math.min(x(job.startValue), 620)
              return <g key={`${job.source}-${i}`} className="career-period">
                <title>{job.title} · {company} · {job.level} · {job.dateLabel}</title>
                <line x1={x(job.startValue)} x2={x(job.endValue)} y1={row.y} y2={row.y} className={`career-bar${job.current ? ' current' : ''}`} />
                <circle cx={x(job.startValue)} cy={row.y} r="5" className="career-dot" />
                <circle cx={x(job.endValue)} cy={row.y} r="5" className="career-dot" />
                <text x={labelX} y={row.y + 26 + i * 36} className="career-company">{short(company, 38)}</text>
                <text x={labelX} y={row.y + 42 + i * 36} className="career-tick">{job.dateLabel}</text>
              </g>
            })}
          </g>)}
        </svg>
      </div>
      {connections.length > 0 && <p className="career-note career-connection-note"><span className="career-connection-swatch" aria-hidden="true" />Dashed lines connect career periods in start-date order, from one role’s end dot to the next role’s start dot. They do not imply continuous employment or promotions; overlaps may connect backward in time.</p>}
      <p className="career-note">Equivalent software titles are unified: “Java Developer” and “Software Engineer” share a row; “Software Development Manager” and “Manager of Software Development” share another, as do “Software Engineer Director” and “Director of Software Engineering”. Seniority qualifiers remain distinct. Vertical order is a title-based visual guide, not a universal company hierarchy or an assessment of responsibility. Original titles remain in tooltips and source details. Date labels remain as written; bars cover stated months (or whole years), and “Present” ends today. Company/date labels are staggered without changing bar height. Missing employers say “Company not stated”. Scroll horizontally on smaller screens.</p>
      {jobs.length > shown.length && <p className="career-note">Showing the latest 30 roles in the chart; all detected roles are listed below.</p>}
      <details className="career-evidence"><summary>Review detected roles and source text</summary><ol>{jobs.map((job, i) => <li key={i}><h3>{job.title}</h3><p>{job.company && `${job.company} · `}{job.dateLabel} · Level: {job.level}</p><blockquote>{job.source}</blockquote></li>)}</ol></details>
    </> : <div className="career-empty"><BriefcaseBusiness size={28} aria-hidden="true" /><h3>No dated roles detected yet</h3><p>Use an Experience section with a job title and date range, for example: Example Studio | Senior Software Engineer | 2021–Present.</p></div>}
    <p className="career-note">This is a best-effort extraction, not a complete career assessment. {skipped > 0 && `${skipped} dated ${skipped === 1 ? 'entry was' : 'entries were'} omitted because the role or dates were unclear. `}To correct or add roles, edit and save the extracted text in Base resume. Unsaved edits and tailored versions do not change this chart.</p>
  </section>
}