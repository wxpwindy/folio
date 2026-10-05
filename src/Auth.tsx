import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { flushSync } from 'react-dom'
import { Layers3, LoaderCircle, ShieldCheck } from 'lucide-react'
import { isValidPhoneNumber } from 'libphonenumber-js'
import App from './App'
import { PasswordChange } from './Admin'
import { errorMessage, invalidateSessionRequests, request, SESSION_EXPIRED_EVENT } from './api'
import type { AuthMethod, AuthSession, SignupRequest } from './types'

export function AuthGate() {
  const [session, setSession] = useState<AuthSession | null>(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [attempt, setAttempt] = useState(0)
  const revision = useRef(0)

  useEffect(() => {
    const expire = () => {
      revision.current++
      invalidateSessionRequests()
      // Remove even an open native document dialog before handling any more responses.
      flushSync(() => {
        setSession({ user: null, setupRequired: false })
        setError('')
        setMessage('Your session expired. Log in again to continue. Unsaved changes were not saved.')
      })
    }
    window.addEventListener(SESSION_EXPIRED_EVENT, expire)
    return () => {
      window.removeEventListener(SESSION_EXPIRED_EVENT, expire)
      invalidateSessionRequests()
    }
  }, [])

  useEffect(() => {
    let active = true
    const current = revision.current
    const controller = new AbortController()
    void request<AuthSession>('/auth/session', { signal: controller.signal, cache: 'no-store' }).then(value => {
      if (active && current === revision.current) {
        invalidateSessionRequests(value.user?.id ?? null)
        setSession(value)
      }
    }).catch(e => { if (active && current === revision.current) setError(errorMessage(e)) })
    return () => { active = false; controller.abort() }
  }, [attempt])

  function authenticated(value: AuthSession) {
    revision.current++
    invalidateSessionRequests(value.user?.id ?? null)
    setMessage(''); setSession(value)
  }
  async function logout() {
    const current = revision.current
    await request<void>('/auth/logout', { method: 'POST' })
    if (current !== revision.current) return
    revision.current++
    invalidateSessionRequests()
    // A bootstrap admin can sign out while first ordinary-account setup is
    // still pending. Refresh its public status instead of assuming completion.
    setMessage('You have signed out.'); setSession(null); setAttempt(value => value + 1)
  }

  if (session?.user?.mustChangePassword) return <PasswordChange onChanged={authenticated} onLogout={logout} required />
  if (session?.user) return <App key={session.user.id} user={session.user} onLogout={logout} onAuthenticated={authenticated} />
  return <main className="auth-shell">
    <section className="auth-card" aria-labelledby="auth-heading">
      <div className="brand"><span className="brand-icon"><Layers3 size={24} /></span>folio<span className="brand-dot">.</span></div>
      {session === null ? <>
        <h1 id="auth-heading">Your private workspace</h1>
        {error ? <><p className="inline-error" role="alert">{error}</p><button className="button primary full-width" onClick={() => { setError(''); setAttempt(value => value + 1) }}>Retry connection</button></> : <div className="auth-loading" role="status"><LoaderCircle className="spin" size={24} /><p>Checking your session…</p><div className="auth-skeleton" aria-hidden="true" /><div className="auth-skeleton" aria-hidden="true" /></div>}
      </> : <AuthForm key={session.setupRequired ? 'setup' : 'account'} setupRequired={session.setupRequired} message={message} onAuthenticated={authenticated} />}
    </section>
  </main>
}

function AuthForm({ setupRequired, message, onAuthenticated }: { setupRequired: boolean; message: string; onAuthenticated: (session: AuthSession) => void }) {
  const [signup, setSignup] = useState(setupRequired)
  const [method, setMethod] = useState<AuthMethod>('email')
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [setupCode, setSetupCode] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const pending = useRef(false)
  const active = useRef(true)
  const errorRef = useRef<HTMLParagraphElement>(null)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  useEffect(() => { if (error) errorRef.current?.focus() }, [error])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending.current) return
    setError('')
    const normalized = identifier.trim()
    if (method === 'phone' && (!normalized.startsWith('+') || !isValidPhoneNumber(normalized))) {
      setError('Enter a valid international mobile phone number, including + and the country code.'); return
    }
    if (password.length < (!signup && method === 'username' ? 10 : 12) || password.length > 128) { setError('Use a password between 12 and 128 characters (initial username passwords may use 10).'); return }
    if (signup && password !== confirmation) { setError('Passwords do not match.'); return }
    if (signup && setupRequired && !setupCode.trim()) { setError('Enter the local setup code to claim the existing documents.'); return }
    pending.current = true; setSubmitting(true)
    try {
      const body: SignupRequest = { method, identifier: normalized, password }
      if (signup && setupRequired) body.setupCode = setupCode.trim()
      const value = await request<AuthSession>(signup ? '/auth/signup' : '/auth/login', { method: 'POST', body: JSON.stringify(body) })
      if (!value.user) throw new Error('The server did not return an account. Please try again.')
      if (active.current) onAuthenticated(value)
    } catch (e) { if (active.current) setError(errorMessage(e)) }
    finally {
      pending.current = false
      if (active.current) { setSubmitting(false); setPassword(''); setConfirmation('') }
    }
  }

  return <>
    <span className="eyebrow">PERSONAL & LOCAL</span>
    <h1 id="auth-heading">{signup ? 'Create your account' : 'Welcome back'}</h1>
    <p className="auth-intro">{signup ? 'A private place for your next chapter.' : 'Log in to your private resume workspace.'}</p>
    {message && <p className="auth-message" role="status">{message}</p>}
    {signup && <div className="auth-setup-note">{setupRequired ? <><strong>First account setup</strong><p>The first account claims the existing resumes and documents once. Later accounts start with empty, private workspaces. Enter the setup code from the local data/account-setup-code file (or account-setup-code in your custom DATA_DIR). The code is never supplied by this page.</p></> : <p>New accounts start with an empty, private workspace. Existing documents belong to the account that claimed them during first setup.</p>}</div>}
    <form onSubmit={event => void submit(event)} aria-busy={submitting}>
      <fieldset disabled={submitting}>
        <legend className="sr-only">{signup ? 'Sign up' : 'Log in'}</legend>
        <label htmlFor="auth-method">Sign-in method<select id="auth-method" value={method} onChange={event => { setMethod(event.target.value as AuthMethod); setIdentifier(''); setError('') }}><option value="email">Email</option><option value="phone">Phone</option>{!signup && <option value="username">Username</option>}</select></label>
        <label htmlFor="auth-identifier">{method === 'email' ? 'Email address' : method === 'phone' ? 'Mobile phone' : 'Username'}<input key={method} id="auth-identifier" name="username" type={method === 'email' ? 'email' : method === 'phone' ? 'tel' : 'text'} inputMode={method === 'email' ? 'email' : method === 'phone' ? 'tel' : 'text'} autoComplete="username" autoCapitalize="none" spellCheck={false} required maxLength={method === 'email' ? 254 : 64} value={identifier} onChange={event => setIdentifier(event.target.value)} aria-describedby={method === 'phone' ? 'auth-phone-hint' : undefined} /></label>
        {method === 'phone' && <p className="auth-field-hint" id="auth-phone-hint">Use international format with + and your country code, for example +14155552671.</p>}
        <label htmlFor="auth-password">Password<input id="auth-password" name="password" type="password" autoComplete={signup ? 'new-password' : 'current-password'} required minLength={!signup && method === 'username' ? 10 : 12} maxLength={128} value={password} onChange={event => setPassword(event.target.value)} aria-describedby="auth-password-hint" /></label>
        <p className="auth-field-hint" id="auth-password-hint">12–128 characters. Spaces are preserved.{!signup && method === 'username' && ' Initial administrator passwords may use 10 characters and must be changed.'}</p>
        {signup && <label htmlFor="auth-confirmation">Confirm password<input id="auth-confirmation" name="confirmPassword" type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>}
        {signup && setupRequired && <label htmlFor="auth-setup-code">Setup code<input id="auth-setup-code" name="setupCode" type="password" autoComplete="off" autoCapitalize="none" spellCheck={false} required maxLength={256} value={setupCode} onChange={event => setSetupCode(event.target.value)} /></label>}
        {error && <p className="inline-error" role="alert" tabIndex={-1} ref={errorRef}>{error}</p>}
        <button className="button primary full-width" type="submit">{submitting && <LoaderCircle className="spin" size={16} aria-hidden="true" />}{signup ? 'Sign up' : 'Log in'}</button>
        <button className="text-button auth-switch" type="button" onClick={() => { setSignup(value => !value); setMethod('email'); setIdentifier(''); setPassword(''); setConfirmation(''); setSetupCode(''); setError('') }}>{signup ? 'Already have an account? Log in' : 'Create an account'}</button>
      </fieldset>
    </form>
    <div className="auth-privacy"><ShieldCheck size={19} aria-hidden="true" /><p>Accounts and documents are stored locally on this computer, with a private workspace per account. Email addresses and phone numbers are unverified identifiers: no email or SMS is sent, and there is no self-service password recovery. A local administrator can reset a password. Keep yours safe. You choose where AI runs; cloud AI requires your consent.</p></div>
  </>
}