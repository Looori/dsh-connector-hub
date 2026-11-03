import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
])
const FORWARD_REQUEST_HEADERS = [
  'accept', 'content-type', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id',
]

export interface M0Gateway {
  url: string
  headers: Record<string, string>
  close(): void
}

/**
 * M0-only credential gateway spike. Enabled explicitly with M0_GATEWAY_UPSTREAM;
 * normal PoC runs retain the original direct connection.
 */
export function createM0Gateway(): M0Gateway | null {
  const upstream = process.env.M0_GATEWAY_UPSTREAM
  if (!upstream) return null
  const port = Number(process.env.M0_GATEWAY_PORT ?? 3989)
  const key = process.env.M0_GATEWAY_KEY ?? randomUUID()
  const path = '/c/pocdemo/mcp'

  const server = createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (requestUrl.pathname !== path) {
        res.writeHead(404).end()
        return
      }
      if (req.headers['x-connector-hub-key'] !== key) {
        res.writeHead(403).end()
        return
      }
      const headers = new Headers()
      for (const name of FORWARD_REQUEST_HEADERS) {
        const value = req.headers[name]
        if (typeof value === 'string') headers.set(name, value)
      }
      const method = req.method ?? 'GET'
      const hasBody = method !== 'GET' && method !== 'HEAD'
      const response = await fetch(upstream, {
        method,
        headers,
        body: hasBody ? Readable.toWeb(req) as ReadableStream : undefined,
        // Node/undici requires this for a streaming request body.
        duplex: 'half',
      } as RequestInit)
      const responseHeaders: Record<string, string> = {}
      response.headers.forEach((value, name) => {
        if (!HOP_BY_HOP.has(name)) responseHeaders[name] = value
      })
      res.writeHead(response.status, responseHeaders)
      if (response.body === null) res.end()
      else Readable.fromWeb(response.body).pipe(res)
    } catch (error) {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: String(error) }))
    }
  })
  server.listen(port, '127.0.0.1')
  return {
    url: `http://127.0.0.1:${port}${path}`,
    headers: { 'X-Connector-Hub-Key': key },
    close: () => { server.close() },
  }
}
