import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { ArrowDownToLine, Check, CheckCheck, CircleAlert, FileText, LoaderCircle, LockKeyhole, Plus, ShieldCheck, Sparkles, Trash2, Upload, X } from 'lucide-react'
import type { AiProvider, BaseResume, DocumentType, GenerationResponse, ResumeVersion, Settings, TranslationRequest, TranslationSource, TranslationTargetLanguage } from './types'
import { date, downloadPdf, errorMessage, request } from './api'

const providerNames: Record<AiProvider, string> = { ollama: 'Ollama', openai: 'OpenAI', lmstudio: 'LM Studio', byok: 'BYOK' }
function selectedModel(settings: Settings) {
  return settings.provider === 'byok' ? settings.byokModel : settings.provider === 'lmstudio' ? settings.lmstudioModel : settings.provider === 'ollama' ? settings.ollamaModel : settings.openaiModel
}
function usesCloud(settings: Settings) {
  return settings.provider === 'openai' || settings.provider === 'byok'
}
function selectedApiKey(settings: Settings) {
  return settings.provider === 'byok' ? settings.byokApiKey : settings.apiKey
}
function cloudDestination(settings: Settings) {
  return settings.provider === 'byok' ? `BYOK (${settings.byokBaseUrl})` : 'OpenAI'
}
function cloudOptions(settings: Settings, apiKey: string, consent: boolean) {
  return usesCloud(settings) ? { apiKey, cloudConsent: consent, ...(settings.provider === 'byok' ? { baseUrl: settings.byokBaseUrl } : {}) } : {}
}
function canProcess(settings: Settings, configured: boolean, apiKey: string, consent: boolean) {
  return !!selectedModel(settings).trim()
    && (settings.provider !== 'byok' || !!settings.byokBaseUrl.trim())
    && (!usesCloud(settings) || (consent && ((settings.provider === 'openai' && configured) || !!apiKey.trim())))
}
function GenerationProvider({ settings }: { settings: Settings }) {
  return <div className="generation-provider">{usesCloud(settings) ? <Sparkles size={16} /> : <LockKeyhole size={16} />}<span>{usesCloud(settings) ? `Processed in the cloud with ${cloudDestination(settings)}` : `Processed locally with ${providerNames[settings.provider]}`} <strong>· {selectedModel(settings) || 'No model selected'}</strong></span></div>
}
function Modal({ title, eyebrow, onClose, children, wide = false, busy = false }: {
  title: string; eyebrow: string; onClose: () => void; children: ReactNode; wide?: boolean; busy?: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close() }, [])
  return <dialog ref={ref} className={`modal ${wide ? 'modal-wide' : ''}`} aria-label={title}
    onCancel={event => { event.preventDefault(); if (!busy) onClose() }}>
    <div className="modal-header"><div><span className="eyebrow">{eyebrow}</span><h2>{title}</h2></div>
      <button className="icon-button" aria-label="Close dialog" onClick={onClose} disabled={busy}><X size={20} /></button></div>
    {children}
  </dialog>
}
export function InlineError({ message }: { message: string }) {
  return message ? <div className="inline-error" role="alert"><CircleAlert size={18} /><span>{message}</span></div> : null
}
function textDirection(language?: string) {
  return language && ['ar', 'fa', 'he', 'ur', 'ps', 'sd', 'yi'].includes(language.split('-')[0]) ? 'rtl' : 'auto'
}
export function ResumePaper({ text, language, documentType = 'resume' }: { text: string; language?: string; documentType?: DocumentType }) {
  if (documentType === 'cover-letter') {
    const [candidate, ...body] = text.trim().split(/\r?\n/)
    const paragraphs = body.join('\n').trim().split(/\n\s*\n/).filter(Boolean)
    return <article className="resume-paper cover-letter-paper" aria-label="Cover letter preview" lang={language} dir={textDirection(language)}>
      <header><h2>{candidate}</h2></header>
      {paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
    </article>
  }
  return <article className="resume-paper" aria-label="Resume preview" lang={language} dir={textDirection(language)}>{text.split('\n').map((line, index) => {
    if (index === 0) return <h2 key={index}>{line}</h2>
    if (line.trim() && line.length < 65 && /[A-Z]/.test(line) && line === line.toUpperCase()) return <h3 key={index}>{line}</h3>
    return <p key={index}>{line || '\u00A0'}</p>
  })}</article>
}
export function SettingsForm({ settings, configured, onSave, onClose }: { settings: Settings; configured: boolean; onSave: (settings: Settings) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(settings)
  const [models, setModels] = useState<string[] | null>(null)
  const [checking, setChecking] = useState(false), [connectionError, setConnectionError] = useState('')
  const [settingsError, setSettingsError] = useState('')
  function selectProvider(provider: AiProvider) {
    setDraft(old => ({ ...old, provider })); setModels(null); setConnectionError(''); setSettingsError('')
  }
  function save(event: FormEvent) {
    event.preventDefault()
    if (draft.provider !== 'byok') { onSave(draft); return }
    let url: URL
    try { url = new URL(draft.byokBaseUrl.trim()) }
    catch { setSettingsError('Enter a valid HTTPS API base URL.'); return }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      setSettingsError('Use an HTTPS API base URL without credentials, query parameters, or a fragment.'); return
    }
    if (!draft.byokModel.trim()) { setSettingsError('Enter the provider’s exact model name.'); return }
    onSave({ ...draft, byokBaseUrl: url.href.replace(/\/+$/, ''), byokModel: draft.byokModel.trim() })
  }
  async function checkConnection() {
    setChecking(true); setConnectionError(''); setModels(null)
    try { setModels((await request<{ models: string[] }>(draft.provider === 'lmstudio' ? '/lmstudio/models' : '/ollama/models')).models) }
    catch (error) { setConnectionError(errorMessage(error)) }
    finally { setChecking(false) }
  }
  return <Modal title="Your AI, your choice." eyebrow="AI SETTINGS" onClose={onClose}>
    <form onSubmit={save}><div className="modal-body">
      <p className="muted">Choose where your resume is processed. Your versions are always stored on this computer.</p>
      <div className="provider-options">
        <button type="button" className={`provider-option ${draft.provider === 'lmstudio' ? 'selected' : ''}`} disabled={checking} onClick={() => selectProvider('lmstudio')} aria-pressed={draft.provider === 'lmstudio'}><LockKeyhole size={22} /><strong>LM Studio</strong><span>Local & private</span>{draft.provider === 'lmstudio' && <Check size={18} />}</button>
        <button type="button" className={`provider-option ${draft.provider === 'ollama' ? 'selected' : ''}`} disabled={checking} onClick={() => selectProvider('ollama')} aria-pressed={draft.provider === 'ollama'}><LockKeyhole size={22} /><strong>Ollama</strong><span>Local & private</span>{draft.provider === 'ollama' && <Check size={18} />}</button>
        <button type="button" className={`provider-option ${draft.provider === 'openai' ? 'selected' : ''}`} disabled={checking} onClick={() => selectProvider('openai')} aria-pressed={draft.provider === 'openai'}><Sparkles size={22} /><strong>OpenAI</strong><span>Cloud processing</span>{draft.provider === 'openai' && <Check size={18} />}</button>
        <button type="button" className={`provider-option ${draft.provider === 'byok' ? 'selected' : ''}`} disabled={checking} onClick={() => selectProvider('byok')} aria-pressed={draft.provider === 'byok'}><Sparkles size={22} /><strong>BYOK</strong><span>Your own model</span>{draft.provider === 'byok' && <Check size={18} />}</button>
      </div>
      {draft.provider === 'lmstudio' ? <>
        <label>LM Studio model<input required maxLength={100} value={draft.lmstudioModel} onChange={event => setDraft({ ...draft, lmstudioModel: event.target.value })} placeholder="google/gemma-4-e4b" /></label>
        <button type="button" className="button secondary" disabled={checking} onClick={() => void checkConnection()}>{checking ? 'Checking connection…' : 'Check connection'}</button>
        <InlineError message={connectionError} />
        {models !== null && <>
          <p className="field-hint" role="status">{models.length ? `LM Studio is connected. ${models.length} available model(s).` : 'LM Studio is connected, but no models are available. Load a chat model first.'}</p>
          {models.length > 0 && <label>Available LM Studio models<select value={models.includes(draft.lmstudioModel) ? draft.lmstudioModel : ''} onChange={event => setDraft({ ...draft, lmstudioModel: event.target.value })}><option value="" disabled>Select a chat model</option>{models.map(model => <option key={model} value={model}>{model}</option>)}</select></label>}
          {models.length > 0 && !models.includes(draft.lmstudioModel) && <p className="field-hint">The model entered above is not available. Select a loaded chat model and save settings.</p>}
        </>}
        <div className="info-box"><ShieldCheck size={20} /><div><strong>Nothing leaves your computer</strong><p>Load your selected model in LM Studio and start its local server at http://127.0.0.1:1234. Folio uses its OpenAI-compatible API locally, not the OpenAI cloud. No cloud consent or OpenAI key is needed.</p></div></div>
      </> : draft.provider === 'ollama' ? <>
        <label>Ollama model<input required maxLength={100} value={draft.ollamaModel} onChange={e => setDraft({ ...draft, ollamaModel: e.target.value })} placeholder="llama3.2" /></label>
        <button type="button" className="button secondary" disabled={checking} onClick={() => void checkConnection()}>{checking ? 'Checking connection…' : 'Check connection'}</button>
        <InlineError message={connectionError} />
        {models !== null && <>
          <p className="field-hint" role="status">{models.length ? `Ollama is connected. ${models.length} installed model(s).` : 'Ollama is connected, but no models are installed. Download a local model first.'}</p>
          {models.length > 0 && <label>Installed Ollama models<select value={models.includes(draft.ollamaModel) ? draft.ollamaModel : ''} onChange={event => setDraft({ ...draft, ollamaModel: event.target.value })}><option value="" disabled>Select an installed model</option>{models.map(model => <option key={model} value={model}>{model}</option>)}</select></label>}
          {models.length > 0 && !models.includes(draft.ollamaModel) && <p className="field-hint">The model entered above is not installed. Select an installed model and save settings.</p>}
        </>}
        <div className="info-box"><ShieldCheck size={20} /><div><strong>Nothing leaves your computer</strong><p>Install and start Ollama, then download the model with <code>ollama pull {draft.ollamaModel || 'llama3.2'}</code> in your terminal. The app connects to your local Ollama service.</p></div></div>
      </> : draft.provider === 'byok' ? <>
        <label>API base URL<input required type="url" maxLength={2000} value={draft.byokBaseUrl} onChange={event => { setDraft({ ...draft, byokBaseUrl: event.target.value, byokApiKey: '' }); setSettingsError('') }} placeholder="https://api.example.com/v1" /></label>
        <p className="field-hint">Use a public HTTPS OpenAI-compatible API base URL, including its version path. Folio appends /chat/completions. Private/local addresses and redirects are blocked. Changing the URL clears the BYOK key.</p>
        <label>BYOK model<input required maxLength={100} value={draft.byokModel} onChange={event => setDraft({ ...draft, byokModel: event.target.value })} placeholder="Your provider's exact model ID" /></label>
        <label>BYOK API key<input type="password" autoComplete="off" maxLength={500} value={draft.byokApiKey} onChange={event => setDraft({ ...draft, byokApiKey: event.target.value })} placeholder="Enter your provider's API key" /></label>
        <p className="field-hint">Bring your own key for an API supporting chat completions and JSON mode. Keys stay in memory only and are cleared on refresh or logout. Your OpenAI key is never reused. Each generation, cleanup, or translation requires consent; your provider's privacy policy and usage charges apply. Web chat continues to use LM Studio.</p>
      </> : <>
        <label>OpenAI model<input required maxLength={100} value={draft.openaiModel} onChange={e => setDraft({ ...draft, openaiModel: e.target.value })} placeholder="gpt-4o-mini" /></label>
        <label>API key <span className="optional">{configured ? 'server key configured' : 'required for generation'}</span><input type="password" autoComplete="off" maxLength={500} value={draft.apiKey} onChange={e => setDraft({ ...draft, apiKey: e.target.value })} placeholder={configured ? 'Using server key unless overridden' : 'Enter your OpenAI API key'} /></label>
        <p className="field-hint">Keys entered here stay in memory only and are cleared on refresh. OpenAI may charge for API usage. Your resume and job description are sent to OpenAI only when you explicitly confirm generation.</p>
      </>}
      <InlineError message={settingsError} />
    </div><div className="modal-footer"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button className="button primary" type="submit"><Check size={16} />Save settings</button></div></form>
  </Modal>
}
export function GenerateForm({ base, settings, configured, initialDocumentType = 'resume', onClose, onCreated }: {
  base: BaseResume; settings: Settings; configured: boolean; initialDocumentType?: DocumentType; onClose: () => void; onCreated: (versions: ResumeVersion[]) => void
}) {
  const [documentType, setDocumentType] = useState<DocumentType>(initialDocumentType)
  const isCoverLetter = documentType === 'cover-letter'
  const [role, setRole] = useState(''), [company, setCompany] = useState(''), [jd, setJd] = useState('')
  const [consent, setConsent] = useState(false), [apiKey, setApiKey] = useState(selectedApiKey(settings))
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [uploading, setUploading] = useState(false), [jdFilename, setJdFilename] = useState('')
  const jdFileInput = useRef<HTMLInputElement>(null)
  const pending = useRef(false)
  const model = selectedModel(settings)
  const serverConfigured = settings.provider === 'openai' && configured
  const canSubmit = canProcess(settings, configured, apiKey, consent)
  const close = () => { if (!pending.current && (!jd || window.confirm('Discard this job description?'))) onClose() }
  async function uploadJd(file: File) {
    if (pending.current) return
    setError('')
    if (!/\.(pdf|txt)$/i.test(file.name)) { setError('Upload a PDF or UTF-8 .txt file.'); return }
    if (file.size > 10 * 1024 * 1024) { setError('Upload one document, up to 10 MB.'); return }
    if (jd && !window.confirm('Replace the current job description with text from this document?')) return
    pending.current = true; setBusy(true); setUploading(true); setConsent(false)
    try {
      const body = new FormData(); body.append('document', file)
      const result = await request<{ text: string }>('/job-description/extract', { method: 'POST', body })
      setJd(result.text); setJdFilename(file.name)
    } catch (error) { setError(errorMessage(error)) }
    finally { pending.current = false; setBusy(false); setUploading(false) }
  }
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (pending.current) return
    if (!canSubmit) { setError('Select a model in AI settings and provide the required API key and consent before generating.'); return }
    if (jd.trim().length < 80) { setError('Add at least 80 characters to the job description before generating.'); return }
    pending.current = true; setBusy(true); setError('')
    try {
      const { additionalVersions = [], ...version } = await request<GenerationResponse>('/versions', { method: 'POST', body: JSON.stringify({ baseId: base.id, role, company, jobDescription: jd, documentType, provider: settings.provider, model, ...cloudOptions(settings, apiKey, consent) }) })
      onCreated([version, ...additionalVersions])
    } catch (e) { setError(errorMessage(e)) } finally { pending.current = false; setBusy(false) }
  }
  return <Modal title={isCoverLetter ? 'A cover letter for your next chapter.' : 'A resume for your next chapter.'} eyebrow={isCoverLetter ? 'CREATE A COVER LETTER' : 'CREATE A TAILORED VERSION'} onClose={close} busy={busy}>
    <form onSubmit={submit}><div className="modal-body">
      <div className="source-strip"><FileText size={21} /><div><strong>{base.filename}</strong><span>Your base resume · facts stay grounded in your experience</span></div></div>
      <label>Document type<select aria-label="Document type" value={documentType} disabled={busy} onChange={event => { setDocumentType(event.target.value as DocumentType); setConsent(false); setError('') }}><option value="resume">Resume</option><option value="cover-letter">Cover letter</option></select></label>
      <div className="form-grid"><label>Job title<input autoFocus required maxLength={150} value={role} onChange={e => setRole(e.target.value)} placeholder="e.g. Senior Product Designer" disabled={busy} /></label><label>Company<input required maxLength={150} value={company} onChange={e => setCompany(e.target.value)} placeholder="e.g. Linear" disabled={busy} /></label></div>
      <div className="jd-upload">
        <input ref={jdFileInput} type="file" accept=".pdf,.txt,application/pdf,text/plain" aria-label="Upload JD document" hidden disabled={busy} onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void uploadJd(file) }} />
        <button type="button" className="button secondary" disabled={busy} onClick={() => jdFileInput.current?.click()}>{uploading ? <LoaderCircle className="spin" size={17} /> : <Upload size={17} />}{uploading ? 'Extracting job description…' : 'Upload JD document'}</button>
        <p className="field-hint">PDF or UTF-8 TXT · up to 10 MB, 30 pages and 30,000 characters. Text is extracted locally; the uploaded file is not saved or sent to AI. Scans need OCR first.</p>
        {jdFilename && <p className="field-hint" role="status">Imported {jdFilename}. Review and edit the text below before generating.</p>}
        {uploading && <p role="status" className="field-hint">Extracting text locally. Keep this window open.</p>}
      </div>
      <label>Job description<textarea aria-label="Job description" required minLength={80} maxLength={30000} rows={9} value={jd} onChange={e => { setJd(e.target.value); setConsent(false) }} placeholder="Paste the job description, or upload a document above…" disabled={busy} /></label>
      <div className="field-meta"><span>At least 80 characters</span><span>{jd.length.toLocaleString()} / 30,000</span></div>
      <div className="info-box language-notice"><Sparkles size={20} /><div><strong>Automatic language matching</strong><p>{isCoverLetter ? 'The AI detects the main language of your job description. English jobs get one English cover letter. Other languages get a matching-language cover letter plus an English version, saved locally as two separate drafts. Edit, track status, and export each independently.' : 'The AI detects the main language of your job description. English jobs get one English resume. Other languages get a matching-language resume plus an English version, saved as two separate drafts.'}</p></div></div>
      <GenerationProvider settings={settings} />
      {usesCloud(settings) && <>
        {!serverConfigured && !selectedApiKey(settings).trim() && <label>{providerNames[settings.provider]} API key<input required type="password" autoComplete="off" maxLength={500} value={apiKey} onChange={e => { setApiKey(e.target.value); setConsent(false) }} disabled={busy} placeholder="Kept in memory for this request" /></label>}
        <label className="checkbox-label"><input type="checkbox" required checked={consent} onChange={e => setConsent(e.target.checked)} disabled={busy} /><span>I agree to send my base resume and this job description to {cloudDestination(settings)} for this generation.</span></label>
      </>}
      <InlineError message={error} />
      {busy && !uploading && <div className="generation-progress" role="status"><LoaderCircle className="spin" size={20} /><div><strong>Finding the right words…</strong><span>Reviewing your experience against this role. This may take up to 3 minutes; keep this window open.</span></div></div>}
      <p className="field-hint">AI can make mistakes. Review every claim before applying. Your base resume is never overwritten.</p>
    </div><div className="modal-footer"><button type="button" className="button secondary" onClick={close} disabled={busy}>Cancel</button><button className="button primary" type="submit" disabled={busy}>{busy ? <LoaderCircle className="spin" size={17} /> : <Sparkles size={17} />}{uploading ? 'Extracting document…' : busy ? (isCoverLetter ? 'Writing cover letter…' : 'Tailoring resume…') : (isCoverLetter ? 'Generate cover letter' : 'Generate version')}</button></div></form>
  </Modal>
}
export interface TranslationActionsProps {
  dirty: boolean; busy: boolean; onTranslate: (targetLanguage: TranslationTargetLanguage) => void
}
export function CleanResumeForm({ base, settings, configured, onClose, onCreated }: {
  base: BaseResume; settings: Settings; configured: boolean; onClose: () => void; onCreated: (versions: ResumeVersion[]) => void
}) {
  const [consent, setConsent] = useState(false), [apiKey, setApiKey] = useState(selectedApiKey(settings))
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const pending = useRef(false)
  const model = selectedModel(settings)
  const serverConfigured = settings.provider === 'openai' && configured
  const canSubmit = canProcess(settings, configured, apiKey, consent)
  const close = () => { if (!pending.current) onClose() }
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (pending.current || !canSubmit) return
    pending.current = true; setBusy(true); setError('')
    try {
      const result = await request<{ versions: ResumeVersion[] }>('/base/clean', { method: 'POST', body: JSON.stringify({
        baseId: base.id, provider: settings.provider, model,
        ...cloudOptions(settings, apiKey, consent),
      }) })
      onCreated(result.versions)
    } catch (e) { setError(errorMessage(e)) }
    finally { pending.current = false; setBusy(false) }
  }
  return <Modal title="Create clean base resumes" eyebrow="ENGLISH + 简体中文" onClose={close} busy={busy}>
    <form onSubmit={submit}><div className="modal-body">
      <div className="source-strip"><FileText size={21} /><div><strong>{base.filename}</strong><span>Uses the current saved base text</span></div></div>
      <div className="info-box"><Sparkles size={20} /><div><strong>One foundation, two editable languages</strong><p>AI cleans formatting, grammar and wording into complete English and Simplified Chinese resumes. No job description is needed. Both drafts are saved together; edit and export each separately.</p></div></div>
      <p className="muted">Your original PDF, extracted text and previous drafts stay unchanged. Future tailoring still uses your saved extracted text. Generating again creates new drafts without overwriting your edits.</p>
      <GenerationProvider settings={settings} />
      {!model.trim() && <p className="field-hint">Cancel and select a model in AI settings before generating.</p>}
      {usesCloud(settings) && <>
        <label>{providerNames[settings.provider]} API key <span className="optional">{serverConfigured ? 'server key configured' : 'required for generation'}</span><input type="password" autoComplete="off" maxLength={500} required={!serverConfigured} value={apiKey} onChange={event => { setApiKey(event.target.value); setConsent(false) }} disabled={busy} placeholder={serverConfigured ? 'Using server key unless overridden' : 'Kept in memory for this request'} /></label>
        <label className="checkbox-label"><input type="checkbox" required checked={consent} onChange={event => setConsent(event.target.checked)} disabled={busy} /><span>I agree to send my base resume to {cloudDestination(settings)} to create clean English and Chinese versions.</span></label>
        <p className="field-hint">Keys stay in memory only. {providerNames[settings.provider]} usage may incur provider charges. Consent applies only to this generation.</p>
      </>}
      <InlineError message={error} />
      {busy && <div className="generation-progress" role="status"><LoaderCircle className="spin" size={20} /><div><strong>Cleaning both language versions…</strong><span>This may take up to 3 minutes. Keep this window open.</span></div></div>}
      <p className="field-hint">AI can make mistakes. Compare both drafts against the base snapshot, especially names, dates, numbers and qualifications.</p>
    </div><div className="modal-footer"><button type="button" className="button secondary" onClick={close} disabled={busy}>Cancel</button><button type="submit" className="button primary" disabled={busy || !canSubmit}>{busy ? <LoaderCircle className="spin" size={17} /> : <Sparkles size={17} />}{busy ? 'Creating both drafts…' : error ? 'Retry generation' : 'Generate both versions'}</button></div></form>
  </Modal>
}
export function TranslationActions({ dirty, busy, onTranslate }: TranslationActionsProps) {
  const hintId = useId()
  const hint = dirty ? 'Save changes before translating. Only the current saved text is translated.'
    : busy ? 'Wait for the current operation to finish before translating.' : 'Translate the current saved text into a separate editable draft.'
  return <div className="translation-actions">
    <div className="button-row">
      <button type="button" className="button secondary" disabled={dirty || busy} aria-describedby={hintId} onClick={() => onTranslate('zh-Hans')}>Translate to Chinese</button>
      <button type="button" className="button secondary" disabled={dirty || busy} aria-describedby={hintId} onClick={() => onTranslate('en')}>Translate to English</button>
    </div>
    <p id={hintId} className="field-hint">{hint}</p>
  </div>
}
export interface TranslationFormProps {
  source: TranslationSource; initialTargetLanguage: TranslationTargetLanguage; settings: Settings; configured: boolean
  onClose: () => void; onCreated: (version: ResumeVersion) => void
}
export function TranslationForm({ source, initialTargetLanguage, settings, configured, onClose, onCreated }: TranslationFormProps) {
  const [targetLanguage, setTargetLanguage] = useState(initialTargetLanguage)
  const [consent, setConsent] = useState(false), [apiKey, setApiKey] = useState(selectedApiKey(settings))
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const submitting = useRef(false)
  const model = selectedModel(settings)
  const targetName = targetLanguage === 'zh-Hans' ? 'Chinese (Simplified)' : 'English'
  const sourceName = source.sourceType === 'base' ? 'Base resume' : source.documentType === 'cover-letter' ? 'Cover letter' : 'Resume'
  const serverConfigured = settings.provider === 'openai' && configured
  const canSubmit = canProcess(settings, configured, apiKey, consent)
  const close = () => { if (!submitting.current) onClose() }
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (submitting.current || !canSubmit) return
    submitting.current = true; setBusy(true); setError('')
    try {
      const body: TranslationRequest = { sourceType: source.sourceType, sourceId: source.sourceId, targetLanguage, provider: settings.provider, model,
        ...cloudOptions(settings, apiKey, consent) }
      const version = await request<ResumeVersion>('/translations', { method: 'POST', body: JSON.stringify(body) })
      onCreated(version)
    } catch (e) {
      setError(`${errorMessage(e)} Check your AI settings and connection, then choose Retry translation.`)
    } finally { submitting.current = false; setBusy(false) }
  }
  return <Modal title="Translate document" eyebrow="SAVE A SEPARATE TRANSLATION" onClose={close} busy={busy}>
    <form onSubmit={submit}><div className="modal-body translation-form">
      <div className="source-strip"><FileText size={21} /><div><strong>{source.name}</strong><span>{sourceName} · current saved text</span></div></div>
      <label>Target language<select aria-label="Target language" value={targetLanguage} disabled={busy} onChange={event => { setTargetLanguage(event.target.value as TranslationTargetLanguage); setConsent(false); setError('') }}><option value="zh-Hans">Chinese (Simplified)</option><option value="en">English</option></select></label>
      <div className="info-box"><ShieldCheck size={20} /><div><strong>Translate to {targetName}</strong><p>Translates the complete current saved document text and saves a separate editable draft without changing the original. This is a translation, not AI tailoring; no job requirements are analyzed. Review, edit, and export the result as a PDF.</p></div></div>
      <GenerationProvider settings={settings} />
      {!model.trim() && <p className="field-hint">Cancel and select a model in AI settings before translating.</p>}
      {usesCloud(settings) && <>
        <label>{providerNames[settings.provider]} API key <span className="optional">{serverConfigured ? 'server key configured' : 'required for translation'}</span><input type="password" autoComplete="off" maxLength={500} required={!serverConfigured} value={apiKey} onChange={event => { setApiKey(event.target.value); setConsent(false) }} disabled={busy} placeholder={serverConfigured ? 'Using server key unless overridden' : 'Kept in memory for this request'} /></label>
        <p className="field-hint">Keys stay in memory only. {providerNames[settings.provider]} usage may incur provider charges. Consent applies only to this translation.</p>
        <label className="checkbox-label"><input type="checkbox" required checked={consent} onChange={event => setConsent(event.target.checked)} disabled={busy} /><span>I agree to send this document text to {cloudDestination(settings)} for this translation.</span></label>
      </>}
      <InlineError message={error} />
      {busy && <div className="generation-progress" role="status"><LoaderCircle className="spin" size={20} /><div><strong>Translating document…</strong><span>This may take up to 3 minutes. Keep this window open.</span></div></div>}
      <p className="field-hint">AI translations can make mistakes. Check meaning, names, dates, and facts against the translation source before sending.</p>
    </div><div className="modal-footer"><button type="button" className="button secondary" onClick={close} disabled={busy}>Cancel</button><button type="submit" className="button primary" disabled={busy || !canSubmit}>{busy && <LoaderCircle className="spin" size={17} />}{busy ? 'Translating…' : error ? 'Retry translation' : 'Translate document'}</button></div></form>
  </Modal>
}
export function VersionDetail({ version, variants, onSelect, onClose, onSaved, onDeleted, onTranslate }: {
  version: ResumeVersion; variants: ResumeVersion[]; onSelect: (id: string) => void
  onClose: () => void; onSaved: (version: ResumeVersion) => void; onDeleted: (id: string) => void
  onTranslate: (targetLanguage: TranslationTargetLanguage) => void
}) {
  const isCoverLetter = version.documentType === 'cover-letter'
  const documentName = isCoverLetter ? 'cover letter' : 'resume'
  const [draft, setDraft] = useState(version), [tab, setTab] = useState<'resume' | 'job' | 'source' | 'translation'>('resume')
  const [editing, setEditing] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const dirty = draft.text !== version.text || draft.status !== version.status || draft.role !== version.role || draft.company !== version.company
  const close = () => { if (!busy && (!dirty || window.confirm('Discard your unsaved changes?'))) onClose() }
  async function save() {
    setBusy(true); setError('')
    try {
      const updated = await request<ResumeVersion>(`/versions/${version.id}`, { method: 'PATCH', body: JSON.stringify({ text: draft.text, status: draft.status, role: draft.role, company: draft.company }) })
      onSaved(updated); setDraft(updated); setEditing(false)
    } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }
  async function remove() {
    if (!window.confirm(`Delete the ${version.role} ${documentName} for ${version.company}? This cannot be undone.`)) return
    setBusy(true); setError('')
    try { await request(`/versions/${version.id}`, { method: 'DELETE' }); onDeleted(version.id) }
    catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }
  async function download() {
    setBusy(true); setError('')
    try { await downloadPdf(`/versions/${version.id}/pdf`, `${version.company} - ${version.role}${isCoverLetter ? ' - cover-letter' : ''}${version.language ? ` - ${version.language.code}` : ''}.pdf`) }
    catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }
  return <Modal title={version.role} eyebrow={`${version.company} · CREATED ${date(version.createdAt)}`} onClose={close} wide busy={busy}>
    {(version.language || version.translation) && <div className="language-toolbar">{version.language && <span className="language-badge">{version.language.name}</span>}{version.translation && <span className="translation-badge">Translation</span>}{!version.translation && variants.length > 1 ? <label>Language version<select aria-label="Language version" value={version.id} disabled={busy} onChange={event => {
      if (!dirty || window.confirm('Discard your unsaved changes and switch language versions?')) onSelect(event.target.value)
    }}>{variants.map(item => <option key={item.id} value={item.id}>{item.language?.name || 'Original'}</option>)}</select></label> : null}<span>Each language is edited and exported separately.</span></div>}
    <div className="detail-translation-actions"><TranslationActions dirty={dirty} busy={busy} onTranslate={target => { if (!dirty && !busy) onTranslate(target) }} /></div>
    <div className="detail-toolbar"><div className="tabs" role="tablist" aria-label="Version content">{(['resume', 'job', 'source', ...(version.translation ? ['translation' as const] : [])] as const).map(value => <button key={value} role="tab" aria-selected={tab === value} className={tab === value ? 'active' : ''} onClick={() => setTab(value)}>{value === 'resume' ? (isCoverLetter ? 'Cover letter' : 'Resume') : value === 'job' ? 'Job description' : value === 'translation' ? 'Translation source' : 'Base snapshot'}</button>)}</div><label className="status-select">Status<select aria-label="Version status" value={draft.status} disabled={busy} onChange={e => setDraft({ ...draft, status: e.target.value as ResumeVersion['status'] })}><option value="draft">Draft</option><option value="ready">Ready</option><option value="applied">Applied</option></select></label></div>
    <div className="detail-body"><div className="detail-document">
      {tab === 'resume' && <><div className="document-toolbar"><span>{editing ? (isCoverLetter ? 'EDIT YOUR COVER LETTER' : 'EDIT YOUR RESUME') : (isCoverLetter ? 'COVER LETTER PREVIEW' : 'DOCUMENT PREVIEW')}</span><button className="text-button" onClick={() => setEditing(!editing)}>{editing ? `Preview ${documentName}` : `Edit ${documentName}`}</button></div>{editing ? <div className="resume-editor"><div className="form-grid"><label>Job title<input value={draft.role} maxLength={150} disabled={busy} onChange={e => setDraft({ ...draft, role: e.target.value })} /></label><label>Company<input value={draft.company} maxLength={150} disabled={busy} onChange={e => setDraft({ ...draft, company: e.target.value })} /></label></div><label className="sr-only" htmlFor="version-text">{isCoverLetter ? 'Cover letter text' : 'Resume text'}</label><textarea id="version-text" value={draft.text} lang={version.language?.code} dir={textDirection(version.language?.code)} disabled={busy} maxLength={50000} onChange={e => setDraft({ ...draft, text: e.target.value })} /></div> : <ResumePaper text={draft.text} language={version.language?.code} documentType={version.documentType} />}</>}
      {tab === 'job' && <div className="plain-document"><span className="eyebrow">THE OPPORTUNITY</span><h3>{version.role} at {version.company}</h3><p dir="auto">{version.jobDescription || (version.translation?.sourceType === 'base' ? 'No job description; translated from base resume text, not tailored to a job.' : version.translation ? 'No job description; translated from saved document text, not tailored to a job.' : 'No job description saved.')}</p></div>}
      {tab === 'source' && <><p className="snapshot-note"><LockKeyhole size={15} />{version.translation ? 'The original base snapshot retained with this document. See Translation source for the exact text that was translated.' : 'The exact base text used to create this version.'}</p><ResumePaper text={version.baseText} /></>}
      {tab === 'translation' && version.translation && <><p className="snapshot-note"><LockKeyhole size={15} />The exact saved source text at translation time. This snapshot stays unchanged even if the source is edited or deleted.</p><div className="plain-document"><h3>Translation source</h3><p>Source document type: {version.translation.sourceType === 'base' ? 'Base resume' : isCoverLetter ? 'Cover letter' : 'Resume'}</p><pre className="translation-source-text" aria-label="Translation source text" dir="auto">{version.translation.sourceText}</pre></div></>}
    </div><aside className="insights">{version.translation ? <>
      <span className="eyebrow"><FileText size={15} /> TRANSLATION NOTES</span><h3>Translated, not tailored.</h3>
      <p>This document is a translation of the saved source, not AI tailoring. No job requirements were analyzed; this translation does not establish a fit for any role.</p>
      <div className="review-note"><ShieldCheck size={20} /><p>Compare against Translation source. Review meaning, names, dates, and facts before sending, especially after edits.</p></div>
    </> : version.cleanBase ? <>
      <span className="eyebrow"><Sparkles size={15} /> CLEAN BASE RESUME</span><h3>Cleaned, not tailored.</h3><p>{version.summary}</p>
      <div className="review-note"><ShieldCheck size={20} /><p>Each language is independently editable. Compare against Base snapshot for the exact source. The original PDF and extracted text are unchanged.</p></div>
    </> : <><span className="eyebrow"><Sparkles size={15} /> THE TAILORING NOTES</span><h3>Made for this role.</h3><p>{version.summary}</p>
      <div className="insight-section"><h4><CheckCheck size={17} />Highlighted keywords</h4>{version.keywords.length ? <div className="keyword-list">{version.keywords.map((word, i) => <span key={i}>{word}</span>)}</div> : <p>No keywords were identified.</p>}</div>
      <div className="insight-section"><h4><CircleAlert size={17} />Worth reviewing</h4>{version.gaps.length ? <ul>{version.gaps.map((gap, i) => <li key={i}>{gap}</li>)}</ul> : <p>No gaps were reported by the model. Still check every requirement yourself.</p>}</div>
      <div className="review-note"><ShieldCheck size={20} /><p>These notes describe the original AI draft. Check all facts, dates, and skills before sending, especially after edits.</p></div></>}<span className="model-credit">{providerNames[version.provider]} · {version.model}</span>
    </aside></div>
    <div className="detail-error"><InlineError message={error} /></div><div className="modal-footer detail-footer"><button className="button danger-quiet" onClick={remove} disabled={busy}><Trash2 size={16} />{isCoverLetter ? 'Delete cover letter' : 'Delete'}</button><span className="save-state">{dirty ? 'Unsaved changes' : 'Saved on this computer'}</span><button className="button secondary" onClick={save} disabled={!dirty || busy}><Check size={16} />Save changes</button><button className="button primary" onClick={download} disabled={busy || dirty} title={dirty ? 'Save changes before exporting' : (isCoverLetter ? 'Download cover letter as PDF' : 'Download as PDF')}><ArrowDownToLine size={16} />Export PDF</button></div>
  </Modal>
}
export function UploadArea({ compact = false, dragging, uploading, onDrag, onUpload, onBrowse }: {
  compact?: boolean; dragging: boolean; uploading: boolean; onDrag: (value: boolean) => void; onUpload: (file?: File) => Promise<void>; onBrowse: () => void
}) {
  return <div className={`upload-area ${compact ? 'compact' : ''} ${dragging ? 'dragging' : ''}`} onDragOver={e => { e.preventDefault(); onDrag(true) }} onDragLeave={() => onDrag(false)} onDrop={e => { e.preventDefault(); onDrag(false); void onUpload(e.dataTransfer.files[0]) }}>
    <div className="upload-icon">{uploading ? <LoaderCircle className="spin" size={24} /> : <Upload size={24} />}</div><h3>{uploading ? 'Reading your resume…' : 'Drop your base resume here'}</h3><p>{compact ? 'Your experience, in one place.' : 'Upload a text-based PDF. Your original document stays safely on this computer.'}</p><button className="button secondary" onClick={onBrowse} disabled={uploading}><Plus size={15} />Choose PDF</button><span className="file-limit">PDF up to 10 MB · selectable text</span>
  </div>
}