import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import { afterEach, expect, it } from 'vitest'
import { CredentialGateway } from '../packages/connector-hub/src/host/gateway'
import { MemorySecretStore } from '../packages/connector-hub/src/host/secrets'

const { Client, StreamableHTTPClientTransport } = createRequire(
  new URL('../packages/connector-hub/package.json', import.meta.url),
)('@modelcontextprotocol/client')
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

it('forwards Youzan SSE progress with a progressToken and stable work IDs', { timeout: 30_000 }, async () => {
  const observed: Array<{ method: string, contentType: string | null }> = []
  const queryCalls: Array<Record<string, unknown>> = []
  const progressTokens: unknown[] = []
  const upstream = createServer(async (request, response) => {
    if (request.headers.authorization !== 'Bearer test-youzan-token') {
      response.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"Invalid token"}')
      return
    }
    if (request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`event: message\ndata: ${JSON.stringify({
        jsonrpc: '2.0', method: 'notifications/message',
        params: { level: 'info', data: 'stream-ready' },
      })}\n\n`)
      return
    }
    const message = await readJson(request)
    if (message.id === undefined) {
      response.writeHead(202).end()
      return
    }
    if (message.method === 'initialize') {
      respondJson(response, {
        jsonrpc: '2.0', id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion ?? '2025-03-26',
          capabilities: { tools: { listChanged: true }, logging: {} },
          serverInfo: { name: 'youzan-fixture', version: '1.0.0' },
        },
      })
      return
    }
    if (message.method === 'tools/list') {
      respondJson(response, {
        jsonrpc: '2.0', id: message.id,
        result: { tools: [skillQueryTool(), youzanQueryTool()] },
      })
      return
    }
    if (message.method === 'tools/call' && message.params?.name === 'skill_query') {
      respondJson(response, {
        jsonrpc: '2.0', id: message.id,
        result: {
          structuredContent: {
            skill: 'youzan-shop', description: '店铺基础信息查询',
            capabilities: [{ name: '店铺信息', description: '查询当前店铺基础信息', examples: [], inputs: [], outputs: [] }],
          },
          content: [],
        },
      })
      return
    }
    if (message.method === 'tools/call' && message.params?.name === 'youzan_query') {
      queryCalls.push(message.params)
      const progressToken = message.params._meta?.progressToken
      progressTokens.push(progressToken)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`event: message\ndata: ${JSON.stringify({
        jsonrpc: '2.0', method: 'notifications/progress',
        params: {
          progressToken, progress: 1, total: 1,
          _meta: { 'com.youzan.youzan_query/progress': { status: 'RUNNING' } },
        },
      })}\n\n`)
      response.end(`event: message\ndata: ${JSON.stringify({
        jsonrpc: '2.0', id: message.id,
        result: {
          structuredContent: {
            status: 'COMPLETED',
            workSessionId: message.params.arguments?.workSessionId,
            workRequestId: message.params.arguments?.workRequestId,
            merged: { shopName: '模拟店铺' },
          },
          content: [],
        },
      })}\n\n`)
      return
    }
    respondJson(response, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })
  })
  await listen(upstream)
  cleanups.push(() => closeServer(upstream))

  const address = upstream.address()
  if (!address || typeof address === 'string') throw new Error('Upstream did not bind')
  const connector = {
    catalogRevision: 'youzan-test.1',
    remote: { type: 'streamable-http' as const, url: `http://127.0.0.1:${address.port}/mcp/sse/v1` },
    auth: {
      type: 'api-key' as const, in: 'header' as const, name: 'Authorization', valueTemplate: 'Bearer ${value}',
      label: { zh: 'Service Token', en: 'Service Token' }, helpUrl: 'https://claw.youzan.com/help/standalone',
    },
    enabled: true,
    addedAt: '2026-11-25T00:00:00.000Z',
  }
  const secrets = new MemorySecretStore()
  await secrets.write('youzan-workbuddy', { v: 1, apiKey: 'test-youzan-token' })
  const gateway = await CredentialGateway.start({
    getConnector: id => id === 'youzan-workbuddy' ? connector : undefined,
    secrets,
  })
  cleanups.push(() => gateway.close())

  const endpoint = gateway.endpoint('youzan-workbuddy')
  const client = new Client({ name: 'youzan-streaming-test', version: '1.0.0' })
  cleanups.push(() => client.close())
  const transport = new StreamableHTTPClientTransport(new URL(endpoint.url), {
    requestInit: { headers: endpoint.headers },
    fetch: async (input, init) => {
      const response = await fetch(input, init)
      observed.push({
        method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
        contentType: response.headers.get('content-type'),
      })
      return response
    },
  })
  await client.connect(transport)
  const tools = await client.listTools()
  const schemaVersion = tools.tools.find(tool => tool.name === 'youzan_query')
    ?.inputSchema.properties?.schemaVersion?.enum?.[0]
  expect(schemaVersion).toBe('fixture-v1')
  await waitFor(() => observed.some(item => item.method === 'GET' && item.contentType?.includes('text/event-stream')))

  const skill = await client.callTool({
    name: 'skill_query', arguments: { skill: 'youzan-shop', schemaVersion },
  })
  expect(skill.structuredContent).toMatchObject({ skill: 'youzan-shop' })

  const progress: number[] = []
  const result = await client.callTool({
    name: 'youzan_query',
    arguments: {
      query: '查询当前店铺基础信息', skill: 'youzan-shop', schemaVersion,
      workSessionId: 'work-session-fixed', workRequestId: 'work-request-fixed',
    },
  }, { onprogress: event => progress.push(event.progress) })

  expect(progress).toEqual([1])
  expect(progressTokens).toHaveLength(1)
  expect(['string', 'number']).toContain(typeof progressTokens[0])
  expect(queryCalls).toHaveLength(1)
  expect(queryCalls[0].arguments).toEqual({
    query: '查询当前店铺基础信息', skill: 'youzan-shop', schemaVersion,
    workSessionId: 'work-session-fixed', workRequestId: 'work-request-fixed',
  })
  expect(result.structuredContent).toMatchObject({
    status: 'COMPLETED', workSessionId: 'work-session-fixed', workRequestId: 'work-request-fixed',
  })
  expect(observed.some(item => item.method === 'GET' && item.contentType?.includes('text/event-stream'))).toBe(true)
})

function skillQueryTool() {
  return {
    name: 'skill_query', description: 'Query skill documentation.',
    inputSchema: {
      type: 'object',
      properties: { skill: { type: 'string', enum: ['youzan-shop'] }, schemaVersion: { type: 'string', enum: ['fixture-v1'] } },
      required: ['skill', 'schemaVersion'],
    },
  }
}

function youzanQueryTool() {
  return {
    name: 'youzan_query', description: 'Run a simple read-only shop query.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' }, skill: { type: 'string', enum: ['youzan-shop'] },
        schemaVersion: { type: 'string', enum: ['fixture-v1'] },
        workSessionId: { type: 'string' }, workRequestId: { type: 'string' },
      },
      required: ['query', 'skill', 'schemaVersion', 'workSessionId', 'workRequestId'],
    },
    _meta: { 'com.youzan.youzan_query/streaming': { supported: true, progressSchema: { type: 'object' } } },
  }
}

interface JsonRpcMessage {
  id?: string | number | null
  method?: string
  params?: {
    protocolVersion?: string
    name?: string
    arguments?: Record<string, unknown>
    _meta?: { progressToken?: string | number }
  }
}

async function readJson(request: Parameters<Parameters<typeof createServer>[0]>[0]): Promise<JsonRpcMessage> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonRpcMessage
}

function respondJson(response: Parameters<Parameters<typeof createServer>[0]>[1], value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  response.end(body)
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!server.listening) return resolve()
    server.close(error => error ? reject(error) : resolve())
    server.closeAllConnections()
  })
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('Timed out waiting for the SSE GET stream')
}
