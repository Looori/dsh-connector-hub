import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { auth, Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

const MODE = process.argv[2] ?? 'probe'
const fixed = process.argv.includes('--fixed')
const SERVER_URL = 'https://app.xmind.cn/api/mcp'
const REGISTRATION_URL = 'https://app.xmind.cn/api/oauth/register'
const SCOPE = 'openid mcp:connect'
const FIXED_PORT = 43118
const CALLBACK_PATH = '/oauth/callback/xmind-cn'
const FIXED_REDIRECT = `http://127.0.0.1:${FIXED_PORT}${CALLBACK_PATH}`
const CLIENT_FILE = new URL('./xmind-client.json', import.meta.url)
let callbackServer
let registrationAttempts = 0

function guardedFetch(input, init) {
  const url = new URL(input instanceof Request ? input.url : input)
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
  if (url.origin === 'https://app.xmind.cn' && url.pathname === '/api/oauth/register' && method === 'POST') {
    registrationAttempts += 1
    throw new Error('Dynamic registration is forbidden after the shared client has been injected')
  }
  return fetch(input, init)
}

class XmindProvider {
  constructor(clientId, redirectUrl) {
    this.redirectUrl = redirectUrl
    this.clientMetadata = {
      client_name: 'DSH Connector Hub',
      client_uri: 'https://looori.github.io/dsh-connector-hub/',
      redirect_uris: [redirectUrl],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: SCOPE,
    }
    this.savedClient = { client_id: clientId, token_endpoint_auth_method: 'none' }
    this.savedState = randomUUID()
  }
  clientInformation(context) {
    return context ? { ...this.savedClient, issuer: context.issuer } : this.savedClient
  }
  saveClientInformation(value) {
    assert.equal(value.client_id, this.savedClient.client_id)
    assert.ok(!('client_secret' in value), 'The public client must not receive a client secret')
    this.savedClient = value
  }
  tokens() { return this.savedTokens }
  saveTokens(value) { this.savedTokens = value }
  state() { return this.savedState }
  saveCodeVerifier(value) { this.savedVerifier = value }
  codeVerifier() { return this.savedVerifier }
  saveDiscoveryState(value) { this.discovery = value }
  discoveryState() { return this.discovery }
  redirectToAuthorization(url) { this.authorizationUrl = url.toString() }
}

async function registerSharedClient() {
  if (process.env.M0_CREATE_XMIND_SHARED_CLIENT !== 'yes') {
    throw new Error('Refusing to create an external client without M0_CREATE_XMIND_SHARED_CLIENT=yes')
  }
  try {
    await readFile(CLIENT_FILE, 'utf8')
    throw new Error('xmind-client.json already exists; reuse it instead of creating another client')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const registration = {
    client_name: 'DSH Connector Hub',
    client_uri: 'https://looori.github.io/dsh-connector-hub/',
    redirect_uris: [FIXED_REDIRECT],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    scope: SCOPE,
  }
  const response = await fetch(REGISTRATION_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(registration),
    signal: AbortSignal.timeout(20_000),
  })
  const text = await response.text()
  let body
  try { body = JSON.parse(text) } catch { body = undefined }
  if (!response.ok || typeof body?.client_id !== 'string' || !body.client_id) {
    const safeError = typeof body?.error === 'string' ? body.error.slice(0, 200) : undefined
    throw new Error(`Xmind client registration failed: HTTP ${response.status}${safeError ? `, ${safeError}` : ''}`)
  }
  const publicClient = {
    client_id: body.client_id,
    client_name: 'DSH Connector Hub',
    token_endpoint_auth_method: 'none',
    registered_redirect_uri: FIXED_REDIRECT,
  }
  await writeFile(CLIENT_FILE, `${JSON.stringify(publicClient, null, 2)}\n`, { flag: 'wx', mode: 0o644 })
  return publicClient
}

async function loadSharedClient() {
  const value = JSON.parse(await readFile(CLIENT_FILE, 'utf8'))
  assert.equal(typeof value.client_id, 'string')
  assert.equal(value.token_endpoint_auth_method, 'none')
  assert.ok(!('client_secret' in value))
  return value
}

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    const onError = error => reject(error)
    server.once('error', onError)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError)
      resolve()
    })
  })
}

async function startCallback(clientId) {
  let provider
  let resolveCallback
  let rejectCallback
  let callbackAttempts = 0
  const completed = new Promise((resolve, reject) => { resolveCallback = resolve; rejectCallback = reject })
  callbackServer = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end('Not found')
        return
      }
      callbackAttempts += 1
      if (callbackAttempts !== 1 || url.searchParams.get('state') !== provider.savedState) {
        res.writeHead(403).end('Invalid or replayed callback')
        return
      }
      const code = url.searchParams.get('code')
      if (!code) throw new Error(`Authorization callback did not contain a code: ${url.searchParams.get('error') ?? 'unknown error'}`)
      await auth(provider, {
        serverUrl: SERVER_URL,
        scope: SCOPE,
        authorizationCode: code,
        iss: url.searchParams.get('iss') ?? undefined,
        fetchFn: guardedFetch,
      })
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('已连接，可以关闭此页')
      resolveCallback()
    })().catch(error => {
      if (!res.headersSent) res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('授权失败，可以关闭此页')
      rejectCallback(error)
    })
  })
  try {
    await listen(callbackServer, fixed ? FIXED_PORT : 0)
  } catch (error) {
    if (error.code === 'EADDRINUSE') throw new Error(`固定回调端口 ${FIXED_PORT} 被占用；未打开授权页`)
    throw error
  }
  const port = callbackServer.address().port
  const redirectUrl = `http://127.0.0.1:${port}${CALLBACK_PATH}`
  provider = new XmindProvider(clientId, redirectUrl)
  return { provider, redirectUrl, completed }
}

async function probeMcp(accessToken) {
  const client = new Client({ name: 'dsh-connector-hub-m0', version: '0.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(SERVER_URL), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
  })
  try {
    await client.connect(transport)
    const { tools } = await client.listTools()
    return tools.map(tool => tool.name)
  } finally {
    await client.close()
  }
}

async function openBrowser(url) {
  await new Promise((resolve, reject) => {
    const child = spawn('open', [url], { stdio: 'ignore' })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`open exited with ${code}`)))
  })
}

async function closeCallback() {
  if (!callbackServer) return
  callbackServer.closeAllConnections?.()
  await new Promise(resolve => callbackServer.close(resolve))
}

function safeAuthorizationResponse(response, location, authorizationUrl) {
  const locationSummary = location ? (() => {
    const url = new URL(location, authorizationUrl)
    return { origin: url.origin, path: url.pathname, error: url.searchParams.get('error') }
  })() : null
  return { status: response.status, location: locationSummary }
}

async function verifyFixedPortBusy() {
  const blocker = createServer()
  await listen(blocker, FIXED_PORT)
  try {
    await assert.rejects(startCallback('m0-no-real-client'), new RegExp(`固定回调端口 ${FIXED_PORT} 被占用；未打开授权页`))
    console.log(JSON.stringify({ ok: true, fixedPortBusy: 'rejected before authorization', port: FIXED_PORT }, null, 2))
  } finally {
    blocker.closeAllConnections?.()
    await new Promise(resolve => blocker.close(resolve))
  }
}

try {
  if (MODE === 'busy') {
    await verifyFixedPortBusy()
  } else {
    const sharedClient = MODE === 'register' ? await registerSharedClient() : await loadSharedClient()
    if (MODE === 'register') {
      console.log(JSON.stringify({ ok: true, mode: MODE, sharedClient, secretsPersisted: false }, null, 2))
    } else {
      const { provider, redirectUrl, completed } = await startCallback(sharedClient.client_id)
      const started = await auth(provider, { serverUrl: SERVER_URL, scope: SCOPE, fetchFn: guardedFetch })
      assert.equal(started, 'REDIRECT')
      const authorizationUrl = new URL(provider.authorizationUrl)
      assert.equal(authorizationUrl.searchParams.get('client_id'), sharedClient.client_id)
      assert.equal(authorizationUrl.searchParams.get('redirect_uri'), redirectUrl)
      assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 'S256')
      assert.equal(registrationAttempts, 0)

      const preflight = await fetch(authorizationUrl, { redirect: 'manual', signal: AbortSignal.timeout(20_000) })
      const authorizationResponse = safeAuthorizationResponse(preflight, preflight.headers.get('location'), authorizationUrl)
      await preflight.body?.cancel()
      const rejected = preflight.status >= 400 || authorizationResponse.location?.error
      if (MODE === 'probe' || rejected) {
        console.log(JSON.stringify({
          ok: !rejected,
          mode: 'probe',
          sharedClient: true,
          dynamicRegistrationAttempts: registrationAttempts,
          randomPort: !fixed,
          redirectUri: redirectUrl,
          authorizationResponse,
          tokensPersisted: false,
        }, null, 2))
        if (rejected) process.exitCode = 1
      } else {
        await openBrowser(authorizationUrl.toString())
        console.log('Xmind 授权页已在系统浏览器打开；请在浏览器中完成授权。')
        let timeoutTimer
        const timeout = new Promise((_, reject) => {
          timeoutTimer = setTimeout(() => reject(new Error('等待授权回调超时（240 秒）')), 240_000)
        })
        try {
          await Promise.race([completed, timeout])
        } finally {
          clearTimeout(timeoutTimer)
        }
        const firstRefreshToken = provider.savedTokens.refresh_token
        assert.equal(typeof firstRefreshToken, 'string')
        const toolsBeforeRefresh = await probeMcp(provider.savedTokens.access_token)
        const refreshed = await auth(provider, { serverUrl: SERVER_URL, scope: SCOPE, fetchFn: guardedFetch })
        assert.equal(refreshed, 'AUTHORIZED')
        assert.notEqual(provider.savedTokens.refresh_token, firstRefreshToken)
        const toolsAfterRefresh = await probeMcp(provider.savedTokens.access_token)
        assert.equal(registrationAttempts, 0)
        console.log(JSON.stringify({
          ok: true,
          mode: 'full',
          sharedClient: true,
          dynamicRegistrationAttempts: registrationAttempts,
          randomPort: !fixed,
          redirectUri: redirectUrl,
          tokenExchange: true,
          refresh: true,
          refreshTokenRotated: true,
          mcpProbeBeforeRefresh: toolsBeforeRefresh,
          mcpProbeAfterRefresh: toolsAfterRefresh,
          tokensPersisted: false,
        }, null, 2))
      }
    }
  }
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: String(error),
    dynamicRegistrationAttempts: registrationAttempts,
    tokensPersisted: false,
  }, null, 2))
  process.exitCode = 1
} finally {
  await closeCallback()
}
