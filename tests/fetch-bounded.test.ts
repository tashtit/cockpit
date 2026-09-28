import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fetchBounded } from '../src/main/fetch-bounded'

/*
 * One GET of a small public document, against a real server on a loopback port: what
 * a person reads when the other end is missing, slow, gone, or sends too much.
 */

let server: Server
let base = ''
/** a port nothing listens on — taken, then let go */
let closed = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    switch (req.url) {
      case '/ok':
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"a":1}')
        return
      case '/missing':
        res.writeHead(404)
        res.end('not found')
        return
      case '/broken':
        res.writeHead(502)
        res.end('bad gateway')
        return
      case '/said-too-big':
        res.writeHead(200, { 'content-length': String(4096) })
        res.end('x'.repeat(4096))
        return
      case '/streams-forever': {
        // no length said up front: the cap has to be kept while it streams
        res.writeHead(200)
        const chunk = 'x'.repeat(1024)
        const timer = setInterval(() => res.write(chunk), 1)
        res.on('close', () => clearInterval(timer))
        return
      }
      case '/never':
        // holds the request open and answers nothing
        return
      default:
        res.writeHead(500)
        res.end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  closed = `http://127.0.0.1:${(probe.address() as AddressInfo).port}`
  await new Promise<void>((resolve) => probe.close(() => resolve()))
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const opts = { what: 'the registry', maxBytes: 2048, timeoutMs: 1000 }

describe('reading a small document off the network', () => {
  it('hands back the body as text', async () => {
    expect(await fetchBounded(`${base}/ok`, opts)).toBe('{"a":1}')
  })

  it('says there is nothing there, rather than failing, for a 404', async () => {
    expect(await fetchBounded(`${base}/missing`, opts)).toBeNull()
  })

  it('names who answered what, for any other failure', async () => {
    await expect(fetchBounded(`${base}/broken`, opts)).rejects.toThrow('The registry answered HTTP 502.')
  })

  it('refuses a body past the cap, whether it says so up front or streams it', async () => {
    await expect(fetchBounded(`${base}/said-too-big`, opts)).rejects.toThrow(
      'The registry sent more than 2 KB — Cockpit won’t read it.'
    )
    await expect(fetchBounded(`${base}/streams-forever`, opts)).rejects.toThrow(/sent more than 2 KB/)
  })

  it('says it was too slow, not that fetch failed', async () => {
    await expect(fetchBounded(`${base}/never`, { ...opts, timeoutMs: 150 })).rejects.toThrow(
      'The registry didn’t answer in time — try again.'
    )
  })

  it('says it could not be reached when nothing is listening', async () => {
    await expect(fetchBounded(`${closed}/ok`, opts)).rejects.toThrow(
      'Couldn’t reach the registry — check the connection and try again.'
    )
  })
})
