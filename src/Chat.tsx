import { useEffect, useRef, useState } from 'react'
import { ExternalLink, Globe, LoaderCircle, MessageCircle, Plus, RefreshCw, Send, ShieldCheck, Square } from 'lucide-react'
import { errorMessage, request } from './api'
import { InlineError } from './components'
import type { ChatAnswer, ChatMessage, ChatModels, ChatRequest } from './types'
import './Chat.css'

type Turn = ChatMessage & Partial<Omit<ChatAnswer, 'content'>>
export function Chat({ onActivity }: { onActivity: (active: boolean) => void }) {
  const [models, setModels] = useState<string[]>([])
  const [model, setModel] = useState('')
  const [provider, setProvider] = useState<NonNullable<ChatRequest['searchProvider']>>('DuckDuckGo')
  const [braveConfigured, setBraveConfigured] = useState(false)
  const [loadingModels, setLoadingModels] = useState(true)
  const [attempt, setAttempt] = useState(0)
  const [messages, setMessages] = useState<Turn[]>([])
  const [draft, setDraft] = useState('')
  const [webSearch, setWebSearch] = useState(false)
  const [consent, setConsent] = useState(false)
  const [pending, setPending] = useState('')
  const [error, setError] = useState('')
  const [modelError, setModelError] = useState('')
  const [notice, setNotice] = useState('')
  const activeRequest = useRef<AbortController | null>(null)
  const end = useRef<HTMLDivElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const controller = new AbortController()
    void request<ChatModels>('/chat/models', { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return
      setModels(result.models); setModel(old => result.models.includes(old) ? old : result.models[0] || '')
      setProvider(result.searchProvider)
      setBraveConfigured(result.searchProvider === 'Brave'); setConsent(false)
      setModelError(result.models.length ? '' : 'No models found. Download and load a chat model in LM Studio, then refresh.')
    }).catch(e => { if (!controller.signal.aborted) setModelError(errorMessage(e)) })
      .finally(() => { if (!controller.signal.aborted) setLoadingModels(false) })
    return () => controller.abort()
  }, [attempt])
  useEffect(() => () => { activeRequest.current?.abort() }, [])
  const hasContent = !!(messages.length || draft || pending)
  useEffect(() => { onActivity(hasContent); return () => onActivity(false) }, [hasContent, onActivity])
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => { if (hasContent) event.preventDefault() }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [hasContent])
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }, [messages, pending])

  function stop() {
    activeRequest.current?.abort(); activeRequest.current = null
    setPending(''); setNotice('Stopped. Your unsent message is still available to edit or retry.')
  }
  function clear() {
    if (hasContent && !window.confirm('Clear this conversation and draft? Chat is not saved.')) return
    activeRequest.current?.abort(); activeRequest.current = null
    setMessages([]); setDraft(''); setPending(''); setError(''); setNotice(''); setWebSearch(false); setConsent(false)
    composer.current?.focus()
  }
  async function send() {
    if (activeRequest.current || !draft.trim() || !model || loadingModels || modelError || (webSearch && !consent)) return
    const controller = new AbortController()
    activeRequest.current = controller
    const question = draft.trim()
    // Send only the last five complete turns, never source metadata or resume data.
    const input: ChatRequest = { model, messages: [...messages.slice(-10).map(({ role, content }) => ({ role, content })), { role: 'user', content: question }],
      webSearch, searchConsent: consent,
      searchProvider: webSearch ? provider : undefined }
    setPending(question); setError(''); setNotice(''); setConsent(false)
    try {
      const answer = await request<ChatAnswer>('/chat', { method: 'POST', body: JSON.stringify(input), signal: controller.signal })
      if (controller.signal.aborted) return
      setMessages(old => [...old, { role: 'user', content: question }, { role: 'assistant', ...answer }])
      setDraft(''); setWebSearch(false)
    } catch (e) { if (!controller.signal.aborted) setError(errorMessage(e)) }
    finally {
      if (activeRequest.current === controller) { activeRequest.current = null; setPending(''); composer.current?.focus() }
    }
  }
  return <section className="chat-page" aria-label="Local web chat">
    <div className="page-heading"><div><span className="eyebrow">LOCAL INTELLIGENCE. A WIDER VIEW.</span><h1>A little room to think.</h1><p>Chat with your local model. Bring in the web only when you choose.</p></div>
      <button className="button secondary" onClick={clear}><Plus size={17} />New chat</button></div>
    <div className="chat-layout">
      <aside className="chat-settings" aria-label="Chat settings">
        <span className="chat-local-label"><ShieldCheck size={17} />LM STUDIO · LOCAL</span>
        <h2>Your thinking partner</h2><p>The model runs on this computer at <strong>127.0.0.1:1234</strong>.</p>
        <label htmlFor="chat-model">Chat model</label><select id="chat-model" value={model} onChange={e => { setModel(e.target.value); setConsent(false) }} disabled={!!pending || loadingModels || !models.length}>
          {!models.length && <option value="">{loadingModels ? 'Connecting…' : 'No models available'}</option>}
          {models.map(id => <option key={id} value={id}>{id}</option>)}
        </select>
        <button className="button secondary full-width" disabled={!!pending || loadingModels} onClick={() => { setLoadingModels(true); setModelError(''); setAttempt(value => value + 1) }}><RefreshCw size={15} />Refresh models</button>
        {loadingModels && <p role="status">Connecting to LM Studio…</p>}
        {modelError && <InlineError message={modelError} />}
        <div className="chat-setup"><h3>First time here?</h3><ol><li>Open LM Studio and load a downloaded chat model.</li><li>In Developer, start the local server on port 1234.</li><li>Refresh models here and choose your model.</li></ol></div>
        <p className="chat-privacy">Temporary by design: chat is not saved and clears when you leave this page, reload, or sign out. The last five turns are sent as context. Your resumes are never attached automatically.</p>
      </aside>
      <div className="chat-panel">
        <div className="chat-panel-heading"><span><MessageCircle size={18} />Your conversation</span><span className="pill">{webSearch ? 'Web search enabled' : 'Local only'}</span></div>
        <div className="chat-transcript" role="log" aria-label="Chat messages" aria-live="polite" aria-relevant="additions text">
          {!messages.length && !pending && <div className="chat-empty"><div className="chat-empty-icon"><MessageCircle size={30} /></div><h2>What’s on your mind?</h2><p>Explore an idea, prepare for an interview, or research something new.</p><div className="chat-prompts">{['Help me prepare for a technical interview.', 'Explain a complex topic in simple terms.'].map(prompt => <button key={prompt} onClick={() => { setDraft(prompt); setConsent(false); composer.current?.focus() }}>{prompt}</button>)}</div></div>}
          {messages.map((message, index) => <article className={`chat-message ${message.role}`} key={index} aria-label={message.role === 'user' ? 'Your message' : 'Assistant answer'}>
            <div className="chat-message-label">{message.role === 'user' ? 'You' : 'LM Studio'}{message.model && <span>{message.model}</span>}</div>
            <div className="chat-message-content" dir="auto">{message.content}</div>
            {message.searchQuery !== undefined && message.searchQuery !== null && <div className="chat-sources"><h3><Globe size={14} />Sources for this answer</h3><p>Searched: {message.searchQuery}</p>
              <p>Query generated by LM Studio · Top {message.sources?.length || 0} usable results</p>
              {!message.sources?.length && <p>No search results found. This answer is not web-verified.</p>}
              {!!message.sources?.length && message.sources.length < 3 && <p>Fewer than three usable results were available. Check the limited evidence carefully.</p>}
              <ol>{message.sources?.map(source => <li key={source.url}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}<ExternalLink size={12} /></a><p>{source.snippet}</p></li>)}</ol></div>}
          </article>)}
          {pending && <><article className="chat-message user" aria-label="Your pending message"><div className="chat-message-label">You</div><div className="chat-message-content" dir="auto">{pending}</div></article><div className="chat-thinking" role="status"><LoaderCircle size={17} className="spin" />{webSearch ? 'Extracting search terms, searching, and combining the top 3 results…' : 'Your local model is thinking…'}</div></>}
          <div ref={end} />
        </div>
        <form className="chat-composer" onSubmit={e => { e.preventDefault(); void send() }}>
          {error && <InlineError message={error} />}{notice && <p role="status">{notice}</p>}
          <label className="chat-search-toggle"><input type="checkbox" checked={webSearch} disabled={!!pending} onChange={e => { setWebSearch(e.target.checked); setConsent(false) }} /><Globe size={16} />Search the internet for this answer</label>
          {webSearch && <div className="chat-search-fields"><label htmlFor="chat-search-provider">Search provider</label><select id="chat-search-provider" value={provider} disabled={!!pending || loadingModels} onChange={e => { setProvider(e.target.value as typeof provider); setConsent(false) }}><option>DuckDuckGo</option><option>Bing</option>{braveConfigured && <option>Brave</option>}</select><p>Bing uses its regional RSS endpoint. Choose another provider if your network blocks the default.</p>
            <p><strong>Automatic search:</strong> LM Studio extracts keywords or a focused question from your message and recent context, searches the internet, then combines the top 3 usable result snippets into one cited answer.</p>
            <label className="chat-search-toggle"><input type="checkbox" checked={consent} disabled={!!pending} onChange={e => setConsent(e.target.checked)} />I allow automatically generated search terms from this conversation to be sent to {provider} for this answer.</label><p>Only the generated query is sent to the search provider, not the conversation directly. Generated terms can still reveal details from your messages—omit sensitive information. The query and sources appear with the answer. Source pages are not automatically opened.</p></div>}
          <label htmlFor="chat-draft">Your message</label><textarea id="chat-draft" ref={composer} value={draft} maxLength={4000} rows={3} disabled={!!pending} onChange={e => { setDraft(e.target.value); setConsent(false) }} placeholder="Ask anything…" onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send() } }} />
          <div className="chat-compose-actions"><span>Enter to send · Shift + Enter for a new line</span>{pending ? <button type="button" className="button secondary" onClick={stop}><Square size={15} />Stop</button> : <button type="submit" className="button primary" disabled={!draft.trim() || !model || loadingModels || !!modelError || (webSearch && !consent)}><Send size={16} />Send message</button>}</div>
          <p className="chat-disclaimer">AI can make mistakes. Check important claims and source links. No cloud model fallback.</p>
        </form>
      </div>
    </div>
  </section>
}