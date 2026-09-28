/**
 * One GET of a small public document — a marketplace catalogue, an MCP Registry page —
 * read without ever holding more than a cap, however much the other end sends, and
 * failing in words a person can act on.
 *
 * `fetch` says "TypeError: fetch failed" for everything from a dropped Wi-Fi to a DNS
 * miss, and `res.text()` buffers whatever arrives. Both reach a person through the
 * views that call these, so this is where that is settled once: a body over the cap is
 * cancelled mid-stream, a missing document (404) is `null` rather than an error, and
 * every failure names who didn't answer and what to do.
 */

export type BoundedFetch = {
  /** Who is being asked, as a person would say it mid-sentence: "GitHub", "the MCP Registry" */
  readonly what: string
  readonly maxBytes: number
  readonly timeoutMs: number
}

function sizeWord(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024)} MB` : `${Math.round(bytes / 1024)} KB`
}

function timedOut(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
}

/** The body as text, or null once it passes `cap` bytes — said up front or streamed. */
export async function readCapped(res: Response, cap: number): Promise<string | null> {
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
  // TextDecoder, as res.json() would: a leading BOM is dropped, not handed to a parser
  return new TextDecoder().decode(Buffer.concat(chunks))
}

/**
 * The document at `url` as text, or null when there is none (404). Throws a sentence
 * for everything else: offline, too slow, another HTTP answer, or more than the cap.
 */
export async function fetchBounded(url: string, opts: BoundedFetch): Promise<string | null> {
  // the same name opening a sentence
  const who = opts.what.charAt(0).toUpperCase() + opts.what.slice(1)
  let res: Response
  try {
    res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(opts.timeoutMs)
    })
  } catch (err) {
    throw new Error(
      timedOut(err)
        ? `${who} didn’t answer in time — try again.`
        : `Couldn’t reach ${opts.what} — check the connection and try again.`
    )
  }
  if (res.status === 404) {
    await res.body?.cancel().catch(() => {})
    return null
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {})
    throw new Error(`${who} answered HTTP ${res.status}.`)
  }
  let body: string | null
  try {
    body = await readCapped(res, opts.maxBytes)
  } catch (err) {
    throw new Error(
      timedOut(err)
        ? `${who} didn’t finish answering in time — try again.`
        : `${who} stopped answering part-way — try again.`
    )
  }
  if (body === null) throw new Error(`${who} sent more than ${sizeWord(opts.maxBytes)} — Cockpit won’t read it.`)
  return body
}
