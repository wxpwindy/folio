import type { FeatureState, LoyaltyAuditEvent, LoyaltySettings, LoyaltyState } from './types'

export const SESSION_EXPIRED_EVENT = 'folio:session-expired'
let sessionRequests = new AbortController()
let expectedUserId: string | null = null

// Invalidate pending responses as well as fetches when the authenticated subtree changes.
// The accepted identity stays in this tab's memory, never in shared storage.
export function invalidateSessionRequests(userId: string | null = null) {
  sessionRequests.abort()
  sessionRequests = new AbortController()
  expectedUserId = userId
}
function checkSession(scope: AbortController) {
  if (scope !== sessionRequests) throw new Error('The account session changed. Please try again.')
}
function checkUnauthorized(response: Response, scope: AbortController) {
  checkSession(scope)
  if (response.status === 401) {
    window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT))
    throw new Error('Your session expired. Log in again to continue.')
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const isProtected = path !== '/auth/login' && path !== '/auth/signup'
  const scope = sessionRequests
  const headers = new Headers(init?.headers)
  headers.delete('X-Folio-User')
  if (isProtected && expectedUserId !== null) headers.set('X-Folio-User', expectedUserId)
  if (init?.body instanceof FormData) headers.delete('Content-Type')
  else if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  if (!['GET', 'HEAD', 'OPTIONS'].includes((init?.method || 'GET').toUpperCase())) headers.set('X-Folio-Request', '1')
  let response: Response
  try {
    response = await fetch(`/api${path}`, {
      ...init,
      credentials: 'same-origin',
      signal: init?.signal ? AbortSignal.any([init.signal, scope.signal]) : scope.signal,
      headers,
    })
  } catch { throw new Error('Cannot reach the local server. Make sure the application is running, then try again.') }
  checkSession(scope)
  if (isProtected) checkUnauthorized(response, scope)
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    checkSession(scope)
    if (body.error === 'Change your password before accessing the workspace or administration.') {
      window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT))
    }
    if (path === '/auth/login' && response.status === 401) throw new Error('Invalid credentials. Check your email, phone number or username and password.')
    if (response.status === 504 && !body.error) {
      throw new Error('Generation timed out at the gateway. If using a local model, choose a smaller model or increase the server/provider timeout settings and reverse-proxy timeout.')
    }
    throw new Error(body.error || `Request failed (${response.status}). Please try again.`)
  }
  const result = response.status === 204 ? undefined as T : await response.json() as T
  // Includes pre-auth responses: a late login/session response cannot remount
  // the old account after expiry or another accepted session invalidates it.
  checkSession(scope)
  return result
}
export async function downloadPdf(path: string, filename: string) {
  const scope = sessionRequests
  const headers = new Headers()
  if (expectedUserId !== null) headers.set('X-Folio-User', expectedUserId)
  const response = await fetch(`/api${path}`, { credentials: 'same-origin', signal: scope.signal, headers })
  checkUnauthorized(response, scope)
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    checkSession(scope)
    throw new Error(body.error || 'Could not export the PDF. Please try again.')
  }
  const blob = await response.blob()
  checkSession(scope)
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url; link.download = filename.replace(/[/\\]/g, '-'); link.click()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}
export const date = (value: string) => new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please try again.'
export async function getFeatures(): Promise<FeatureState> {
  return (await request<{ features: FeatureState }>('/features')).features
}
export async function setFeature(key: string, value: boolean): Promise<FeatureState> {
  return (await request<{ features: FeatureState }>('/features', {
    method: 'POST',
    body: JSON.stringify({ key, value: value ? 'true' : 'false' })
  })).features
}
export async function deleteFeature(key: string): Promise<{ deleted: string }> {
  return request(`/features/${encodeURIComponent(key)}`, { method: 'DELETE' })
}
export async function getLoyalty(): Promise<LoyaltyState> {
  return request<LoyaltyState>('/loyalty/me')
}
export async function setLoyaltyEnrollment(enrolled: boolean): Promise<LoyaltyState> {
  return request<LoyaltyState>('/loyalty/me', { method: 'PATCH', body: JSON.stringify({ enrolled }) })
}
export async function getLoyaltySettings(): Promise<LoyaltySettings> {
  return request<LoyaltySettings>('/admin/loyalty/settings')
}
export async function updateLoyaltySettings(settings: LoyaltySettings): Promise<LoyaltySettings> {
  return request<LoyaltySettings>('/admin/loyalty/settings', { method: 'PATCH', body: JSON.stringify(settings) })
}
export async function updateUserLoyalty(userId: string, payload: { tier: 1 | 2 | 3 | 4; enrolled?: boolean }) {
  return request(`/admin/users/${encodeURIComponent(userId)}/loyalty`, { method: 'PATCH', body: JSON.stringify(payload) })
}
export async function getLoyaltyEvents(limit = 25): Promise<LoyaltyAuditEvent[]> {
  return (await request<{ events: LoyaltyAuditEvent[] }>(`/admin/loyalty/events?limit=${encodeURIComponent(String(limit))}`)).events
}