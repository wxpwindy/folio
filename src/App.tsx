import { useEffect, useRef, useState } from 'react'
import { ArrowDownToLine, ArrowRight, ArrowUpRight, BriefcaseBusiness, Check, ChevronRight, Clock3, FileCheck2, FileText, FolderOpen, Layers3, LayoutGrid, LoaderCircle, LockKeyhole, Plus, Search, Settings2, ShieldCheck, Sparkles, Upload, X } from 'lucide-react'
import type { AuthSession, AuthUser, BaseResume, DocumentType, FeatureState, Settings, TranslationSource, TranslationTargetLanguage, Workspace } from './types'
import { Administration, PasswordChange } from './Admin'
import { Chat } from './Chat'
import { CareerPath } from './CareerPath'
import { MessageCircle } from 'lucide-react'
import { date, downloadPdf, errorMessage, getFeatures, request } from './api'
import { GenerateForm, InlineError, ResumePaper, SettingsForm, TranslationActions, TranslationForm, UploadArea, VersionDetail } from './components'
import './App.css'

const defaults: Settings = { provider: 'ollama', ollamaModel: '', openaiModel: '', apiKey: '' }
function loadSettings(userId: string): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(`folio-ai-settings:${userId}`) || '{}')
    return { ...defaults, provider: saved.provider === 'openai' ? 'openai' : 'ollama',
      ollamaModel: typeof saved.ollamaModel === 'string' ? saved.ollamaModel : '',
      openaiModel: typeof saved.openaiModel === 'string' ? saved.openaiModel : '' }
  } catch { return defaults }
}
export interface AppProps { user: AuthUser; onLogout: () => Promise<void>; onAuthenticated: (session: AuthSession) => void }
function App({ user, onLogout, onAuthenticated }: AppProps) {
  const [accountPage, setAccountPage] = useState<'admin' | 'password' | null>(null)
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [connectionAttempt, setConnectionAttempt] = useState(0)
  const [features, setFeatures] = useState<FeatureState | null>(null)
  const [featureError, setFeatureError] = useState('')
  const [featureAttempt, setFeatureAttempt] = useState(0)
  const webChatEnabled = features?.webChat === true
  const [page, setPage] = useState<'overview' | 'versions' | 'base' | 'chat'>('overview')
  const [chatActive, setChatActive] = useState(false)
  const [settings, setSettings] = useState<Settings>(() => loadSettings(user.id))
  const [modal, setModal] = useState<'settings' | 'generate' | null>(null)
  const [translation, setTranslation] = useState<{ source: TranslationSource; targetLanguage: TranslationTargetLanguage } | null>(null)
  const [initialDocumentType, setInitialDocumentType] = useState<DocumentType>('resume')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState(''), [filter, setFilter] = useState('all')
  const [documentFilter, setDocumentFilter] = useState<'all' | DocumentType>('all')
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [uploading, setUploading] = useState(false), [dragging, setDragging] = useState(false)
  const [baseEditing, setBaseEditing] = useState(false), [baseDraft, setBaseDraft] = useState(''), [baseSaving, setBaseSaving] = useState(false)
  const [baseDownloading, setBaseDownloading] = useState(false)
  const [careerRefreshing, setCareerRefreshing] = useState(false)
  const careerRequest = useRef<AbortController | null>(null)
  const [loggingOut, setLoggingOut] = useState(false)
  const logoutPending = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const base = workspace?.base, versions = workspace?.versions || []
  const selected = versions.find(version => version.id === selectedId)
  const baseDirty = baseEditing && baseDraft !== base?.text
  const logoutBlocked = !!(modal || translation || selectedId || baseSaving || uploading || baseDownloading || careerRefreshing)
  const careerRefreshBlocked = baseDirty ? 'Save or discard your base resume edits before regenerating.'
    : careerRefreshing ? 'Regeneration is in progress.'
    : baseSaving || uploading || baseDownloading || modal || translation || selectedId ? 'Finish the current document operation before regenerating.' : ''
  const logoutHint = logoutBlocked ? 'Close documents and dialogs, and finish saving, uploading, or downloading before signing out.' : ''
  useEffect(() => {
    let active = true
    void request<Workspace>('/workspace').then(data => {
      if (!active) return
      setWorkspace(data)
      setSettings(old => ({ ...old, ollamaModel: old.ollamaModel || data.config.ollamaModel, openaiModel: old.openaiModel || data.config.openaiModel }))
    }).catch(e => { if (active) setError(errorMessage(e)) })
    return () => { active = false }
  }, [connectionAttempt])
  useEffect(() => () => { careerRequest.current?.abort() }, [])
  useEffect(() => {
    if (accountPage) return
    let active = true
    let revision = 0
    async function refreshFeatures() {
      const current = ++revision
      try {
        const value = await getFeatures()
        if (!active || current !== revision) return
        setFeatures(value)
        setFeatureError('')
        if (value.webChat !== true) {
          setPage(old => old === 'chat' ? 'overview' : old)
          setChatActive(false)
        }
      } catch (e) {
        if (active && current === revision) {
          setFeatures(null)
          setPage(old => old === 'chat' ? 'overview' : old)
          setChatActive(false)
          setFeatureError(`Could not load feature availability. ${errorMessage(e)}`)
        }
      }
    }
    const onFocus = () => { void refreshFeatures() }
    const onVisible = () => { if (document.visibilityState === 'visible') void refreshFeatures() }
    void refreshFeatures()
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      active = false
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [accountPage, connectionAttempt, featureAttempt])
  useEffect(() => {
    try { localStorage.setItem(`folio-ai-settings:${user.id}`, JSON.stringify({ provider: settings.provider, ollamaModel: settings.ollamaModel, openaiModel: settings.openaiModel })) } catch { /* Private browsing may disable storage. */ }
  }, [settings, user.id])
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 5000)
    return () => clearTimeout(timer)
  }, [notice])
  useEffect(() => {
    const handle = (event: BeforeUnloadEvent) => { if (baseDirty || modal === 'generate' || selectedId || translation) event.preventDefault() }
    window.addEventListener('beforeunload', handle)
    return () => window.removeEventListener('beforeunload', handle)
  }, [baseDirty, modal, selectedId, translation])
  function navigate(next: typeof page) {
    if (next === 'chat' && !webChatEnabled) return
    if (page === 'chat' && next !== 'chat' && chatActive && !window.confirm('Leave chat? This temporary conversation and draft will be cleared.')) return
    if (baseDirty && !window.confirm('Discard your unsaved base resume changes?')) return
    setBaseEditing(false); setPage(next); setQuery(''); setFilter('all'); setDocumentFilter('all')
  }
  async function logout() {
    if (logoutBlocked || logoutPending.current) return
    if (chatActive && !window.confirm('Sign out and clear this temporary chat?')) return
    if (baseDirty && !window.confirm('Discard your unsaved base resume changes and sign out?')) return
    logoutPending.current = true
    setLoggingOut(true); setError('')
    try { await onLogout() }
    catch (e) { setError(`Could not sign out. ${errorMessage(e)}`) }
    finally { logoutPending.current = false; setLoggingOut(false) }
  }
  async function upload(file?: File) {
    if (!file || uploading || careerRequest.current) return
    if (file.size > 10 * 1024 * 1024) { setError('The file is too large. Choose a PDF up to 10 MB.'); return }
    if (!file.name.toLowerCase().endsWith('.pdf')) { setError('Choose a PDF resume. Other file types are not supported.'); return }
    if (base && !window.confirm('Replace your active base resume? Existing versions and their source snapshots will be kept.')) return
    setUploading(true); setError('')
    try {
      const form = new FormData(); form.append('resume', file)
      const uploaded = await request<BaseResume>('/base', { method: 'POST', body: form })
      setWorkspace(old => old && ({ ...old, base: uploaded })); setBaseEditing(false)
      setNotice('Base resume imported. Review the extracted text before tailoring.'); setPage('base')
    } catch (e) { setError(errorMessage(e)) } finally { setUploading(false) }
  }
  async function saveBase() {
    if (!base || careerRequest.current) return
    setBaseSaving(true); setError('')
    try {
      const updated = await request<BaseResume>(`/base/${base.id}`, { method: 'PATCH', body: JSON.stringify({ text: baseDraft }) })
      setWorkspace(old => old && ({ ...old, base: updated })); setBaseEditing(false); setNotice('Base text saved. Future versions will use these changes.')
    } catch (e) { setError(errorMessage(e)) } finally { setBaseSaving(false) }
  }
  async function downloadBase() {
    if (!base || baseDownloading) return
    setBaseDownloading(true); setError('')
    try { await downloadPdf(`/base/${base.id}/pdf`, base.filename) }
    catch (e) { setError(errorMessage(e)) } finally { setBaseDownloading(false) }
  }
  async function regenerateCareer() {
    if (careerRequest.current) throw new Error('Regeneration is already in progress.')
    if (careerRefreshBlocked) throw new Error(careerRefreshBlocked)
    const controller = new AbortController()
    careerRequest.current = controller
    setCareerRefreshing(true)
    try {
      // Read the active base afresh: another tab may have edited or replaced it.
      // Do not replace local version state or write anything back to the server.
      const latest = await request<Workspace>('/workspace', { cache: 'no-store', signal: controller.signal })
      if (controller.signal.aborted) return
      setWorkspace(old => old && ({ ...old, base: latest.base }))
      setBaseEditing(false)
      if (!latest.base) setNotice('No saved base resume is available. Import one to build a career path.')
    } finally {
      if (careerRequest.current === controller) careerRequest.current = null
      if (!controller.signal.aborted) setCareerRefreshing(false)
    }
  }
  function translateBase(targetLanguage: TranslationTargetLanguage) {
    if (!base || baseDirty || baseSaving || uploading || baseDownloading || translation || modal) return
    setTranslation({ source: { sourceType: 'base', sourceId: base.id, name: base.filename, documentType: 'resume' }, targetLanguage })
  }
  function newVersion(documentType: DocumentType = 'resume') {
    if (careerRequest.current) return
    if (baseDirty) { setError(documentType === 'cover-letter' ? 'Save or discard your base resume edits before creating a cover letter.' : 'Save or discard your base resume edits before creating a version.'); return }
    if (!base) { inputRef.current?.click(); return }
    setInitialDocumentType(documentType); setModal('generate')
  }
  const filtered = versions.filter(version => `${version.role} ${version.company} ${version.language?.name || ''}`.toLowerCase().includes(query.toLowerCase())
    && (filter === 'all' || version.status === filter)
    && (documentFilter === 'all' || (version.documentType ?? 'resume') === documentFilter))
  const ready = versions.filter(version => version.status === 'ready').length
  const applied = versions.filter(version => version.status === 'applied').length
  if (accountPage === 'admin' && user.role === 'admin') return <Administration user={user} onClose={() => {
    setFeatures(null); setPage('overview'); setAccountPage(null)
  }} />
  if (accountPage === 'password') return <PasswordChange onChanged={session => { setSettings(old => ({ ...old, apiKey: '' })); setAccountPage(null); onAuthenticated(session) }} onLogout={onLogout} onCancel={() => setAccountPage(null)} />
  return <div className="app-shell" inert={loggingOut} aria-busy={loggingOut}>
    <a className="skip-link" href="#main">Skip to content</a>
    <input ref={inputRef} type="file" accept="application/pdf,.pdf" className="sr-only" aria-label="Upload base resume PDF" onChange={e => { void upload(e.target.files?.[0]); e.target.value = '' }} disabled={uploading || careerRefreshing || !workspace} />
    <aside className="sidebar">
      <a className="brand" href="#" onClick={e => { e.preventDefault(); navigate('overview') }} aria-label="Folio home"><span className="brand-icon"><Layers3 size={24} /></span>folio<span className="brand-dot">.</span></a>
      <div className="workspace-label">YOUR WORKSPACE</div><nav aria-label="Main navigation">
        <button aria-label="Overview" className={page === 'overview' ? 'nav-item active' : 'nav-item'} onClick={() => navigate('overview')}><LayoutGrid size={19} /><span>Overview</span></button>
        <button aria-label="Resume versions" className={page === 'versions' ? 'nav-item active' : 'nav-item'} onClick={() => navigate('versions')}><FolderOpen size={19} /><span>Resume versions</span><span className="nav-count">{versions.length}</span></button>
        <button aria-label="Base resume" className={page === 'base' ? 'nav-item active' : 'nav-item'} onClick={() => navigate('base')}><FileText size={19} /><span>Base resume</span>{base && <span className="nav-dot" />}</button>
        {webChatEnabled && <button aria-label="Web chat" className={page === 'chat' ? 'nav-item active' : 'nav-item'} onClick={() => navigate('chat')}><MessageCircle size={19} /><span>Web chat</span></button>}
        {user.role === 'admin' && <button aria-label="Administration" className="nav-item" disabled={logoutBlocked || baseDirty || chatActive} onClick={() => setAccountPage('admin')}><ShieldCheck size={19} /><span>Administration</span></button>}
        <button aria-label="Change password" className="nav-item" disabled={logoutBlocked || baseDirty || chatActive} onClick={() => setAccountPage('password')}><LockKeyhole size={19} /><span>Change password</span></button>
      </nav><div className="sidebar-bottom"><div className="privacy-card"><span className="privacy-icon"><ShieldCheck size={21} /></span><h3>A little more peace of mind.</h3><p>Your files stay on this computer. You choose where AI runs.</p><span><span className="status-dot" />LOCAL STORAGE</span></div><button className="nav-item settings-nav" onClick={() => setModal('settings')} disabled={!workspace}><Settings2 size={19} /><span>AI settings</span></button><div className="workspace-user"><div className="avatar">{user.identifier.slice(0, 1).toUpperCase()}</div><div><strong title={user.identifier}>{user.identifier}</strong><span>Private local account</span></div><LockKeyhole size={15} /></div></div>
    </aside>
    <div className="main-shell"><header className="topbar"><div className="breadcrumb">Workspace<ChevronRight size={14} /><span>{page === 'overview' ? 'Overview' : page === 'versions' ? 'Resume versions' : page === 'chat' ? 'Web chat' : 'Base resume'}</span></div><div className="topbar-right"><span className="local-badge"><span className="status-dot" />{page === 'chat' ? 'Temporary chat' : 'Stored locally'}</span><span className="account-identifier" title={user.identifier}>{user.identifier}</span><button className="icon-button" aria-label="Open AI settings" onClick={() => setModal('settings')} disabled={!workspace}><Settings2 size={18} /></button><button className="button secondary small" onClick={() => void logout()} disabled={logoutBlocked || loggingOut} aria-describedby={logoutBlocked ? 'sign-out-hint' : undefined}>{loggingOut ? 'Signing out…' : 'Sign out'}</button></div>{logoutBlocked && <p className="sign-out-hint" id="sign-out-hint">{logoutHint}</p>}</header>
      <main id="main">
        {featureError && <div className="page-error"><InlineError message={featureError} /><button className="button secondary" onClick={() => setFeatureAttempt(value => value + 1)}>Retry features</button></div>}
        {error && <div className="page-error"><InlineError message={error} />{!workspace && <button className="button secondary" onClick={() => { setError(''); setConnectionAttempt(value => value + 1) }}>Retry connection</button>}<button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><X size={17} /></button></div>}
        {!workspace ? <div className="loading-state" role="status"><LoaderCircle className="spin" size={26} /><p>{error ? 'Waiting for your local server' : 'Opening your workspace…'}</p></div> : page === 'chat' && webChatEnabled ? <Chat onActivity={setChatActive} /> : <>
          <div className="page-heading"><div><span className="eyebrow">{page === 'overview' ? 'A THOUGHTFUL NEXT STEP' : page === 'versions' ? 'YOUR CAREER, MANY POSSIBILITIES' : 'THE STARTING POINT'}</span><h1>{page === 'overview' ? 'Your experience. The right story.' : page === 'versions' ? 'One you. Every opportunity.' : 'Great versions start here.'}</h1><p>{page === 'overview' ? 'One base resume. Tailored resumes and cover letters for every opportunity.' : page === 'versions' ? 'Keep every tailored resume and cover letter together, from first draft to application.' : 'Your original experience is the source of truth for every tailored document.'}</p></div><div className="header-actions"><button className="button primary" onClick={() => newVersion()} disabled={uploading}><Plus size={18} />New version</button><button className="button secondary" onClick={() => newVersion('cover-letter')} disabled={uploading}><Plus size={18} />New cover letter</button></div></div>
          {page === 'overview' && <>
            <section className="hero-card"><div className="hero-copy"><span className="pill"><Sparkles size={13} />A BETTER FIT, NOT A DIFFERENT YOU</span><h2>Your next opportunity<br />deserves its own resume.</h2><p>Bring your experience. Add a job description.<br />Let AI help the right details shine.</p><button className="button cream" onClick={() => newVersion()} disabled={uploading}>{base ? 'Tailor a new version' : 'Start with your base resume'}<ArrowUpRight size={17} /></button><span className="hero-footnote"><ShieldCheck size={13} />Your original stays untouched.</span></div><div className="hero-art" aria-hidden="true"><div className="art-orbit" /><div className="mini-resume back"><div className="mini-line" /><div className="mini-line short" /><div className="mini-rule" /><div className="mini-line" /><div className="mini-line" /></div><div className="mini-resume front"><div className="mini-resume-icon"><FileText size={19} /></div><div className="mini-name">YOUR EXPERIENCE</div><div className="mini-line short" /><div className="mini-rule" /><div className="mini-label">THE RIGHT DETAILS</div><div className="mini-line green" /><div className="mini-line" /><div className="mini-line short" /><div className="mini-rule" /><div className="mini-line" /><div className="mini-line green short" /><span className="mini-check"><Check size={15} />Tailored to the role</span></div><div className="art-spark"><Sparkles size={25} /></div></div></section>
            <section className="stats-grid" aria-label="Workspace statistics"><div className="stat-card"><span className="stat-icon"><Layers3 size={21} /></span><div><span>Saved documents</span><strong>{versions.length.toString().padStart(2, '0')}</strong></div><span className="stat-note">Every opportunity, organized</span></div><div className="stat-card"><span className="stat-icon peach"><FileCheck2 size={21} /></span><div><span>Ready to send</span><strong>{ready.toString().padStart(2, '0')}</strong></div><span className="stat-note">Reviewed and ready</span></div><div className="stat-card"><span className="stat-icon lavender"><BriefcaseBusiness size={21} /></span><div><span>Applications sent</span><strong>{applied.toString().padStart(2, '0')}</strong></div><span className="stat-note">Your next chapter awaits</span></div></section>
          </>}
          {page === 'overview' && base && <CareerPath text={base.text} onRegenerate={regenerateCareer} disabledReason={careerRefreshBlocked} />}
          {page === 'base' ? <section className="base-page">{base ? <>
            <div className="base-document-heading"><div className="file-icon"><FileText size={25} /></div><div><h2>{base.filename}</h2><p>{base.pages} {base.pages === 1 ? 'page' : 'pages'} · Added {date(base.createdAt)}</p></div><button className="button secondary" disabled={uploading} onClick={() => inputRef.current?.click()}><Upload size={16} />Replace PDF</button><button className="button secondary" disabled={baseDownloading || uploading} onClick={() => void downloadBase()}><ArrowDownToLine size={16} />Original PDF</button></div>
            <TranslationActions dirty={baseDirty} busy={baseSaving || uploading || baseDownloading || !!translation} onTranslate={translateBase} />
            <CareerPath text={base.text} onRegenerate={regenerateCareer} disabledReason={careerRefreshBlocked} />
            <div className="base-note"><ShieldCheck size={18} /><p>Review the extracted text below. Fix any PDF formatting issues before creating a version. Text edits affect future generations only; the original PDF and existing versions stay unchanged.</p></div>
            <div className="document-toolbar"><span>{baseEditing ? 'EDIT EXTRACTED TEXT' : 'EXTRACTED RESUME'}</span>{baseEditing ? <div className="button-row"><button className="text-button" onClick={() => { if (!baseDirty || window.confirm('Discard your unsaved base resume changes?')) setBaseEditing(false) }} disabled={baseSaving}>Cancel</button><button className="button primary small" onClick={() => void saveBase()} disabled={baseSaving || careerRefreshing}>{baseSaving ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}Save text</button></div> : <button className="text-button" disabled={careerRefreshing} onClick={() => { setBaseDraft(base.text); setBaseEditing(true) }}>Edit extracted text</button>}</div>
            {baseEditing ? <textarea className="base-editor" aria-label="Base resume text" value={baseDraft} onChange={e => setBaseDraft(e.target.value)} maxLength={50000} disabled={baseSaving || careerRefreshing} /> : <ResumePaper text={base.text} />}
          </> : <UploadArea dragging={dragging} uploading={uploading} onDrag={setDragging} onUpload={upload} onBrowse={() => inputRef.current?.click()} />}</section> : <div className={page === 'overview' ? 'content-columns' : ''}>
            <section className="versions-section"><div className="section-heading"><div><h2>{page === 'overview' ? 'Your documents' : 'All documents'} <span className="count-badge">{versions.length}</span></h2><p>Resumes and cover letters. A focused story for each role.</p></div>{page === 'overview' && versions.length > 0 && <button className="text-button" onClick={() => navigate('versions')}>View all<ArrowRight size={15} /></button>}</div>
              <div className="filter-bar"><div className="search-field"><Search size={17} /><input aria-label="Search resume versions" placeholder="Search by role or company…" value={query} onChange={e => setQuery(e.target.value)} /></div><select className="document-type-filter" aria-label="Filter by document type" value={documentFilter} onChange={e => setDocumentFilter(e.target.value as typeof documentFilter)}><option value="all">All documents</option><option value="resume">Resumes</option><option value="cover-letter">Cover letters</option></select><select aria-label="Filter by status" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">All statuses</option><option value="draft">Draft</option><option value="ready">Ready</option><option value="applied">Applied</option></select></div>
              {filtered.length ? <div className="version-grid">{filtered.map(version => <button className="version-card" key={version.id} onClick={() => setSelectedId(version.id)}>
                <div className="version-top"><span className="company-avatar">{version.company.slice(0, 2).toUpperCase()}</span><span className={`status-badge ${version.status}`}><span />{version.status}</span></div>
                <h3>{version.role}</h3><p className="version-company">{version.company}</p>
                {version.documentType === 'cover-letter' && <span className="document-type-badge">Cover letter</span>}
                {version.language && <span className="language-badge">{version.language.name}</span>}
                {version.translation && <span className="translation-badge">Translation</span>}
                <div className="version-keywords">{version.keywords.slice(0, 3).map((word, i) => <span key={i}>{word}</span>)}</div><div className="version-bottom"><span><Clock3 size={13} />{date(version.createdAt)}</span><ArrowUpRight size={17} /></div>
              </button>)}</div> : <div className="empty-state"><div className="empty-icon"><Layers3 size={29} /><span><Plus size={12} /></span></div><h3>{versions.length ? 'No versions found' : 'Your next chapter starts here.'}</h3><p>{versions.length ? 'Try another search, document type, or status.' : 'Turn your base resume into a tailored resume or cover letter for the role you have in mind.'}</p><button className="button secondary" onClick={versions.length ? () => { setQuery(''); setFilter('all'); setDocumentFilter('all') } : () => newVersion(documentFilter === 'cover-letter' ? 'cover-letter' : 'resume')} disabled={uploading}>{versions.length ? 'Clear filters' : <><Plus size={16} />{documentFilter === 'cover-letter' ? 'Create your first cover letter' : 'Create your first version'}</>}</button></div>}
            </section>
            {page === 'overview' && <aside className="context-column"><section className="base-summary"><div className="section-heading"><h2>Your foundation</h2><span className="subtle-icon"><FileText size={18} /></span></div>{base ? <><div className="base-file"><div className="file-icon"><FileText size={24} /></div><div><strong>{base.filename}</strong><span>{base.pages} {base.pages === 1 ? 'page' : 'pages'} · PDF document</span></div><span className="success-icon"><Check size={15} /></span></div><p>Your source of truth. Every new version starts with this experience.</p><button className="button secondary full-width" onClick={() => navigate('base')}>View base resume<ArrowUpRight size={15} /></button></> : <UploadArea compact dragging={dragging} uploading={uploading} onDrag={setDragging} onUpload={upload} onBrowse={() => inputRef.current?.click()} />}</section><section className="how-it-works"><span className="eyebrow">FROM EXPERIENCE TO OPPORTUNITY</span><h3>A simpler way to apply.</h3><ol><li><span>01</span><div><strong>Start with your story</strong><p>Upload your base resume as a PDF.</p></div></li><li><span>02</span><div><strong>Add the opportunity</strong><p>Paste a job description. AI brings your relevant experience forward.</p></div></li><li><span>03</span><div><strong>Make it yours</strong><p>Review, refine, and export a resume ready for the next step.</p></div></li></ol></section></aside>}
          </div>}
          <footer className="page-footer"><span><LockKeyhole size={13} />Locally stored. Thoughtfully tailored.</span><span>Built around your next chapter.</span></footer>
        </>}
      </main>
    </div>
    {notice && <div className="toast" role="status"><Check size={18} />{notice}<button className="icon-button" aria-label="Dismiss notification" onClick={() => setNotice('')}><X size={15} /></button></div>}
    {modal === 'settings' && workspace && <SettingsForm settings={settings} configured={workspace.config.openaiConfigured} onClose={() => setModal(null)} onSave={value => { setSettings(value); setModal(null); setNotice('AI preferences saved. API keys are kept in memory only.') }} />}
    {modal === 'generate' && base && workspace && <GenerateForm base={base} settings={settings} configured={workspace.config.openaiConfigured} initialDocumentType={initialDocumentType} onClose={() => setModal(null)} onCreated={created => {
      setWorkspace(old => old && ({ ...old, versions: [...created, ...old.versions] })); setModal(null); setSelectedId(created[0].id)
      setNotice(created[0].documentType === 'cover-letter'
        ? (created.length > 1 ? `${created[0].language?.name} and English cover letter drafts are ready. Review both before applying.` : 'Your English cover letter draft is ready. Review it before applying.')
        : (created.length > 1 ? `${created[0].language?.name} and English drafts are ready. Review both before applying.` : 'Your English draft is ready. Review it before applying.'))
    }} />}
    {translation && workspace && <TranslationForm source={translation.source} initialTargetLanguage={translation.targetLanguage} settings={settings} configured={workspace.config.openaiConfigured} onClose={() => setTranslation(null)} onCreated={version => {
      setWorkspace(old => old && ({ ...old, versions: [version, ...old.versions.filter(item => item.id !== version.id)] }))
      setTranslation(null); setSelectedId(version.id)
      setNotice(`Your ${version.language?.name || 'translated'} ${version.documentType === 'cover-letter' ? 'cover letter' : 'resume'} translation is saved as a separate draft. Review it before sending.`)
    }} />}
    {/* Unmount the native detail dialog during confirmation; its saved source ID stays selected for Cancel. */}
    {selected && !translation && <VersionDetail key={selected.id} version={selected} variants={!selected.translation && selected.generationId ? versions.filter(item => !item.translation && item.generationId === selected.generationId && (item.documentType ?? 'resume') === (selected.documentType ?? 'resume')) : [selected]} onSelect={setSelectedId} onClose={() => setSelectedId(null)} onTranslate={targetLanguage => {
      setTranslation({ source: { sourceType: 'version', sourceId: selected.id, name: `${selected.role} at ${selected.company}`, documentType: selected.documentType ?? 'resume' }, targetLanguage })
    }} onSaved={version => { setWorkspace(old => old && ({ ...old, versions: old.versions.map(item => item.id === version.id ? version : item) })); setNotice(version.documentType === 'cover-letter' ? 'Cover letter saved.' : 'Resume version saved.') }} onDeleted={id => { setWorkspace(old => old && ({ ...old, versions: old.versions.filter(item => item.id !== id) })); setSelectedId(null); setNotice(selected.documentType === 'cover-letter' ? 'Cover letter deleted.' : 'Resume version deleted.') }} />}
  </div>
}
export default App