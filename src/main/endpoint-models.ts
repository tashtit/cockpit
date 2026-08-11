import type { ModelEndpoint } from '../shared/types'
import { modelsRequest, parseModelsResponse } from '../shared/endpoints'
import { addModelEndpoint } from './config'

/**
 * Ask a BYOK endpoint which models it serves and cache the answer on the stored
 * endpoint so the new-session form has suggestions even when the provider is down.
 */
export async function fetchEndpointModels(ep: ModelEndpoint, apiKey?: string): Promise<string[]> {
  const req = modelsRequest(ep, apiKey)
  if (!req) return ep.models ?? []
  let res: Response
  try {
    res = await fetch(req.url, { headers: req.headers, signal: AbortSignal.timeout(8000) })
  } catch (err) {
    const why = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'unreachable'
    throw new Error(`Could not reach ${req.url} (${why}).`)
  }
  if (!res.ok) {
    throw new Error(`${req.url} answered ${res.status}${res.status === 401 || res.status === 403 ? ' — check the API key' : ''}.`)
  }
  let models: string[]
  try {
    models = parseModelsResponse(await res.json())
  } catch {
    throw new Error(`${req.url} did not return a model list.`)
  }
  if (models.length > 0 && JSON.stringify(models) !== JSON.stringify(ep.models ?? [])) {
    addModelEndpoint({ ...ep, models })
  }
  return models
}
