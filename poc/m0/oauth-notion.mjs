import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { auth, Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

const MODE = process.argv[2] ?? 'probe'
const CLIENT_METADATA_URL = 'https://looori.github.io/dsh-connector-hub/oauth/notion/client.json'
const SERVER_URL = 'https://mcp.notion.com/mcp'
const FIXED_PORT = 43117
const fixed = process.argv.includes('--fixed')
let callbackServer
let registrationAttempts = 0

function guardedFetch(input, init) {
  const url = new URL(input instanceof Request ? input.url : input)
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
  if (url.hostname === 'mcp.notion.com' && url.pathname === '/register' && method === 'POST') {
    registrationAttempts += 1
    throw new Error('Dynamic registration is forbidden for the shared-client spike')
  }
  return fetch(input, init)
}

class NotionProvider {
  constructor(redirectUrl) {
    this.redirectUrl = redirectUrl
    this.clientMetadataUrl = CLIENT_METADATA_URL
    this.clientMetadata = {
      client_name: 'DSH Connector Hub',
      client_uri: 'https://looori.github.io/dsh-connector-hub/',
      redirect_uris: [redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: 'native',
    }
    this.savedState = randomUUID()
  }
  clientInformation() { return this.savedClient }
  saveClientInformation(value) { this.savedClient = value }
  tokens() { return this.savedTokens }
  saveTokens(value) { this.savedTokens = value }
  state() { return this.savedState }
  saveCodeVerifier(value) { this.savedVerifier = value }
  codeVerifier() { return this.savedVerifier }
  saveDiscoveryState(value) { this.discovery = value }
  discoveryState() { return this.discovery }
  redirectToAuthorization(url) { this.authorizationUrl = url.toString() }
}

async function startCallback() {
  let provider
  let resolveCallback
  let rejectCallback
  const completed = new Promise((resolve, reject) => { resolveCallback = resolve; rejectCallback = reject })
  callbackServer = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== '/oauth/callback/notion') {
        res.writeHead(404).end('Not found')
        return
      }
      if (url.searchParams.get('state') !== provider.savedState) {
        res.writeHead(403).end('Invalid state')
        return
      }
      await auth(provider, {
        serverUrl: SERVER_URL,
        authorizationCode: url.searchParams.get('code'),
        iss: url.searchParams.get('iss') ?? undefined,
        fetchFn: guardedFetch,
      })
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('已连接，可以关闭此页')
      resolveCallback()
    })().catch(error => {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('授权失败，可以关闭此页')
      rejectCallback(error)
    })
  })
  const requestedPort = fixed ? FIXED_PORT : 0
  await new Promise((resolve, reject) => {
    const onError = error => reject(error)
    callbackServer.once('error', onError)
    callbackServer.listen(requestedPort, '127.0.0.1', () => {
      callbackServer.off('error', onError)
      resolve()
    })
  }).catch(error => {
    if (error.code === 'EADDRINUSE') throw new Error(`固定回调端口 ${FIXED_PORT} 被占用；未打开授权页`)
    throw error
  })
  const port = callbackServer.address().port
  const redirectUrl = `http://127.0.0.1:${port}/oauth/callback/notion`
  provider = new NotionProvider(redirectUrl)
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

try {
  const { provider, redirectUrl, completed } = await startCallback()
  const started = await auth(provider, { serverUrl: SERVER_URL, fetchFn: guardedFetch })
  assert.equal(started, 'REDIRECT')
  const authorizationUrl = new URL(provider.authorizationUrl)
  assert.equal(authorizationUrl.searchParams.get('client_id'), CLIENT_METADATA_URL)
  assert.equal(authorizationUrl.searchParams.get('redirect_uri'), redirectUrl)
  assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(registrationAttempts, 0)

  const preflight = await fetch(authorizationUrl, { redirect: 'manual', signal: AbortSignal.timeout(20_000) })
  const location = preflight.headers.get('location')
  const body = (await preflight.text()).replace(/\s+/g, ' ').slice(0, 500)
  const locationSummary = location ? (() => {
    const url = new URL(location, authorizationUrl)
    return { origin: url.origin, path: url.pathname, error: url.searchParams.get('error') }
  })() : null
  if (MODE === 'probe' || preflight.status >= 400) {
    console.log(JSON.stringify({
      ok: preflight.status < 400 && !locationSummary?.error,
      mode: 'probe',
      cimdUsed: true,
      dynamicRegistrationAttempts: registrationAttempts,
      randomPort: !fixed,
      redirectUri: redirectUrl,
      authorizationResponse: { status: preflight.status, location: locationSummary, bodyExcerpt: body },
    }, null, 2))
    if (preflight.status >= 400 || locationSummary?.error) process.exitCode = 1
  } else {
    await openBrowser(authorizationUrl.toString())
    console.log('Notion 授权页已在系统浏览器打开；请在浏览器中完成授权。')
    let timeoutTimer
    const timeout = new Promise((_, reject) => {
      timeoutTimer = setTimeout(() => reject(new Error('等待授权回调超时（240 秒）')), 240_000)
    })
    try {
      await Promise.race([completed, timeout])
    } finally {
      clearTimeout(timeoutTimer)
    }
    const toolsBeforeRefresh = await probeMcp(provider.savedTokens.access_token)
    const refreshed = await auth(provider, { serverUrl: SERVER_URL, fetchFn: guardedFetch })
    assert.equal(refreshed, 'AUTHORIZED')
    const toolsAfterRefresh = await probeMcp(provider.savedTokens.access_token)
    console.log(JSON.stringify({
      ok: true,
      mode: 'full',
      cimdUsed: true,
      dynamicRegistrationAttempts: registrationAttempts,
      randomPort: !fixed,
      tokenExchange: true,
      refresh: true,
      mcpProbeBeforeRefresh: toolsBeforeRefresh,
      mcpProbeAfterRefresh: toolsAfterRefresh,
      tokensPersisted: false,
    }, null, 2))
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
