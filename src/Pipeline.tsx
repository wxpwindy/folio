import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, Circle, Clock3, GitBranch, Play, RefreshCw, Rocket, RotateCcw, Square, XCircle } from 'lucide-react'
import { errorMessage, request } from './api'
import type { PipelineState, PipelineStatus } from './pipeline-types'
import './Pipeline.css'

function Status({ value }: { value: PipelineStatus }) {
  const Icon = value === 'passed' ? CheckCircle2 : ['failed', 'cancelled', 'interrupted'].includes(value) ? XCircle : value === 'running' ? RefreshCw : Circle
  return <span className={`pipeline-status ${value}`}><Icon size={14} aria-hidden="true" className={value === 'running' ? 'spin' : ''} />{value}</span>
}
function duration(start: string, end?: string) {
  const seconds = Math.max(0, Math.floor(((end ? Date.parse(end) : Date.now()) - Date.parse(start)) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export function Pipeline() {
  const [state, setState] = useState<PipelineState | null>(null)
  const [selected, setSelected] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [pending, setPending] = useState(false)
  const active = useRef(false)
  const busy = useRef(false)
  const revision = useRef(0)
  const controller = useRef<AbortController | null>(null)
  useEffect(() => {
    active.current = true
    const abort = new AbortController()
    controller.current = abort
    let timer: ReturnType<typeof setTimeout>
    async function poll() {
      const version = revision.current
      try {
        if (!busy.current) {
          const value = await request<PipelineState>('/admin/pipeline', { signal: abort.signal })
          if (active.current && version === revision.current) { setState(value); setError('') }
        }
      } catch (e) { if (active.current && !abort.signal.aborted && version === revision.current) setError(errorMessage(e)) }
      finally { if (active.current && !abort.signal.aborted) timer = setTimeout(() => void poll(), 2500) }
    }
    void poll()
    return () => { active.current = false; abort.abort(); clearTimeout(timer) }
  }, [])
  async function action(path?: string, message = '') {
    if (busy.current) return
    busy.current = true; revision.current++; setPending(true); setError(''); setNotice('')
    try {
      const signal = controller.current?.signal
      if (path) await request(`/admin/pipeline${path}`, { method: 'POST', body: '{}', signal })
      const value = await request<PipelineState>('/admin/pipeline', { signal })
      if (active.current) { setState(value); setNotice(message); if (path === '/runs') setSelected(value.runs[0]?.id ?? '') }
    } catch (e) { if (active.current) setError(errorMessage(e)) }
    finally { busy.current = false; if (active.current) setPending(false) }
  }
  const run = state?.runs.find(run => run.id === selected) ?? state?.runs[0]
  const running = state?.runs.find(run => run.status === 'running')
  const disabled = pending || !state?.available
  return <section className="pipeline-panel admin-section" aria-labelledby="pipeline-heading">
    <div className="pipeline-heading"><div><span className="eyebrow">LOCAL DELIVERY</span><h2 id="pipeline-heading"><GitBranch size={23} aria-hidden="true" />CI/CD pipeline</h2><p>Validate an isolated source snapshot. Review the results. Publish a tested web release.</p></div>
      <div className="pipeline-actions"><button className="button secondary small" disabled={pending} onClick={() => void action()}><RefreshCw size={15} />Refresh pipeline</button><button className="button primary small" disabled={disabled || state?.busy} onClick={() => void action('/runs', 'Pipeline started. You can leave this page while it runs.')}><Play size={15} />Run pipeline</button></div>
    </div>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {notice && <p className="auth-message" role="status">{notice}</p>}
    {!state && !error && <p role="status">Loading pipeline…</p>}
    {state && !state.available && <p className="pipeline-note">Pipeline execution is unavailable in this server. Use the normal local Folio server, not a test fixture.</p>}
    <div className="pipeline-metrics">
      <div><span>Latest validation</span>{state?.runs[0] ? <Status value={state.runs[0].status} /> : <strong>No runs yet</strong>}</div>
      <div><span>Active web release</span><strong>{state?.activeRelease?.slice(0, 8) ?? 'Workspace build'}</strong></div>
      <div><span>Deployment target</span><a href="http://127.0.0.1:3001" target="_blank" rel="noreferrer">Local production · :3001</a></div>
    </div>
    <p className="pipeline-note">Fixed steps: snapshot → lint → backend tests → typechecks → web build → browser tests → package. No cloud generation or dependency downloads. Only trusted local source should be run; this is not a security sandbox. Deployment updates the web UI only—backend code and database migrations require an explicit restart. The Vite development UI on :5173 is not switched.</p>
    <div className="pipeline-actions pipeline-release-actions">
      <button className="button secondary small" disabled={disabled || !running || !state?.canCancel} onClick={() => running && void action(`/runs/${running.id}/cancel`, 'Cancellation requested.')}><Square size={14} />Cancel run</button>
      <button className="button secondary small" disabled={disabled || state?.busy || !state?.previousRelease} onClick={() => { if (window.confirm('Roll back the local web UI to the previous tested release? The backend and resume data are not changed.')) void action('/rollback', 'Previous web release restored. Reload the production UI to use it.') }}><RotateCcw size={15} />Roll back web release</button>
    </div>
    {state?.busy && !state.canCancel && <p className="pipeline-note">A terminal-started run is active. Cancel it with Ctrl+C in that terminal; status and logs remain visible here.</p>}
    {!run ? <div className="pipeline-empty"><GitBranch size={30} /><h3>Your first green build starts here</h3><p>Run the pipeline to see live step status, logs, and deployable releases.</p></div> : <div className="pipeline-workspace">
      <aside className="pipeline-history" aria-label="Pipeline run history"><h3>Recent runs</h3>{state!.runs.map(item => <button key={item.id} className={`pipeline-run ${run.id === item.id ? 'selected' : ''}`} aria-pressed={run.id === item.id} onClick={() => setSelected(item.id)}><span>Run {item.id.slice(0, 8)}</span><Status value={item.status} /><time dateTime={item.startedAt}>{new Date(item.startedAt).toLocaleString()}</time></button>)}</aside>
      <div className="pipeline-detail"><div className="pipeline-heading"><div><h3>Run {run.id.slice(0, 8)}</h3><p><Clock3 size={13} aria-hidden="true" /> {duration(run.startedAt, run.finishedAt)} · source {run.digest?.slice(0, 12) ?? 'snapshot pending'}</p></div><button className="button primary small" disabled={disabled || state?.busy || !run.releaseReady || run.status !== 'passed' || run.id === state?.activeRelease} onClick={() => { if (window.confirm('Deploy this tested web release to local production on port 3001? Backend code and resume data stay unchanged.')) void action(`/runs/${run.id}/deploy`, 'Web release deployed. Reload the production UI to use it.') }}><Rocket size={15} />{run.id === state?.activeRelease ? 'Deployed' : 'Deploy web release'}</button></div>
        <ol className="pipeline-steps">{run.steps.map((step, index) => <li key={step.name}><div className="pipeline-step-heading"><span className="pipeline-step-number">{index + 1}</span><strong>{step.name}</strong><Status value={step.status} />{step.startedAt && <small>{duration(step.startedAt, step.finishedAt)}</small>}</div>{step.log && <details open={step.status === 'running' || step.status === 'failed'}><summary>Logs: {step.name}</summary><pre tabIndex={0} aria-label={`${step.name} log`}>{step.log}</pre></details>}</li>)}</ol>
      </div>
    </div>}
    <p className="pipeline-note">The last 10 runs and bounded, redacted logs are stored locally. Full working copies are removed after each run. Existing resumes, PDFs, credentials and accounts are not copied into the pipeline.</p>
  </section>
}