import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CredentialGateway,
  MAX_REQUEST_BODY_BYTES,
} from '../packages/connector-hub/src/host/gateway'
import { MemorySecretStore } from '../packages/connector-hub/src/host/secrets'

const cleanups = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe('CredentialGateway', () => {
  it('binds to loopback and enforces route, key, method and connector boundaries', async () => {
    const fixture = await startFixture('none')
    const endpoint = fixture.gateway.endpoint('test')
    expect(new URL(endpoint.url).hostname).toBe('127.0.0.1')
    expect(Number(new URL(endpoint.url).port)).toBeGreaterThan(0)

    expect((await fetch(endpoint.url)).status).toBe(403)
    expect((await fetch(endpoint.url, { headers: { 'X-Connector-Hub-Key': 'wrong' } })).status).toBe(403)
    expect((await fetch(new URL('/unknown', endpoint.url), { headers: endpoint.headers })).status).toBe(404)
    expect((await fetch(endpoint.url, { method: 'PUT', headers: endpoint.headers })).status).toBe(405)
    expect((await fetch(fixture.gateway.endpoint('other').url, { headers: endpoint.headers })).status).toBe(404)
  })

  it('injects OAuth credentials and forwards only the MCP request header allowlist', async () => {
    const fixture = await startFixture('oauth')
    const endpoint = fixture.gateway.endpoint('test')
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        ...endpoint.headers,
        authorization: 'Bearer client-forgery',
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-session-id': 'session-1',
        'mcp-protocol-version': '2025-06-18',
        'last-event-id': 'event-1',
        'x-unwanted': 'do-not-forward',
      },
      body: '{"jsonrpc":"2.0"}',
    })
    expect(response.status).toBe(200)
    const request = fixture.requests[0]
    expect(request.headers.authorization).toBe('Bearer oauth-access')
    expect(request.headers['x-connector-hub-key']).toBeUndefined()
    expect(request.headers['x-unwanted']).toBeUndefined()
    expect(request.headers.accept).toBe('application/json, text/event-stream')
    expect(request.headers['mcp-session-id']).toBe('session-1')
    expect(request.headers['mcp-protocol-version']).toBe('2025-06-18')
    expect(request.headers['last-event-id']).toBe('event-1')
    expect(request.body).toBe('{"jsonrpc":"2.0"}')
  })

  it.each(['header', 'query', 'none'])('applies %s authentication without leaking client credentials', async mode => {
    const fixture = await startFixture(mode)
    const endpoint = fixture.gateway.endpoint('test')
    await fetch(endpoint.url, {
      method: 'POST',
      headers: { ...endpoint.headers, authorization: 'Bearer forged' },
      body: '{}',
    })
    const request = fixture.requests[0]
    if (mode === 'header') expect(request.headers.ak).toBe('api-secret')
    else expect(request.headers.ak).toBeUndefined()
    const url = new URL(request.url, 'http://upstream.local')
    expect(url.searchParams.get('org')).toBe('1')
    expect(url.searchParams.get('key')).toBe(mode === 'query' ? 'api-secret' : null)
    if (mode === 'none') expect(request.headers.authorization).toBeUndefined()
  })

  it('streams SSE responses in chunks instead of buffering the complete response', async () => {
    const fixture = await startFixture('none')
    const endpoint = fixture.gateway.endpoint('test')
    const response = await fetch(endpoint.url, { headers: endpoint.headers })
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const first = await reader.read()
    expect(decoder.decode(first.value)).toContain('first-event')
    const second = await reader.read()
    expect(decoder.decode(second.value)).toContain('second-event')
    expect((await reader.read()).done).toBe(true)
  })

  it('forwards DELETE and filters hop-by-hop response headers', async () => {
    const fixture = await startFixture('none')
    const endpoint = fixture.gateway.endpoint('test')
    expect((await fetch(endpoint.url, { method: 'DELETE', headers: endpoint.headers })).status).toBe(204)
    expect(fixture.requests[0].method).toBe('DELETE')

    const response = await fetch(endpoint.url, {
      method: 'POST', headers: endpoint.headers, body: '{}',
    })
    expect(response.headers.get('x-upstream')).toBe('present')
    expect(response.headers.get('x-hop')).toBeNull()
    // Node may generate a new Keep-Alive header for this hop; nominated upstream headers must not survive.
    expect(response.headers.get('connection') ?? '').not.toContain('x-hop')
  })

  it('preserves upstream error status and body', async () => {
    const fixture = await startFixture('none')
    const endpoint = fixture.gateway.endpoint('test')
    const response = await fetch(endpoint.url, {
      method: 'POST', headers: endpoint.headers, body: 'rate-limit',
    })
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('10')
    expect(await response.text()).toBe('upstream busy')
  })

  it('rejects bodies over 4 MiB before forwarding them upstream', async () => {
    const fixture = await startFixture('none')
    const endpoint = fixture.gateway.endpoint('test')
    const response = await fetch(endpoint.url, {
      method: 'POST', headers: endpoint.headers, body: Buffer.alloc(MAX_REQUEST_BODY_BYTES + 1, 'a'),
    })
    expect(response.status).toBe(413)
    expect(fixture.requests).toHaveLength(0)
    expect(await response.text()).toContain('4 MiB')
  })

  it('returns safe errors for missing credentials and sanitized upstream failures', async () => {
    const missing = await startFixture('oauth')
    await missing.secrets.delete('test')
    const missingEndpoint = missing.gateway.endpoint('test')
    expect((await fetch(missingEndpoint.url, { headers: missingEndpoint.headers })).status).toBe(401)

    const failure = await startFixture('query', {
      fetchImpl: async () => {
        throw new Error('fetch https://example.com/mcp?key=url-secret failed with Bearer bearer-secret')
      },
    })
    const endpoint = failure.gateway.endpoint('test')
    const response = await fetch(endpoint.url, { method: 'POST', headers: endpoint.headers, body: '{}' })
    expect(response.status).toBe(502)
    const body = await response.text()
    expect(body).toContain('key=REDACTED')
    expect(body).toContain('Bearer REDACTED')
    expect(body).not.toContain('url-secret')
    expect(body).not.toContain('bearer-secret')
  })

  it('aborts the upstream response when the gateway client disconnects', async () => {
    let upstreamClosed = false
    const fixture = await startFixture('none', {
      upstreamHandler: async (request, response) => {
        if (request.method !== 'GET') throw new Error('Expected GET')
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write('data: started\n\n')
        response.on('close', () => { upstreamClosed = true })
        // Deliberately keep this response open until the gateway aborts it.
        await new Promise(resolve => response.on('close', resolve))
      },
    })
    const endpoint = fixture.gateway.endpoint('test')
    const controller = new AbortController()
    const response = await fetch(endpoint.url, { headers: endpoint.headers, signal: controller.signal })
    const reader = response.body.getReader()
    await reader.read()
    controller.abort()
    await expect(reader.read()).rejects.toThrow()
    await waitFor(() => upstreamClosed, 'upstream disconnect')
  })

  it('delegates non-loopback upstreams to the DSH fetch and proxy boundary', async () => {
    const proxyRequests = []
    const proxy = createServer((request, response) => {
      proxyRequests.push({ method: request.method, url: request.url })
      const target = new URL(request.url)
      const headers = { ...request.headers, host: target.host }
      delete headers.connection
      delete headers['proxy-connection']
      const forwarded = httpRequest(target, { method: request.method, headers }, upstreamResponse => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
        upstreamResponse.pipe(response)
      })
      forwarded.on('error', () => {
        if (!response.headersSent) response.writeHead(502)
        response.end()
      })
      request.pipe(forwarded)
    })
    await listen(proxy)
    cleanups.push(() => closeServer(proxy))

    // M0 verified DSH's real dispatcher. This test verifies the gateway hands the
    // complete non-loopback request to that fetch boundary without bypassing it.
    const proxyUrl = `http://127.0.0.1:${proxy.address().port}`
    const fixture = await startFixture('query', {
      nonLoopbackUpstream: true,
      fetchImpl: (input, init) => fetchViaProxy(proxyUrl, input, init),
    })
    const endpoint = fixture.gateway.endpoint('test')
    const response = await fetch(endpoint.url, {
      method: 'POST', headers: endpoint.headers, body: '{}',
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('{}')
    expect(proxyRequests).toHaveLength(1)
    expect(proxyRequests[0].method).toBe('POST')
    expect(new URL(proxyRequests[0].url).hostname).not.toBe('127.0.0.1')
    expect(fixture.requests).toHaveLength(1)
  })
})

async function startFixture(mode, options = {}) {
  const requests = []
  const upstream = createServer(async (request, response) => {
    const record = { method: request.method, url: request.url, headers: request.headers, body: '' }
    requests.push(record)
    try {
      if (options.upstreamHandler) await options.upstreamHandler(request, response)
      else await defaultUpstreamHandler(request, response, record)
    } catch {
      if (!response.headersSent) response.writeHead(500)
      response.end()
    }
  })
  await listen(upstream, options.nonLoopbackUpstream ? '0.0.0.0' : '127.0.0.1')
  cleanups.push(() => closeServer(upstream))
  const upstreamHost = options.nonLoopbackUpstream ? localIpv4() : '127.0.0.1'
  const remoteUrl = `http://${upstreamHost}:${upstream.address().port}/mcp?org=1`
  const connector = {
    catalogRevision: '2026-11-03.1',
    remote: { type: 'streamable-http', url: remoteUrl },
    auth: authConfig(mode),
    enabled: true,
    addedAt: '2026-11-03T08:00:00.000Z',
  }
  const secrets = new MemorySecretStore()
  if (mode === 'oauth') {
    await secrets.write('test', {
      v: 1,
      tokens: { access_token: 'oauth-access', refresh_token: 'oauth-refresh', expires_at: Date.now() + 60_000 },
    })
  } else if (mode === 'header' || mode === 'query') {
    await secrets.write('test', { v: 1, apiKey: 'api-secret' })
  }
  const gateway = await CredentialGateway.start({
    getConnector: id => id === 'test' ? connector : undefined,
    secrets,
    fetchImpl: options.fetchImpl,
  })
  cleanups.push(() => gateway.close())
  return { gateway, secrets, requests, remoteUrl }
}

function authConfig(mode) {
  if (mode === 'none') return { type: 'none' }
  if (mode === 'oauth') {
    return {
      type: 'oauth', scope: '', clientMetadataUrl: 'https://example.com/client.json',
      callbackPath: '/oauth/callback/test', portPolicy: 'random',
    }
  }
  return {
    type: 'api-key', in: mode, name: mode === 'query' ? 'key' : 'ak',
    label: { zh: 'Key', en: 'Key' }, helpUrl: 'https://example.com/key',
  }
}

async function defaultUpstreamHandler(request, response, record) {
  if (request.method === 'GET') {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: first-event\n\n')
    await delay(40)
    response.write('data: second-event\n\n')
    response.end()
    return
  }
  for await (const chunk of request) record.body += chunk.toString()
  if (request.method === 'DELETE') {
    response.writeHead(204)
    response.end()
    return
  }
  if (record.body === 'rate-limit') {
    response.writeHead(429, { 'retry-after': '10' })
    response.end('upstream busy')
    return
  }
  response.writeHead(200, {
    'content-type': 'application/json',
    'x-upstream': 'present',
    connection: 'keep-alive, x-hop',
    'keep-alive': 'timeout=5',
    'x-hop': 'remove-me',
  })
  response.end('{}')
}

async function listen(server, host = '127.0.0.1') {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, host, resolve)
  })
}

async function closeServer(server) {
  if (!server.listening) return
  const closed = new Promise(resolve => server.close(resolve))
  server.closeAllConnections()
  await closed
}

function localIpv4() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  throw new Error('No non-loopback IPv4 interface available')
}

async function waitFor(predicate, description) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return
    await delay(20)
  }
  throw new Error(`Timed out waiting for ${description}`)
}

async function fetchViaProxy(proxyUrl, input, init) {
  const target = new URL(input)
  const headers = Object.fromEntries(new Headers(init.headers))
  headers.host = target.host
  const body = init.body ? Buffer.from(init.body) : undefined
  if (body) headers['content-length'] = String(body.length)
  return new Promise((resolve, reject) => {
    const request = httpRequest(proxyUrl, {
      method: init.method,
      path: target.href,
      headers,
    }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), {
        status: response.statusCode ?? 502,
        headers: response.headers,
      })))
    })
    request.on('error', reject)
    request.end(body)
  })
}
