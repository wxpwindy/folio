// Fixed loopback endpoint: resume data and optional credentials never go to a remote host.
export const lmStudioUrl = 'http://127.0.0.1:1234/v1'
export function lmStudioHeaders() {
  return { 'Content-Type': 'application/json', ...(process.env.LMSTUDIO_API_KEY ? { Authorization: `Bearer ${process.env.LMSTUDIO_API_KEY}` } : {}) }
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