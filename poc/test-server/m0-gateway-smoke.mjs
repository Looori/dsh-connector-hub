import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

const root = new URL('../', import.meta.url).pathname
const dsh = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
const servers = []
const children = []
const proxyRequests = []
let webLog = ''

function assert(value, message) {
  if (!value) throw new Error(message)
}

async function listen(server, host = '127.0.0.1') {
  servers.push(server)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, resolve)
  })
  return server.address().port
}

async function closeServer(server) {
  server.closeAllConnections?.()
  await new Promise(resolve => server.close(resolve))
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  try { process.kill(-child.pid, 'SIGTERM') } catch { return }
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(3000)])
}

async function waitFor(predicate, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await delay(100)
  }
  throw new Error(`Timed out waiting for ${description}`)
}

async function api(origin, cookie, path, method = 'GET') {
  const response = await fetch(`${origin}${path}`, { method, headers: { cookie } })
  const text = await response.text()
  let body
  try { body = JSON.parse(text) } catch { body = text }
  return { status: response.status, body }
}

function localIpv4() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  throw new Error('No non-loopback IPv4 address available for proxy test')
}

function buildMcpServer() {
  const server = new McpServer({ name: 'm0-gateway-upstream', version: '0.0.0' })
  server.registerTool('echo', {
    description: 'Return text unchanged.',
    inputSchema: { text: z.string() },
  }, async ({ text }) => ({ content: [{ type: 'text', text }] }))
  return server
}

function createUpstream() {
  const sessions = new Map()
  return createServer(async (req, res) => {
    try {
      if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/mcp') {
        res.writeHead(404).end()
        return
      }
      const sessionId = req.headers['mcp-session-id']
      let transport = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined
      if (!transport && req.method === 'POST' && !sessionId) {
        const mcp = buildMcpServer()
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: id => { sessions.set(id, transport) },
        })
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId)
          void mcp.close()
        }
        await mcp.connect(transport)
      }
      if (!transport) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({
          jsonrpc: '2.0', error: { code: -32000, message: 'Missing or unknown session' }, id: null,
        }))
        return
      }
      await transport.handleRequest(req, res)
    } catch (error) {
      if (!res.headersSent) res.writeHead(500).end(String(error))
      else res.end()
    }
  })
}

function createProxy() {
  return createServer((req, res) => {
    const record = {
      method: req.method,
      url: req.url,
      sessionId: req.headers['mcp-session-id'] ?? null,
      responseType: null,
    }
    proxyRequests.push(record)
    let target
    try { target = new URL(req.url) } catch {
      res.writeHead(400).end('Absolute-form request URL required')
      return
    }
    const headers = { ...req.headers, host: target.host }
    delete headers['proxy-connection']
    delete headers.connection
    const request = httpRequest(target, { method: req.method, headers }, response => {
      record.responseType = response.headers['content-type'] ?? null
      res.writeHead(response.statusCode ?? 502, response.headers)
      response.pipe(res)
    })
    request.on('error', error => {
      if (!res.headersSent) res.writeHead(502)
      res.end(String(error))
    })
    req.pipe(request)
  })
}

// Kept as a function so the proxy handler above remains easy to compare with
// the gateway's global-fetch path.
import { request as httpRequest } from 'node:http'
function awaitImportHttpRequest() { return httpRequest }

try {
  const upstream = createUpstream()
  const upstreamPort = await listen(upstream, '0.0.0.0')
  const upstreamUrl = `http://${localIpv4()}:${upstreamPort}/mcp`

  const proxy = createProxy()
  const proxyPort = await listen(proxy)
  const proxyUrl = `http://127.0.0.1:${proxyPort}`

  const reservation = createServer()
  const gatewayPort = await listen(reservation)
  const gatewayKey = randomUUID()
  servers.pop()
  await closeServer(reservation)

  const child = spawn(dsh, ['web', '--port', '0', '--no-open'], {
    cwd: root,
    detached: true,
    env: {
      ...process.env,
      NO_COLOR: '1',
      HTTP_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      HTTPS_PROXY: '',
      https_proxy: '',
      NO_PROXY: '',
      no_proxy: '',
      M0_GATEWAY_UPSTREAM: upstreamUrl,
      M0_GATEWAY_PORT: String(gatewayPort),
      M0_GATEWAY_KEY: gatewayKey,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  child.stdout.on('data', chunk => { webLog += chunk.toString() })
  child.stderr.on('data', chunk => { webLog += chunk.toString() })

  const tokenUrl = await waitFor(() => webLog.match(/http:\/\/(?:127\.0\.0\.1|localhost):\d+\/\?token=[^\s]+/)?.[0], 'web URL')
  const login = await fetch(tokenUrl, { redirect: 'manual' })
  const cookie = login.headers.get('set-cookie')?.split(';', 1)[0]
  assert(cookie, `Login failed with HTTP ${login.status}`)
  const origin = new URL(tokenUrl).origin

  const initial = await waitFor(async () => {
    const result = await api(origin, cookie, '/api/connector-hub/mcp-status')
    return result.body.status === 'connected' ? result : null
  }, 'MCP connection through gateway')
  assert(initial.body.tools.global.includes('mcp__pocdemo__echo'), 'Tool missing through gateway')

  const forbidden = await fetch(`http://127.0.0.1:${gatewayPort}/c/pocdemo/mcp`)
  const missing = await fetch(`http://127.0.0.1:${gatewayPort}/not-a-connector`)
  assert(forbidden.status === 403, `Gateway without key returned ${forbidden.status}`)
  assert(missing.status === 404, `Unknown gateway path returned ${missing.status}`)

  await waitFor(() => proxyRequests.some(item => item.method === 'GET' && item.responseType?.includes('text/event-stream')), 'proxied SSE stream')
  const remount = await api(origin, cookie, '/api/connector-hub/mcp-remount', 'POST')
  assert(remount.status === 200 && remount.body.sameNames === true, 'Remount failed through gateway')

  // rc.5's mcp-client does not issue DELETE on dispose. Exercise the gateway's
  // DELETE forwarding explicitly with the current MCP session.
  const sessionId = proxyRequests.findLast(item => item.sessionId)?.sessionId
  assert(sessionId, 'No MCP session observed')
  const deleted = await fetch(`http://127.0.0.1:${gatewayPort}/c/pocdemo/mcp`, {
    method: 'DELETE',
    headers: { 'X-Connector-Hub-Key': gatewayKey, 'Mcp-Session-Id': sessionId },
  })
  assert(deleted.ok, `Gateway DELETE returned ${deleted.status}`)
  await waitFor(() => proxyRequests.some(item => item.method === 'DELETE'), 'proxied DELETE')

  const methods = [...new Set(proxyRequests.map(item => item.method))].sort()
  assert(methods.includes('POST') && methods.includes('GET') && methods.includes('DELETE'), `Missing methods: ${methods}`)
  console.log(JSON.stringify({
    ok: true,
    dsh: '0.2.1-rc.5',
    upstreamUsesNonLoopback: true,
    gateway: { unauthenticated: forbidden.status, unknownPath: missing.status },
    mcp: {
      status: initial.body.status,
      tools: initial.body.tools.global,
      remountSameNames: remount.body.sameNames,
      afterDispose: remount.body.afterDispose,
    },
    proxy: {
      observed: true,
      methods,
      sseResponses: proxyRequests.filter(item => item.responseType?.includes('text/event-stream')).length,
      requests: proxyRequests.map(item => ({
        method: item.method,
        path: new URL(item.url).pathname,
        responseType: item.responseType,
      })),
    },
  }, null, 2))
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: String(error),
    proxyRequests,
    webLog: webLog.replace(/([?&]token=)[^\s&]+/g, '$1<redacted>'),
  }, null, 2))
  process.exitCode = 1
} finally {
  for (const child of children.reverse()) await stop(child)
  for (const server of servers.reverse()) await closeServer(server)
}
