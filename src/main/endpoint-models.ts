import type { ModelEndpoint } from '../shared/types'
import { isBlockedEndpointHost, modelsRequest, parseModelsResponse } from '../shared/endpoints'
import { updateModelEndpoint } from './config'

/**
 * The largest model listing read. A real one is tens of KB even for a gateway
 * serving hundreds of models; the endpoint is the user's own, possibly on the LAN,
 * and nothing else bounds what it may stream into main's memory within the timeout.
 */
const MAX_LISTING_BYTES = 4 * 1024 * 1024

/** The body as text, or null once it passes `cap` bytes — said up front or streamed. */
async function readCapped(res: Response, cap: number): Promise<string | null> {
  if (Number(res.headers.get('content-length')) > cap) {
    await res.body?.cancel().catch(() => {})
    return null
  }
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > cap) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  // TextDecoder, as res.json() would: a leading BOM is dropped, not handed to JSON.parse
  return new TextDecoder().decode(Buffer.concat(chunks))
}

/**
 * Ask a BYOK endpoint which models it serves and cache the answer on the stored
 * endpoint so the new-session form has suggestions even when the provider is down.
 */
export async function fetchEndpointModels(ep: ModelEndpoint, apiKey?: string): Promise<string[]> {
  const req = modelsRequest(ep, apiKey)
  if (!req) return ep.models ?? []
  // re-check at request time, not just when the endpoint was defined: an endpoint
  // stored before this guard existed would otherwise still be fetched
  if (isBlockedEndpointHost(new URL(req.url).hostname)) {
    throw new Error(`${ep.label} points at a link-local address — refusing to fetch from it.`)
  }
  let res: Response
  try {
    // don't follow redirects: the host check above only ever sees the first hop,
    // so an allowed host could bounce us onto a link-local one — and following
    // would carry the API key to wherever it pointed
    res = await fetch(req.url, {
      headers: req.headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(8000)
    })
  } catch (err) {
    const why = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'unreachable'
    throw new Error(`Could not reach ${req.url} (${why}).`)
  }
  if (res.status >= 300 && res.status < 400) {
    throw new Error(
      `${req.url} redirected to ${res.headers.get('location') ?? 'elsewhere'} — set the base URL to that address instead.`
    )
  }
  if (!res.ok) {
    throw new Error(`${req.url} answered ${res.status}${res.status === 401 || res.status === 403 ? ' — check the API key' : ''}.`)
  }
  let body: string | null
  try {
    body = await readCapped(res, MAX_LISTING_BYTES)
  } catch {
    throw new Error(`${req.url} did not return a model list.`)
  }
  if (body === null) {
    const mb = MAX_LISTING_BYTES / 1024 / 1024
    throw new Error(`${req.url} sent more than ${mb} MB for its model list — refusing to read it.`)
  }
  let models: string[]
  try {
    models = parseModelsResponse(JSON.parse(body))
  } catch {
    throw new Error(`${req.url} did not return a model list.`)
  }
  if (models.length > 0 && JSON.stringify(models) !== JSON.stringify(ep.models ?? [])) {
    // update, never upsert: the user may have removed the endpoint while this
    // fetch was in flight, and the write-back must not resurrect it
    updateModelEndpoint({ ...ep, models })
  }
  return models
}
