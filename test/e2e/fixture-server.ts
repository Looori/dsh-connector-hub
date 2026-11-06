import { createServer, type Server } from 'node:http'

export const TEST_API_KEY = 'e2e-secret'
export const CONNECTOR_ID = 'mock-api-key'

export interface FixtureServer {
  origin: string
  catalogUrl: string
  catalog: ReturnType<typeof catalog>
  requests: string[]
  close(): Promise<void>
}

/** Local catalog and stateless Streamable HTTP MCP server; no external network access. */
export async function startFixtureServer(): Promise<FixtureServer> {
  const requests: string[] = []
  let currentCatalog!: ReturnType<typeof catalog>
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (request.method === 'GET' && url.pathname === '/catalog.json') {
      respondJson(response, 200, currentCatalog)
      return
    }
    if (!['/mcp', '/v2/mcp'].includes(url.pathname)) {
      respondJson(response, 404, { error: 'Not found' })
      return
    }
    requests.push(url.pathname)
    if (request.headers['x-api-key'] !== TEST_API_KEY) {
      respondJson(response, 401, { error: 'Invalid API Key' })
      return
    }
    if (request.method !== 'POST') {
      respondJson(response, 405, { error: 'Method not allowed' })
      return
    }

    try {
      const message = await readJson(request)
      if (message.id === undefined) {
        response.writeHead(202).end()
        return
      }
      respondJson(response, 200, rpcResult(message))
    } catch (error) {
      respondJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Fixture server did not bind')
  const origin = `http://127.0.0.1:${address.port}`
  currentCatalog = catalog(origin)
  return {
    origin,
    catalogUrl: `${origin}/catalog.json`,
    catalog: currentCatalog,
    requests,
    close: () => closeServer(server),
  }
}

function catalog(origin: string) {
  return {
    schemaVersion: 1,
    revision: 'e2e.1',
    connectors: [{
      id: CONNECTOR_ID,
      name: { zh: '模拟连接器', en: 'Mock API Key' },
      description: { zh: '仅用于自动化测试。', en: 'Used only by automated tests.' },
      icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=',
      homepage: 'https://example.com',
      publisher: 'Connector Hub Tests',
      official: false,
      remote: { type: 'streamable-http', url: `${origin}/mcp` },
      auth: {
        type: 'api-key', in: 'header', name: 'x-api-key',
        label: { zh: '测试 Key', en: 'Test Key' },
        helpUrl: 'https://example.com/key',
      },
    }],
  }
}

interface JsonRpcMessage {
  id?: string | number | null
  method?: string
  params?: {
    protocolVersion?: string
    arguments?: { text?: string }
  }
}

function rpcResult(message: JsonRpcMessage) {
  const base = { jsonrpc: '2.0', id: message.id ?? null }
  switch (message.method) {
    case 'initialize':
      return { ...base, result: {
        protocolVersion: message.params?.protocolVersion ?? '2025-03-26',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'connector-hub-e2e', version: '1.0.0' },
      } }
    case 'tools/list':
      return { ...base, result: { tools: [{
        name: 'echo',
        description: 'Return text unchanged.',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false,
        },
      }] } }
    case 'tools/call':
      return { ...base, result: { content: [{ type: 'text', text: message.params?.arguments?.text ?? '' }] } }
    case 'ping':
      return { ...base, result: {} }
    default:
      return { ...base, error: { code: -32601, message: 'Method not found' } }
  }
}

async function readJson(request: Parameters<Parameters<typeof createServer>[0]>[0]): Promise<JsonRpcMessage> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonRpcMessage
}

function respondJson(response: Parameters<Parameters<typeof createServer>[0]>[1], status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  response.end(body)
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
    server.closeAllConnections()
  })
}
