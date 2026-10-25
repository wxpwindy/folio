export type AuthMethod = 'email' | 'phone' | 'username'
export interface AuthUser {
  id: string; identifier: string; method: AuthMethod; createdAt: string
  role: 'user' | 'admin'; mustChangePassword: boolean
}
export interface ManagedUser extends AuthUser {
  disabled: boolean
  membershipEnrolled: boolean
  membershipTier: 1 | 2 | 3 | 4
  membershipPoints: number
}
export interface SetupStatus { claimPending: boolean; initialized: boolean; available: boolean }
export interface AuthSession {
  user: AuthUser | null; setupRequired: boolean
}
export interface LoginRequest {
  method: AuthMethod; identifier: string; password: string
}
export interface SignupRequest extends LoginRequest { setupCode?: string }

export type DocumentType = 'resume' | 'cover-letter'
export type AiProvider = 'ollama' | 'openai' | 'lmstudio'

export type TranslationTargetLanguage = 'zh-Hans' | 'en'
export interface TranslationSnapshot {
  readonly sourceType: 'base' | 'version'
  readonly sourceId: string
  readonly sourceText: string
}
export type FeatureKey = 'webChat'
export interface AuthUser {
  id: string
  role: 'admin' | 'user'
}
export interface FeatureState {
  [key: string]: boolean
}
export type Action = 'enable' | 'disable' | 'revoke-sessions' | 'promote' | 'demote' | 'reset-password'

// Display-only source identity; the server reads the current saved text by ID.
export interface TranslationSource {
  sourceType: 'base' | 'version'; sourceId: string; name: string; documentType: DocumentType
}
export interface TranslationRequest {
  sourceType: 'base' | 'version'; sourceId: string; targetLanguage: TranslationTargetLanguage
  provider: AiProvider; model: string; apiKey?: string; cloudConsent?: boolean
}

export interface BaseResume {
  id: string; filename: string; text: string; pages: number; createdAt: string
}
export interface ResumeVersion {
  id: string; baseId: string; baseText: string; role: string; company: string; jobDescription: string
  documentType?: DocumentType
  text: string; summary: string; keywords: string[]; gaps: string[]
  provider: AiProvider; model: string; status: 'draft' | 'ready' | 'applied'
  createdAt: string; updatedAt: string
  language?: { code: string; name: string }; generationId?: string
  readonly cleanBase?: boolean
  readonly translation?: TranslationSnapshot
}
export interface GenerationResponse extends ResumeVersion { additionalVersions?: ResumeVersion[] }
export interface Workspace {
  base: BaseResume | null; versions: ResumeVersion[]
  config: { openaiConfigured: boolean; ollamaModel: string; openaiModel: string; lmstudioModel: string; defaultProvider: 'ollama' | 'lmstudio' }
}
export interface LoyaltySettings {
  basePoints: number
  factors: { 1: number; 2: number; 3: number; 4: number }
}
export interface LoyaltyProfile {
  enrolled: boolean
  tier: 1 | 2 | 3 | 4
  points: number
}
export interface LoyaltyState {
  profile: LoyaltyProfile
  settings: LoyaltySettings
}
export interface LoyaltyAuditEvent {
  id: number
  eventType: 'settings_updated' | 'user_membership_updated'
  createdAt: string
  actorIdentifier: string
  targetIdentifier: string | null
  payload: {
    basePoints?: number
    factors?: { 1: number; 2: number; 3: number; 4: number }
    tier?: 1 | 2 | 3 | 4
    enrolled?: boolean
  }
}
export interface Settings {
  provider: AiProvider; ollamaModel: string; openaiModel: string; lmstudioModel: string; apiKey: string
  lmstudioDefaultModel?: string
}

export interface ChatMessage { role: 'user' | 'assistant'; content: string }
export interface ChatSource { title: string; url: string; snippet: string }
export interface ChatAnswer { content: string; model: string; sources: ChatSource[]; searchQuery: string | null }
export interface ChatModels { models: string[]; searchProvider: 'DuckDuckGo' | 'Brave' }
export interface ChatRequest {
  model: string; messages: ChatMessage[]; webSearch: boolean; searchConsent: boolean
  searchProvider?: 'DuckDuckGo' | 'Bing' | 'Brave'
}