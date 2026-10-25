import { AppError } from './ai.ts'

export async function ollamaModels(): Promise<{ models: string[] }> {
  try {
    const url = new URL(process.env.OLLAMA_URL || 'http://127.0.0.1:11434')
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol)) {
      throw new AppError(400, 'OLLAMA_URL must point to a local loopback address.')
    }
    const response = await fetch(new URL('/api/tags', url), { redirect: 'error', signal: AbortSignal.timeout(5000) })
    if (!response.ok) throw new Error('Model list unavailable')
    const data = await response.json() as { models?: { name?: unknown }[] }
    if (!Array.isArray(data.models)) throw new Error('Invalid model list')
    return { models: data.models.map(model => model.name).filter((name): name is string => typeof name === 'string' && name.length > 0 && name.length <= 100) }
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError(502, 'Cannot reach Ollama. Open the Ollama app or run ollama serve locally, then check the connection again.')
  }
}