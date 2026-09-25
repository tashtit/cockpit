import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchEndpointModels } from '../src/main/endpoint-models'
import type { ModelEndpoint } from '../src/shared/types'

/*
 * A real HTTP server on an ephemeral port stands in for the user's endpoint: the cap
 * is about what arrives over a socket, so it is tested against one.
 */

let server: Server
let base = ''
let respond: (res: ServerResponse) => void = (res) => res.end()
/** Bytes the server managed to hand the socket before the client hung up. */
let sent = 0
let userData = ''

beforeAll(async () => {
  // config.ts resolves its dir from here when no electron runtime is present
  userData = mkdtempSync(join(tmpdir(), 'cockpit-endpoint-models-'))
  process.env['COCKPIT_USER_DATA'] = userData
  server = createServer((_req, res) => respond(res))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(() => {
  sent = 0
})

afterAll(async () => {
  server.closeAllConnections()
  server.close()
  delete process.env['COCKPIT_USER_DATA']
  rmSync(userData, { recursive: true, force: true })
})

const endpoint = (): ModelEndpoint => ({ id: 'ep-1', label: 'LAN box', type: 'openai', baseUrl: base })

const MB = 1024 * 1024

describe('fetchEndpointModels', () => {
  it('reads a listing of an ordinary size', async () => {
    respond = (res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: [{ id: 'gpt-x' }, { id: 'local-7b' }] }))
    }
    expect(await fetchEndpointModels(endpoint())).toEqual(['gpt-x', 'local-7b'])
  })

  it('stops reading a streamed body once it passes the cap', async () => {
    const chunk = Buffer.alloc(64 * 1024, 0x20) // JSON whitespace, endlessly
    respond = (res) => {
      res.setHeader('content-type', 'application/json')
      res.write('{"data":[')
      const pump = (): void => {
        // up to 64MB, far past the cap: the client has to be the one that stops
        while (sent < 64 * MB && !res.destroyed) {
          sent += chunk.length
          if (!res.write(chunk)) {
            res.once('drain', pump)
            return
          }
        }
        res.end(']}')
      }
      pump()
    }
    await expect(fetchEndpointModels(endpoint())).rejects.toThrow(/sent more than 4 MB for its model list/)
    expect(sent).toBeLessThan(64 * MB)
  })

  it('refuses a body whose declared length is past the cap without reading it', async () => {
    respond = (res) => {
      res.setHeader('content-type', 'application/json')
      res.setHeader('content-length', String(100 * MB))
      res.write('{"data":[')
    }
    await expect(fetchEndpointModels(endpoint())).rejects.toThrow(/sent more than 4 MB for its model list/)
  })
})
