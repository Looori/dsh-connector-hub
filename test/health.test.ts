import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { CredentialGateway } from '../packages/connector-hub/src/host/gateway'
import { probeApiKeyConnector, probeConnector } from '../packages/connector-hub/src/host/health'
import { MemorySecretStore } from '../packages/connector-hub/src/host/secrets'

const cleanups = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe('probeConnector', () => {
  it.each(['header', 'query'])('runs initialize and tools/list through the gateway with %s API Key auth', async mode => {
    const fixture = await startFixture(mode)
    const result = await probeConnector('test-map', fixture.gateway.endpoint('test-map'), {
      now: () => new Date('2026-11-03T09:10:00.000Z'),
    })

    expect(result).toMatchObject({
      ok: true,
      checkedAt: '2026-11-03T09:10:00.000Z',
      tools: ['mcp__test-map__echo', 'mcp__test-map__maps_geo'],
      server: { name: 'fixture-mcp', version: '1.2.3' },
      error: null,
    })
    expect(fixture.methods).toEqual(['initialize', 'tools/list'])
  })

  it('returns an upstream credential failure without mutating the stored Key', async () => {
    const fixture = await startFixture('header')
    await fixture.secrets.write('test-map', { v: 1, apiKey: 'wrong-secret' })

    const result = await probeConnector('test-map', fixture.gateway.endpoint('test-map'))
    expect(result.ok).toBe(false)
    expect(result.tools).toEqual([])
    expect(result.error).toContain('Invalid API Key')
    expect(result.error).not.toContain('wrong-secret')
    expect(await fixture.secrets.read('test-map')).toEqual({ v: 1, apiKey: 'wrong-secret' })
  })

  it('probes a candidate Key on an isolated gateway without changing the live secret store', async () => {
    const fixture = await startFixture('header')
    const result = await probeApiKeyConnector('test-map', fixture.connector, 'candidate-secret')

    // The fixture accepts only its live Key, proving the candidate used a separate gateway and store.
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Invalid API Key')
    expect(await fixture.secrets.read('test-map')).toEqual({ v: 1, apiKey: 'api-secret' })
  })

  it('bounds a stalled probe and returns a safe timeout summary', async () => {
    const fixture = await startFixture('none', { stall: true })
    const result = await probeConnector('test-map', fixture.gateway.endpoint('test-map'), { timeoutMs: 30 })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('MCP probe timed out after 30 ms')
    expect(result.durationMs).toBeLessThan(1000)
  })
})

async function startFixture(mode, options = {}) {
  const methods = []
  const upstream = createServer(async (request, response) => {
    try {
      if (request.method === 'DELETE') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{}')
        return
      }
      const body = await readJson(request)
      if (body.id === undefined) {
        response.writeHead(202)
        response.end()
        return
      }
      methods.push(body.method)

      const url = new URL(request.url, 'http://upstream.local')
      const credential = mode === 'header' ? request.headers.ak : mode === 'query' ? url.searchParams.get('key') : null
      if (mode !== 'none' && credential !== 'api-secret') {
        response.writeHead(401, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32001, message: 'Invalid API Key' } }))
        return
      }
      if (options.stall) await delay(200)

      response.writeHead(200, { 'content-type': 'application/json' })
      if (body.method === 'initialize') {
        response.end(JSON.stringify({
          jsonrpc: '2.0', id: body.id,
          result: {
            protocolVersion: body.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'fixture-mcp', version: '1.2.3' },
          },
        }))
      } else if (body.method === 'tools/list') {
        response.end(JSON.stringify({
          jsonrpc: '2.0', id: body.id,
          result: { tools: [
            { name: 'maps_geo', inputSchema: { type: 'object' } },
            { name: 'echo', inputSchema: { type: 'object' } },
          ] },
        }))
      } else {
        response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Unknown method' } }))
      }
    } catch (error) {
      if (!response.headersSent) response.writeHead(500)
      response.end(String(error))
    }
  })
  await listen(upstream)
  cleanups.push(() => closeServer(upstream))

  const secrets = new MemorySecretStore()
  if (mode !== 'none') await secrets.write('test-map', { v: 1, apiKey: 'api-secret' })
  const connector = {
    catalogRevision: '2026-11-03.1',
    remote: { type: 'streamable-http', url: `http://127.0.0.1:${upstream.address().port}/mcp` },
    auth: mode === 'none' ? { type: 'none' } : {
      type: 'api-key', in: mode, name: mode === 'query' ? 'key' : 'ak',
      label: { zh: 'Key', en: 'Key' }, helpUrl: 'https://example.com/key',
    },
    enabled: true,
    addedAt: '2026-11-03T08:00:00.000Z',
  }
  const gateway = await CredentialGateway.start({
    getConnector: id => id === 'test-map' ? connector : undefined,
    secrets,
  })
  cleanups.push(() => gateway.close())
  return { gateway, secrets, methods, connector }
}

async function readJson(request) {
  let text = ''
  for await (const chunk of request) text += chunk.toString()
  return JSON.parse(text)
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
}

async function closeServer(server) {
  if (!server.listening) return
  const closed = new Promise(resolve => server.close(resolve))
  server.closeAllConnections()
  await closed
}
