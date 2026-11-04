import { createServer, type Server } from 'node:http'

export interface OAuthFixtureServer {
  origin: string
  tokenRequests: URLSearchParams[]
  refreshRequests: URLSearchParams[]
  registrationRequests: number
  revocationRequests: number
  issueRefreshToken: boolean
  rejectRefresh: boolean
  revocationStatus: number
  close(): Promise<void>
}

/** Local MCP authorization server with discovery, PKCE token exchange and refresh. */
export async function startOAuthFixtureServer(): Promise<OAuthFixtureServer> {
  const tokenRequests: URLSearchParams[] = []
  const refreshRequests: URLSearchParams[] = []
  let origin = ''
  let registrationRequests = 0
  let revocationRequests = 0
  let tokenSequence = 0
  const fixture: OAuthFixtureServer = {
    get origin() { return origin },
    tokenRequests,
    refreshRequests,
    get registrationRequests() { return registrationRequests },
    get revocationRequests() { return revocationRequests },
    issueRefreshToken: true,
    rejectRefresh: false,
    revocationStatus: 200,
    close: () => closeServer(server),
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
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
        expires_in: 3600,
        scope: 'openid mcp:connect',
      })
      return
    }
    respondJson(response, 404, { error: 'Not found' })
  })

  await listen(server, 0)
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('OAuth fixture did not bind')
  origin = `http://127.0.0.1:${address.port}`
  return fixture
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
