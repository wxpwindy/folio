const defaultLmStudioUrl = 'http://127.0.0.1:1234/v1'
const configuredLmStudioUrl = process.env.LMSTUDIO_URL?.trim()

const modelAliases = new Map<string, string>([
  ['google/gemma-4-e4b', 'gemma3:4b'],
])

// Default to loopback, but allow an explicit server-side override for hosted OpenAI-compatible endpoints.
export const lmStudioUrl = configuredLmStudioUrl && /^https?:\/\//i.test(configuredLmStudioUrl) ? configuredLmStudioUrl.replace(/\/+$/, '') : defaultLmStudioUrl
export function lmStudioHeaders() {
  return { 'Content-Type': 'application/json', ...(process.env.LMSTUDIO_API_KEY ? { Authorization: `Bearer ${process.env.LMSTUDIO_API_KEY}` } : {}) }
}

export function lmStudioResolveModel(model: string): string {
  const trimmed = model.trim()
  return modelAliases.get(trimmed.toLowerCase()) || trimmed
}

export function lmStudioDisplayModels(models: string[]): string[] {
  const normalized = [...new Set(models.map(model => model.trim()).filter(Boolean))]
  const includesGemmaTarget = normalized.some(model => model.toLowerCase() === 'gemma3:4b')
  const includesGemmaAlias = normalized.some(model => model.toLowerCase() === 'google/gemma-4-e4b')
  if (includesGemmaTarget && !includesGemmaAlias) normalized.unshift('google/gemma-4-e4b')
  return normalized
}

// Some LM Studio runtimes cannot compile a string pattern combined with length
// limits (notably Gemma E4B). Omit grammar-level patterns only; each document
// service still validates the original full Zod schema before saving anything.
export function lmStudioOutputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  function simplify(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(simplify)
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'pattern').map(([key, item]) => [key, simplify(item)]))
    }
    return value
  }
  return simplify(schema) as Record<string, unknown>
}