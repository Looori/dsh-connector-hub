import { createServer, type Server } from 'node:http'

export interface OAuthFixtureServer {
  origin: string
  catalogUrl: string
  catalog: ReturnType<typeof catalog>
  tokenRequests: URLSearchParams[]
  refreshRequests: URLSearchParams[]
  mcpRequests: Array<{ method: string, authorization: string | null, body: unknown }>
  registrationRequests: number
  revocationRequests: number
  issueRefreshToken: boolean
  rejectRefresh: boolean
  rejectMcp: boolean
  rejectMcpOnce: boolean
  pauseAuthorization: boolean
  includeAccount: boolean
  accessTokenLifetimeSeconds: number
  revocationStatus: number
  close(): Promise<void>
}

/** Local catalog, MCP and authorization server; no external network access. */
export async function startOAuthFixtureServer(): Promise<OAuthFixtureServer> {
  const tokenRequests: URLSearchParams[] = []
  const refreshRequests: URLSearchParams[] = []
  const mcpRequests: OAuthFixtureServer['mcpRequests'] = []
  let origin = ''
  let currentCatalog!: ReturnType<typeof catalog>
  let registrationRequests = 0
  let revocationRequests = 0
  let tokenSequence = 0
  const fixture: OAuthFixtureServer = {
    get origin() { return origin },
    get catalogUrl() { return `${origin}/catalog.json` },
    get catalog() { return currentCatalog },
    tokenRequests,
    refreshRequests,
    mcpRequests,
    get registrationRequests() { return registrationRequests },
    get revocationRequests() { return revocationRequests },
    issueRefreshToken: true,
    rejectRefresh: false,
    rejectMcp: false,
    rejectMcpOnce: false,
    pauseAuthorization: false,
    includeAccount: false,
    accessTokenLifetimeSeconds: 3600,
    revocationStatus: 200,
    close: () => closeServer(server),
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (request.method === 'GET' && url.pathname === '/catalog.json') {
      respondJson(response, 200, currentCatalog)
      return
    }
    if (request.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource/mcp') {
      respondJson(response, 200, {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        scopes_supported: ['mcp:connect'],
      })
      return
    }
    if (request.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
      respondJson(response, 200, {
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        revocation_endpoint: `${origin}/revoke`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        client_id_metadata_document_supported: true,
        authorization_response_iss_parameter_supported: true,
      })
      return
    }
    if (request.method === 'GET' && url.pathname === '/authorize') {
      if (fixture.pauseAuthorization) {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end('<!doctype html><title>Paused OAuth authorization</title><p>Waiting for test cancellation.</p>')
        return
      }
      const callback = new URL(url.searchParams.get('redirect_uri') ?? '')
      callback.searchParams.set('code', 'oauth-code')
      callback.searchParams.set('state', url.searchParams.get('state') ?? '')
      callback.searchParams.set('iss', origin)
      response.writeHead(302, { location: callback.toString() }).end()
      return
    }
    if (request.method === 'POST' && url.pathname === '/register') {
      registrationRequests += 1
      respondJson(response, 500, { error: 'dynamic registration forbidden' })
      return
    }
    if (request.method === 'POST' && url.pathname === '/revoke') {
      revocationRequests += 1
      response.writeHead(fixture.revocationStatus).end()
      return
    }
    if (request.method === 'POST' && url.pathname === '/token') {
      const body = await readForm(request)
      if (body.get('grant_type') === 'refresh_token') {
        refreshRequests.push(body)
        if (fixture.rejectRefresh) {
          respondJson(response, 400, { error: 'invalid_grant', error_description: 'refresh token expired' })
          return
        }
      } else tokenRequests.push(body)
      tokenSequence += 1
      respondJson(response, 200, {
        access_token: `access-${tokenSequence}`,
        ...(fixture.issueRefreshToken ? { refresh_token: `refresh-${tokenSequence}` } : {}),
        token_type: 'Bearer',
        expires_in: fixture.accessTokenLifetimeSeconds,
        scope: 'openid mcp:connect',
        ...(fixture.includeAccount ? { workspace_name: 'E2E Workspace' } : {}),
      })
      return
    }
    if (url.pathname === '/mcp') {
      const message = request.method === 'POST' ? await readJson(request) : null
      mcpRequests.push({
        method: request.method ?? 'GET',
        authorization: request.headers.authorization ?? null,
        body: message,
      })
      const rejectOnce = fixture.rejectMcpOnce
      fixture.rejectMcpOnce = false
      if (fixture.rejectMcp || rejectOnce || request.headers.authorization !== `Bearer access-${tokenSequence}`) {
        respondJson(response, 401, { error: 'Invalid or expired access token' })
        return
      }
      if (request.method !== 'POST') {
        respondJson(response, 405, { error: 'Method not allowed' })
        return
      }
      if (message.id === undefined) {
        response.writeHead(202).end()
        return
      }
      respondJson(response, 200, rpcResult(message))
      return
    }
    respondJson(response, 404, { error: 'Not found' })
  })

  await listen(server, 0)
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('OAuth fixture did not bind')
  origin = `http://127.0.0.1:${address.port}`
  currentCatalog = catalog(origin)
  return fixture
}

interface JsonRpcMessage {
  id?: string | number | null
  method?: string
  params?: {
    protocolVersion?: string
    arguments?: { text?: string }
  }
}

function catalog(origin: string) {
  return {
    schemaVersion: 1,
    revision: 'oauth-e2e.1',
    connectors: [{
      id: 'notion',
      name: { zh: '模拟 OAuth', en: 'Mock OAuth' },
      description: { zh: '仅用于 OAuth 自动化测试。', en: 'Used only by OAuth automated tests.' },
      icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=',
      homepage: 'https://example.com',
      publisher: 'Connector Hub Tests',
      official: false,
      remote: { type: 'streamable-http', url: `${origin}/mcp` },
      auth: {
        type: 'oauth', scope: 'openid mcp:connect',
        clientMetadataUrl: 'https://example.com/client.json',
        callbackPath: '/oauth/callback/notion', portPolicy: 'random',
      },
    }],
  }
}

function rpcResult(message: JsonRpcMessage) {
  const base = { jsonrpc: '2.0', id: message.id ?? null }
  switch (message.method) {
    case 'initialize':
      return { ...base, result: {
        protocolVersion: message.params?.protocolVersion ?? '2025-03-26',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'connector-hub-oauth-e2e', version: '1.0.0' },
      } }
    case 'tools/list':
      return { ...base, result: { tools: [{
        name: 'echo',
        description: 'Return text unchanged.',
        inputSchema: {
          type: 'object', properties: { text: { type: 'string' } },
          required: ['text'], additionalProperties: false,
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

async function readForm(request: Parameters<Parameters<typeof createServer>[0]>[0]): Promise<URLSearchParams> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}

function respondJson(response: Parameters<Parameters<typeof createServer>[0]>[1], status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  response.end(body)
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve()
  const closed = new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  })
  server.closeAllConnections()
  return closed
}
