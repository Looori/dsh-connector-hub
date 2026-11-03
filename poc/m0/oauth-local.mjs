import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { auth } from '@modelcontextprotocol/client'

const CIMD_URL = 'https://looori.github.io/dsh-connector-hub/oauth/notion/client.json'
const SHARED_CLIENT_ID = 'm0-shared-public-client'
const runningServers = new Set()

async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    const onError = error => reject(error)
    server.once('error', onError)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError)
      runningServers.add(server)
      resolve()
    })
  })
  return server.address().port
}

async function closeServer(server) {
  if (!runningServers.delete(server)) return
  server.closeAllConnections?.()
  await new Promise(resolve => server.close(resolve))
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
}

async function form(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return new URLSearchParams(Buffer.concat(chunks).toString())
}

class MockAuthorizationServer {
  constructor({ allowVariablePort, fixedRedirect }) {
    this.allowVariablePort = allowVariablePort
    this.fixedRedirect = fixedRedirect
    this.codes = new Map()
    this.refreshTokens = new Map()
    this.registrationCalls = 0
    this.refreshCalls = 0
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch(error => json(res, 500, { error: String(error) }))
    })
  }

  async start() {
    const port = await listen(this.server)
    this.origin = `http://127.0.0.1:${port}`
    this.resourceMetadataUrl = `${this.origin}/.well-known/oauth-protected-resource/mcp`
    return this
  }

  async handle(req, res) {
    const url = new URL(req.url, this.origin)
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
      json(res, 200, {
        resource: `${this.origin}/mcp`,
        authorization_servers: [this.origin],
        scopes_supported: ['mcp:connect'],
      })
      return
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      json(res, 200, {
        issuer: this.origin,
        authorization_endpoint: `${this.origin}/authorize`,
        token_endpoint: `${this.origin}/token`,
        registration_endpoint: `${this.origin}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        authorization_response_iss_parameter_supported: true,
        client_id_metadata_document_supported: true,
      })
      return
    }
    if (url.pathname === '/authorize') {
      this.authorize(url, res)
      return
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      await this.token(req, res)
      return
    }
    if (url.pathname === '/register' && req.method === 'POST') {
      this.registrationCalls += 1
      json(res, 500, { error: 'Dynamic registration must not be used by shared-client flows' })
      return
    }
    json(res, 404, { error: 'not_found' })
  }

  authorize(url, res) {
    const redirectUri = url.searchParams.get('redirect_uri')
    const clientId = url.searchParams.get('client_id')
    const state = url.searchParams.get('state')
    const challenge = url.searchParams.get('code_challenge')
    const validClient = clientId === CIMD_URL || clientId === SHARED_CLIENT_ID
    const validRedirect = this.allowVariablePort
      ? new URL(redirectUri).hostname === '127.0.0.1'
      : redirectUri === this.fixedRedirect
    if (!validClient || !validRedirect || !state || !challenge || url.searchParams.get('code_challenge_method') !== 'S256') {
      json(res, 400, { error: validRedirect ? 'invalid_request' : 'invalid_redirect_uri' })
      return
    }
    const code = randomUUID()
    this.codes.set(code, { clientId, redirectUri, challenge, used: false })
    const callback = new URL(redirectUri)
    callback.searchParams.set('code', code)
    callback.searchParams.set('state', state)
    callback.searchParams.set('iss', this.origin)
    res.writeHead(302, { location: callback.toString() }).end()
  }

  async token(req, res) {
    const params = await form(req)
    if (params.get('grant_type') === 'authorization_code') {
      const grant = this.codes.get(params.get('code'))
      if (!grant || grant.used) {
        json(res, 400, { error: 'invalid_grant' })
        return
      }
      const expected = createHash('sha256').update(params.get('code_verifier') ?? '').digest('base64url')
      if (expected !== grant.challenge || params.get('redirect_uri') !== grant.redirectUri || params.get('client_id') !== grant.clientId) {
        json(res, 400, { error: 'invalid_grant' })
        return
      }
      grant.used = true
      const refreshToken = randomUUID()
      this.refreshTokens.set(refreshToken, { clientId: grant.clientId, active: true })
      json(res, 200, {
        access_token: randomUUID(), refresh_token: refreshToken, token_type: 'Bearer', expires_in: 3600,
      })
      return
    }
    if (params.get('grant_type') === 'refresh_token') {
      const grant = this.refreshTokens.get(params.get('refresh_token'))
      if (!grant?.active || params.get('client_id') !== grant.clientId) {
        json(res, 400, { error: 'invalid_grant' })
        return
      }
      this.refreshCalls += 1
      grant.active = false
      const refreshToken = randomUUID()
      this.refreshTokens.set(refreshToken, { clientId: grant.clientId, active: true })
      json(res, 200, {
        access_token: randomUUID(), refresh_token: refreshToken, token_type: 'Bearer', expires_in: 3600,
      })
      return
    }
    json(res, 400, { error: 'unsupported_grant_type' })
  }
}

class MemoryProvider {
  constructor({ mode, redirectUrl }) {
    this.mode = mode
    this.redirectUrl = redirectUrl
    this.clientMetadataUrl = mode === 'cimd' ? CIMD_URL : undefined
    this.clientMetadata = {
      client_name: 'DSH Connector Hub M0 spike',
      redirect_uris: [redirectUrl],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'mcp:connect',
    }
    this.savedClient = mode === 'shared'
      ? { client_id: SHARED_CLIENT_ID, token_endpoint_auth_method: 'none' }
      : undefined
    this.savedTokens = undefined
    this.savedVerifier = undefined
    this.authorizationUrl = undefined
    this.savedState = randomUUID()
  }

  clientInformation(ctx) {
    if (this.savedClient && ctx && !this.savedClient.issuer) return { ...this.savedClient, issuer: ctx.issuer }
    return this.savedClient
  }
  saveClientInformation(value) { this.savedClient = value }
  tokens() { return this.savedTokens }
  saveTokens(value) { this.savedTokens = value }
  state() { return this.savedState }
  saveCodeVerifier(value) { this.savedVerifier = value }
  codeVerifier() { return this.savedVerifier }
  saveDiscoveryState(value) { this.savedDiscoveryState = value }
  discoveryState() { return this.savedDiscoveryState }
  redirectToAuthorization(url) { this.authorizationUrl = url.toString() }
}

async function startCallback(providerName, port, providerNameSpace) {
  let provider
  let attempts = 0
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url, 'http://127.0.0.1')
      if (url.pathname !== `/oauth/callback/${providerName}`) {
        json(res, 404, { ok: false })
        return
      }
      attempts += 1
      if (attempts !== 1 || url.searchParams.get('state') !== provider.savedState) {
        json(res, 403, { ok: false, error: 'invalid_state_or_replayed_callback' })
        return
      }
      await auth(provider, {
        serverUrl: `${providerNameSpace.origin}/mcp`,
        resourceMetadataUrl: new URL(providerNameSpace.resourceMetadataUrl),
        authorizationCode: url.searchParams.get('code'),
        iss: url.searchParams.get('iss'),
      })
      json(res, 200, { ok: true })
    })().catch(error => json(res, 400, { ok: false, error: String(error) }))
  })
  try {
    const actualPort = await listen(server, port)
    const redirectUrl = `http://127.0.0.1:${actualPort}/oauth/callback/${providerName}`
    provider = new MemoryProvider({ mode: providerNameSpace.mode, redirectUrl })
    return { server, redirectUrl, provider }
  } catch (error) {
    if (error.code === 'EADDRINUSE') {
      throw new Error(`固定回调端口 ${port} 被占用；未打开授权页`, { cause: error })
    }
    throw error
  }
}

async function runFlow(mode, portPolicy) {
  const authorizationServer = await new MockAuthorizationServer({
    allowVariablePort: portPolicy === 'random',
    fixedRedirect: undefined,
  }).start()
  authorizationServer.mode = mode
  let callback
  let fixedPort
  if (portPolicy === 'fixed') {
    const reservation = createServer()
    fixedPort = await listen(reservation)
    await closeServer(reservation)
    authorizationServer.fixedRedirect = `http://127.0.0.1:${fixedPort}/oauth/callback/${mode}`
  }
  try {
    callback = await startCallback(mode, fixedPort ?? 0, authorizationServer)
    const { provider, redirectUrl } = callback
    const options = {
      serverUrl: `${authorizationServer.origin}/mcp`,
      resourceMetadataUrl: new URL(authorizationServer.resourceMetadataUrl),
    }
    const started = await auth(provider, options)
    assert.equal(started, 'REDIRECT')
    const authorizationUrl = new URL(provider.authorizationUrl)
    assert.equal(authorizationUrl.searchParams.get('client_id'), mode === 'cimd' ? CIMD_URL : SHARED_CLIENT_ID)
    assert.equal(authorizationUrl.searchParams.get('redirect_uri'), redirectUrl)
    assert.equal(authorizationUrl.searchParams.get('state'), provider.savedState)
    assert.ok(authorizationUrl.searchParams.get('code_challenge'))
    assert.equal(authorizationServer.registrationCalls, 0)

    const authorizationResponse = await fetch(authorizationUrl, { redirect: 'manual' })
    assert.equal(authorizationResponse.status, 302)
    const callbackUrl = authorizationResponse.headers.get('location')
    const callbackResponse = await fetch(callbackUrl)
    assert.equal(callbackResponse.status, 200, await callbackResponse.text())
    assert.equal(provider.savedTokens.token_type, 'Bearer')
    const firstRefreshToken = provider.savedTokens.refresh_token

    const refreshed = await auth(provider, options)
    assert.equal(refreshed, 'AUTHORIZED')
    assert.equal(authorizationServer.refreshCalls, 1)
    assert.notEqual(provider.savedTokens.refresh_token, firstRefreshToken)
    assert.equal(authorizationServer.registrationCalls, 0)
    return {
      mode,
      portPolicy,
      clientId: mode === 'cimd' ? 'CIMD URL' : 'shared public client ID',
      dynamicRegistrationCalls: authorizationServer.registrationCalls,
      pkceAndTokenExchange: true,
      refreshAndRotation: true,
      callbackPath: new URL(redirectUrl).pathname,
    }
  } finally {
    if (callback) await closeServer(callback.server)
    await closeServer(authorizationServer.server)
  }
}

async function verifyFixedPortBusy() {
  const blocker = createServer()
  const port = await listen(blocker)
  try {
    await assert.rejects(
      startCallback('fixed-busy', port, { mode: 'shared' }),
      /固定回调端口 .* 被占用；未打开授权页/,
    )
    return { fixedPortBusy: 'rejected before authorization', port }
  } finally {
    await closeServer(blocker)
  }
}

try {
  const results = []
  results.push(await runFlow('cimd', 'random'))
  results.push(await runFlow('shared', 'random'))
  results.push(await runFlow('shared', 'fixed'))
  const busy = await verifyFixedPortBusy()
  console.log(JSON.stringify({ ok: true, results, fixedPortBusy: busy.fixedPortBusy }, null, 2))
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: String(error), stack: error.stack }, null, 2))
  process.exitCode = 1
} finally {
  for (const server of runningServers) await closeServer(server)
}
