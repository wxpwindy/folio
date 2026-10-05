import { useRef, useState, useEffect } from 'react'
import type { CSSProperties, FormEvent } from 'react'
import { LoaderCircle, ShieldCheck } from 'lucide-react'
import { errorMessage, getFeatures, request, setFeature } from './api'
import type { AuthSession, AuthUser, Action, ManagedUser, SetupStatus, FeatureState } from './types'
import { Pipeline } from './Pipeline'

  export function Administration({ user, onClose }: { user: AuthUser; onClose: () => void }) {
    const [users, setUsers] = useState<ManagedUser[]>([])
    const [setup, setSetup] = useState<SetupStatus | null>(null)
    const [features, setFeatures] = useState<FeatureState | null>(null)
    const [query, setQuery] = useState('')
    const [error, setError] = useState('')
    const [notice, setNotice] = useState('')
    const [busy, setBusy] = useState(false)
    const [loading, setLoading] = useState(true)
    const [resetId, setResetId] = useState<string | null>(null)
    const [password, setPassword] = useState('')
    const [confirmation, setConfirmation] = useState('')
    const pending = useRef(false)

    async function perform(work: () => Promise<void>) {
      if (pending.current) return
      pending.current = true
      setBusy(true)
      setError('')
      setNotice('')
      try {
        await work()
        await refresh()
      } catch (e) {
        setError(errorMessage(e))
      } finally {
        pending.current = false
        setBusy(false)
        setPassword('')
        setConfirmation('')
      }
    }

    async function handleFeatureToggle(key: string, value: boolean) {
      await perform(async () => {
        setFeatures(await setFeature(key, value))
        setNotice('Feature updated')
      })
    }

    async function action(account: ManagedUser, value: Action) {
      if (pending.current) return
      const actionText = value.replaceAll('-', ' ')
      if (!window.confirm(`${actionText} for ${account.identifier}? Existing sessions will be signed out. Documents are kept.`)) return
      await perform(async () => {
        await request<void>(`/admin/users/${encodeURIComponent(account.id)}/action`, {
          method: 'POST',
          body: JSON.stringify({ action: value, ...(value === 'reset-password' ? { password } : {}) })
        })
        setResetId(null)
        setNotice('Account updated. Existing sessions were revoked; documents were not changed.')
      })
    }

    async function refresh() {
        const [accounts, status, featureState] = await Promise.all([
          request<{ users: ManagedUser[] }>('/admin/users'),
          request<SetupStatus>('/admin/setup'),
          getFeatures()
        ])
        setUsers(accounts.users)
        setSetup(status)
        setFeatures(featureState)
    }

    useEffect(() => {
      let active = true
      void Promise.all([
        request<{ users: ManagedUser[] }>('/admin/users'),
        request<SetupStatus>('/admin/setup'),
        getFeatures()
      ]).then(([accounts, status, featureState]) => {
        if (active) {
          setUsers(accounts.users)
          setSetup(status)
          setFeatures(featureState)
        }
      }).catch(e => {
        if (active) setError(errorMessage(e))
      }).finally(() => {
        if (active) setLoading(false)
      })
      return () => { active = false }
    }, [])

    const showFeatures = features && (user.role === 'admin' || (Object.keys(features || {}).length > 0 && Object.values(features || {}).some(v => v === false)))

    return (
      <main className="admin-shell" aria-busy={busy || loading}>
        <header className="admin-heading">
          <div>
            <span className="eyebrow">LOCAL ADMINISTRATION</span>
            <h1>Manage accounts</h1>
            <p>Access controls, not access to other users' documents.</p>
          </div>
          <button className="button secondary" disabled={busy} onClick={onClose}>
            Back to workspace
          </button>
        </header>
        {error && <p role="alert" className="inline-error">{error}</p>}
        {notice && <p role="status" className="auth-message">{notice}</p>}
        <Pipeline />
        <section className="admin-section" aria-labelledby="setup-title">
          <h2 id="setup-title">First-account setup code</h2>
          <p>{setup?.claimPending ? 'Initialize or rotate the local code before the first email/phone account claims unowned documents. The old code stops working.' : 'First-account claiming is complete, or status is unavailable. It cannot be reopened by an administrator.'}</p>
          <p>The secret is written only to the local account-setup-code file in the configured data directory. It is never displayed or downloaded here. Existing document ownership is unchanged.</p>
          <button className="button secondary" disabled={busy || !setup?.claimPending || !setup.available} onClick={() => {
            if (window.confirm('Initialize a new local setup code? The previous code will stop working. Existing documents will not move.')) {
              perform(async () => {
                await request('/admin/setup/initialize', { method: 'POST' })
                setNotice('Setup code initialized. Open the local setup-code file on this computer; do not share it in chat.')
              })
            }
          }}>{setup?.initialized ? 'Rotate setup code' : 'Initialize setup code'}</button>
        </section>
        <section className="admin-section" aria-labelledby="users-title">
          <div className="admin-heading">
            <h2 id="users-title">Local users</h2>
            <button className="button secondary small" disabled={busy || loading} onClick={() => void perform(async () => {})}>Refresh users</button>
          </div>
          <label className="admin-search">
            Search users{' '}
            <input
              type="search"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Identifier or role"
            />
          </label>
          {loading && <p role="status">Loading accounts…</p>}
          <div className="admin-users">
            {users.filter(account => `${account.identifier} ${account.role}`.toLowerCase().includes(query.toLowerCase())).map(account => (
              <article className="admin-user" key={account.id} aria-label={account.identifier}>
                <h3>{account.identifier}{account.id === user.id && ' (you)'}</h3>
                <p>{account.method} · {account.role} · {account.disabled ? 'Disabled' : 'Enabled'}{account.mustChangePassword && ' · Password change required'}</p>
                <p className="admin-id">ID: {account.id}</p>
                {account.id !== user.id ? (
                  <fieldset disabled={busy}>
                    <legend className="sr-only">Manage {account.identifier}</legend>
                    <div className="admin-actions">
                      <button className="button secondary small" onClick={() => action(account, account.disabled ? 'enable' : 'disable')}>
                        {account.disabled ? 'Enable account' : 'Disable account'}
                      </button>
                      <button className="button secondary small" onClick={() => action(account, 'revoke-sessions')}>
                        Revoke sessions
                      </button>
                      <button className="button secondary small" onClick={() => action(account, account.role === 'admin' ? 'demote' : 'promote')}>
                        {account.role === 'admin' ? 'Remove admin role' : 'Make administrator'}
                      </button>
                      <button className="button secondary small" onClick={() => {
                        setResetId(account.id)
                        setPassword('')
                        setConfirmation('')
                        setError('')
                      }}>
                        Reset password
                      </button>
                    </div>
                    {resetId === account.id && (
                      <form className="admin-reset" onSubmit={async e => {
                        e.preventDefault()
                        if (password !== confirmation) {
                          setError('Passwords do not match.')
                          return
                        }
                        await action(account, 'reset-password')
                      }}>
                        <p>Give the temporary password to this user securely. They must replace it on login. Password reset grants potential access to their account; do this only with authorization.</p>
                        <label>
                          Temporary password{' '}
                          <input
                            type="password"
                            autoComplete="new-password"
                            required
                            minLength={12}
                            maxLength={128}
                            value={password}
                            onChange={e => setPassword(e.target.value)}
                          />
                        </label>
                        <label>
                          Confirm temporary password{' '}
                          <input
                            type="password"
                            autoComplete="new-password"
                            required
                            minLength={12}
                            maxLength={128}
                            value={confirmation}
                            onChange={e => setConfirmation(e.target.value)}
                          />
                        </label>
                        <div className="admin-actions">
                          <button className="button primary small" type="submit">
                            Set temporary password
                          </button>
                          <button className="text-button" type="button" onClick={() => {
                            setResetId(null)
                            setPassword('')
                            setConfirmation('')
                            setError('')
                          }}>
                            Cancel reset
                          </button>
                        </div>
                      </form>
                    )}
                  </fieldset>
                ) : (
                  <p>Manage your own password from the workspace. Self-demotion and self-disable are blocked.</p>
                )}
              </article>
            ))}
          </div>
        </section>
        {showFeatures && (
          <section className="admin-section" aria-labelledby="features-title">
            <div className="admin-heading">
              <h2 id="features-title">Feature switches</h2>
              <button className="button secondary small" disabled={busy || loading} onClick={() => void perform(async () => {})}>
                Refresh features
              </button>
            </div>
            <div className="admin-features">
              {Object.entries(features || {}).map(([key, value]) => {
                const labels: Record<string, string> = { webChat: 'Web Chat' }
                return (
                  <div className="feature-toggle" key={key} style={{
                    '--toggle-bg': value ? '#638b45' : '#77836c'
                  } as CSSProperties & { '--toggle-bg': string }}>
                    <span id={`feature-${key}-label`} className="toggle-label">{labels[key] || key}</span>
                    <span className="toggle-status">{value ? 'On' : 'Off'}</span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={value}
                      aria-labelledby={`feature-${key}-label`}
                      disabled={busy || loading}
                      className="toggle-switch"
                      onClick={() => {
                        if (window.confirm('Turn ' + (value ? 'off' : 'on') + ' ' + labels[key] + '?')) {
                          handleFeatureToggle(key, !value)
                        }
                      }}
                    />
                  </div>
                )
              })}
            </div>
          </section>
        )}
      </main>
    )
  }

export function PasswordChange({ required = false, onChanged, onLogout, onCancel }: {
  required?: boolean
  onChanged: (session: AuthSession) => void
  onLogout: () => Promise<void>
  onCancel?: () => void
}) {
  const [current, setCurrent] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const active = useRef(true)
  const errorRef = useRef<HTMLParagraphElement>(null)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  useEffect(() => { if (error) errorRef.current?.focus() }, [error])

  async function perform(work: () => Promise<void>) {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError('')
    try { await work() }
    catch (e) { if (active.current) setError(errorMessage(e)) }
    finally {
      pending.current = false
      if (active.current) {
        setBusy(false)
        setCurrent('')
        setPassword('')
        setConfirm('')
      }
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending.current) return
    setError('')
    if (!current || current.length > 128) { setError('Enter your current password (up to 128 characters).'); return }
    if (password.length < 12 || password.length > 128) { setError('Use a password between 12 and 128 characters.'); return }
    if (password !== confirm) { setError('Passwords do not match.'); return }
    if (password === current) { setError('Choose a different new password.'); return }
    await perform(async () => {
      const session = await request<AuthSession>('/auth/change-password', {
        method: 'POST', body: JSON.stringify({ currentPassword: current, newPassword: password })
      })
      if (!session.user || session.user.mustChangePassword) throw new Error('The server did not confirm the password change. Please sign in again.')
      if (active.current) onChanged(session)
    })
  }

  return <main className="auth-shell">
    <section className="auth-card" aria-labelledby="password-heading" aria-busy={busy}>
      <ShieldCheck size={28} aria-hidden="true" />
      <h1 id="password-heading">Change password</h1>
      <p className="auth-intro">{required ? 'Replace your temporary password before continuing.' : 'Choose a new password for your local account.'} Other sessions will be signed out.</p>
      <form className="auth-form" onSubmit={submit}>
        <label htmlFor="current-password">Current password
          <input id="current-password" type="password" autoComplete="current-password" required maxLength={128} disabled={busy} value={current} onChange={e => setCurrent(e.target.value)} />
        </label>
        <label htmlFor="new-password">New password
          <input id="new-password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} disabled={busy} value={password} onChange={e => setPassword(e.target.value)} aria-describedby="password-hint" />
        </label>
        <p id="password-hint" className="field-hint">Use 12–128 characters, different from your current password.</p>
        <label htmlFor="confirm-password">Confirm new password
          <input id="confirm-password" type="password" autoComplete="new-password" required minLength={12} maxLength={128} disabled={busy} value={confirm} onChange={e => setConfirm(e.target.value)} />
        </label>
        {error && <p ref={errorRef} tabIndex={-1} role="alert" className="inline-error">{error}</p>}
        <button className="button primary full-width" type="submit" disabled={busy}>{busy && <LoaderCircle size={16} className="spin" aria-hidden="true" />}Save new password</button>
        {!required && onCancel && <button className="button secondary full-width" type="button" disabled={busy} onClick={onCancel}>Cancel</button>}
        <button className="text-button" type="button" disabled={busy} onClick={() => void perform(onLogout)}>Sign out</button>
      </form>
    </section>
  </main>
}

export { Administration as default }

