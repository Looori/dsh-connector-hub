import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CatalogService } from '../packages/connector-hub/src/host/catalog'
import { MountManager } from '../packages/connector-hub/src/host/mounts'
import { OAuthManager } from '../packages/connector-hub/src/host/oauth'
import { MemorySecretStore } from '../packages/connector-hub/src/host/secrets'
import { ConnectorHubService } from '../packages/connector-hub/src/host/service'
import { ConnectorStore } from '../packages/connector-hub/src/host/store'
import { startOAuthFixtureServer } from './oauth-fixture-server'

const cleanups = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe('OAuth authorization lifecycle', () => {
  it('uses CIMD, a random loopback port, PKCE, state, resource and iss without dynamic registration', async () => {
    const fixture = await startFixture()
    const started = await fixture.service.startOAuth('notion')
    const authorization = new URL(started.authorizationUrl)
    const redirect = new URL(authorization.searchParams.get('redirect_uri'))

    expect(authorization.searchParams.get('client_id')).toBe('https://looori.github.io/dsh-connector-hub/oauth/notion/client.json')
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorization.searchParams.get('code_challenge')).toBeTruthy()
    expect(authorization.searchParams.get('resource')).toBe(`${fixture.server.origin}/mcp`)
    expect(authorization.searchParams.get('prompt')).toBe('consent')
    expect(redirect.pathname).toBe('/oauth/callback/notion')
    expect(redirect.port).not.toBe('')

    const wrongState = new URL(redirect)
    wrongState.searchParams.set('code', 'oauth-code')
    wrongState.searchParams.set('state', 'wrong-state')
    wrongState.searchParams.set('iss', fixture.server.origin)
    expect((await fetch(wrongState)).status).toBe(403)
    expect(fixture.server.tokenRequests).toHaveLength(0)

    await completeAuthorization(fixture, started, authorization)
    expect(fixture.server.tokenRequests).toHaveLength(1)
    const exchange = fixture.server.tokenRequests[0]
    expect(exchange.get('code')).toBe('oauth-code')
    expect(exchange.get('code_verifier')).toBeTruthy()
    expect(exchange.get('redirect_uri')).toBe(redirect.toString())
    expect(exchange.get('client_id')).toBe('https://looori.github.io/dsh-connector-hub/oauth/notion/client.json')
    expect(fixture.server.registrationRequests).toBe(0)
    expect(await fixture.secrets.read('notion')).toEqual({
      v: 1,
      tokens: {
        access_token: 'access-1', refresh_token: 'refresh-1',
        expires_at: Date.parse('2026-11-04T01:00:00.000Z'), scope: 'openid mcp:connect',
      },
    })
    expect((await fixture.store.read()).connectors.notion.auth).toEqual(fixture.catalogValue.connectors[0].auth)
    expect((await fixture.service.listConnectors())[0]).toMatchObject({ id: 'notion', status: 'connected' })
  })

  it('uses the shared public client and exact fixed callback port', async () => {
    const fixture = await startFixture({ fixed: true })
    const started = await fixture.service.startOAuth('notion')
    const authorization = new URL(started.authorizationUrl)
    const redirect = new URL(authorization.searchParams.get('redirect_uri'))

    expect(authorization.searchParams.get('client_id')).toBe('shared-public-client')
    expect(redirect.port).toBe(String(fixture.fixedPort))
    await completeAuthorization(fixture, started, authorization)
    expect(fixture.server.registrationRequests).toBe(0)
    expect(fixture.server.tokenRequests[0].get('client_id')).toBe('shared-public-client')
  })

  it('uses a shared public client with Weibo read-only scope and fixed callback', async () => {
    const fixture = await startFixture({ fixed: true })
    const connector = fixture.catalogValue.connectors[0]
    connector.id = 'weibo-cli'
    connector.auth.scope = 'mcp read'
    connector.auth.callbackPath = '/oauth/callback/weibo-cli'

    const started = await fixture.service.startOAuth('weibo-cli')
    const authorization = new URL(started.authorizationUrl)
    expect(authorization.searchParams.get('client_id')).toBe('shared-public-client')
    expect(authorization.searchParams.get('scope')).toBe('mcp read')
    expect(new URL(authorization.searchParams.get('redirect_uri')).pathname).toBe('/oauth/callback/weibo-cli')
    await completeAuthorization(fixture, started, authorization)
    expect(fixture.server.registrationRequests).toBe(0)
    expect(fixture.server.tokenRequests[0].get('client_id')).toBe('shared-public-client')

    await fixture.service.remove('weibo-cli')
    expect(await fixture.secrets.read('weibo-cli')).toBeNull()
  })

  it('uses a shared public client with Canva read-only scopes and fixed callback', async () => {
    const fixture = await startFixture({ fixed: true })
    const connector = fixture.catalogValue.connectors[0]
    connector.id = 'canva'
    connector.auth.scope = 'design:meta:read design:content:read folder:read asset:read'
    connector.auth.callbackPath = '/oauth/callback/canva'

    const started = await fixture.service.startOAuth('canva')
    const authorization = new URL(started.authorizationUrl)
    expect(authorization.searchParams.get('client_id')).toBe('shared-public-client')
    expect(authorization.searchParams.get('scope')).toBe('design:meta:read design:content:read folder:read asset:read')
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
    expect(new URL(authorization.searchParams.get('redirect_uri')).pathname).toBe('/oauth/callback/canva')
    await completeAuthorization(fixture, started, authorization)
    expect(fixture.server.registrationRequests).toBe(0)
    expect(fixture.server.tokenRequests[0].get('client_id')).toBe('shared-public-client')
  })

  it('uses a shared public client with CamScanner scope and general agent header', async () => {
    const fixture = await startFixture({ fixed: true })
    const connector = fixture.catalogValue.connectors[0]
    connector.id = 'camscanner-mcp'
    connector.auth.scope = 'mcp:tools'
    connector.auth.callbackPath = '/oauth/callback/camscanner-mcp'
    connector.remote.headers = { 'X-IS-AGENT': 'general' }

    const started = await fixture.service.startOAuth('camscanner-mcp')
    const authorization = new URL(started.authorizationUrl)
    expect(authorization.searchParams.get('client_id')).toBe('shared-public-client')
    expect(authorization.searchParams.get('scope')).toBe('mcp:tools')
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
    expect(new URL(authorization.searchParams.get('redirect_uri')).pathname).toBe('/oauth/callback/camscanner-mcp')
    await completeAuthorization(fixture, started, authorization)
    expect(fixture.server.registrationRequests).toBe(0)
    expect(fixture.server.tokenRequests[0].get('client_id')).toBe('shared-public-client')
    expect((await fixture.store.read()).connectors['camscanner-mcp'].remote.headers).toEqual({ 'X-IS-AGENT': 'general' })
  })

  it('uses a shared public client with QQ Mail read-only scopes and fixed callback', async () => {
    const fixture = await startFixture({ fixed: true })
    const connector = fixture.catalogValue.connectors[0]
    connector.id = 'qq-mail'
    connector.auth.scope = 'alias:read mail:read'
    connector.auth.callbackPath = '/oauth/callback/qq-mail'

    const started = await fixture.service.startOAuth('qq-mail')
    const authorization = new URL(started.authorizationUrl)
    expect(authorization.searchParams.get('client_id')).toBe('shared-public-client')
    expect(authorization.searchParams.get('scope')).toBe('alias:read mail:read')
    expect(authorization.searchParams.get('code_challenge_method')).toBe('S256')
    expect(new URL(authorization.searchParams.get('redirect_uri')).pathname).toBe('/oauth/callback/qq-mail')
    await completeAuthorization(fixture, started, authorization)
    expect(fixture.server.registrationRequests).toBe(0)
    expect(fixture.server.tokenRequests[0].get('client_id')).toBe('shared-public-client')
  })

  it('reports a busy fixed port before returning an authorization URL', async () => {
    const blocker = createServer()
    await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve))
    const port = blocker.address().port
    cleanups.push(() => new Promise(resolve => {
      blocker.close(resolve)
      blocker.closeAllConnections()
    }))
    const fixture = await startFixture({ fixed: true, fixedPort: port })

    await expect(fixture.service.startOAuth('notion')).rejects.toMatchObject({
      status: 409, message: `Fixed OAuth callback port ${port} is already in use`,
    })
    expect(fixture.server.tokenRequests).toHaveLength(0)
    expect(await fixture.store.read()).toEqual({ schemaVersion: 1, connectors: {} })
  })

  it('rejects an issuer mismatch before token exchange and leaves no state behind', async () => {
    const fixture = await startFixture()
    const started = await fixture.service.startOAuth('notion')
    const authorization = new URL(started.authorizationUrl)
    const callback = new URL(authorization.searchParams.get('redirect_uri'))
    callback.searchParams.set('code', 'oauth-code')
    callback.searchParams.set('state', authorization.searchParams.get('state'))
    callback.searchParams.set('iss', 'https://attacker.example')

    expect((await fetch(callback)).status).toBe(400)
    expect(fixture.service.oauthStatus(started.attemptId)).toMatchObject({ status: 'failed' })
    expect(fixture.server.tokenRequests).toHaveLength(0)
    expect(await fixture.store.read()).toEqual({ schemaVersion: 1, connectors: {} })
    expect(await fixture.secrets.read('notion')).toBeNull()
  })

  it('cancels and times out without persisting partial connectors', async () => {
    const cancelled = await startFixture()
    const started = await cancelled.service.startOAuth('notion')
    expect(await cancelled.service.cancelOAuth(started.attemptId)).toEqual({ cancelled: true })
    expect(cancelled.service.oauthStatus(started.attemptId)).toMatchObject({
      status: 'failed', error: 'OAuth authorization cancelled',
    })
    expect(await cancelled.store.read()).toEqual({ schemaVersion: 1, connectors: {} })

    const timedOut = await startFixture({ timeoutMs: 30 })
    const attempt = await timedOut.service.startOAuth('notion')
    await waitFor(() => timedOut.service.oauthStatus(attempt.attemptId).status === 'failed')
    expect(timedOut.service.oauthStatus(attempt.attemptId).error).toBe('OAuth authorization timed out')
    expect(await timedOut.store.read()).toEqual({ schemaVersion: 1, connectors: {} })
  })

  it('rolls back a new authorization when mounting fails', async () => {
    const fixture = await startFixture()
    fixture.context.failMounts = true
    const started = await fixture.service.startOAuth('notion')
    const authorization = new URL(started.authorizationUrl)
    const callback = callbackUrl(started, authorization, fixture.server.origin)

    expect((await fetch(callback)).status).toBe(400)
    expect(fixture.service.oauthStatus(started.attemptId).status).toBe('failed')
    expect(await fixture.store.read()).toEqual({ schemaVersion: 1, connectors: {} })
    expect(await fixture.secrets.read('notion')).toBeNull()
    expect(await fixture.service.listConnectors()).toEqual([])
  })

  it('keeps existing tokens and mounts when reauthorization probing fails', async () => {
    let probeOk = true
    const fixture = await startFixture({ probeOAuthCandidate: async () => probe(probeOk) })
    const first = await fixture.service.startOAuth('notion')
    await completeAuthorization(fixture, first, new URL(first.authorizationUrl))
    const originalFiber = fixture.context.fibers[0]
    const originalSecret = await fixture.secrets.read('notion')
    probeOk = false

    const second = await fixture.service.startOAuth('notion')
    expect((await fetch(callbackUrl(second, new URL(second.authorizationUrl), fixture.server.origin))).status).toBe(400)
    expect(await fixture.secrets.read('notion')).toEqual(originalSecret)
    expect(fixture.context.fibers[0]).toBe(originalFiber)
    expect(originalFiber.disposed).toBe(false)
    expect((await fixture.store.read()).connectors.notion.addedAt).toBe('2026-11-04T00:00:00.000Z')
  })

  it('runs device authorization through pending and slow_down without dynamic registration', async () => {
    const fixture = await startFixture({ device: true, timeoutMs: 10_000 })
    fixture.server.devicePollOutcomes.push('authorization_pending', 'slow_down')
    const started = await fixture.service.startOAuth('github')

    expect(started).toMatchObject({
      authorizationUrl: `${fixture.server.origin}/device`, userCode: 'ABCD-EFGH',
    })
    await waitFor(() => fixture.service.oauthStatus(started.attemptId).status === 'success', 6_000)
    expect(fixture.server.deviceRequests).toHaveLength(1)
    expect(fixture.server.deviceRequests[0].get('client_id')).toBe('shared-public-client')
    expect(fixture.server.deviceRequests[0].get('scope')).toBe('offline_access')
    expect(fixture.server.devicePollRequests).toHaveLength(3)
    expect(fixture.server.devicePollRequests[0].get('device_code')).toBe('device-code')
    expect(fixture.server.registrationRequests).toBe(0)
    expect(await fixture.secrets.read('github')).toEqual({
      v: 1,
      tokens: {
        access_token: 'access-1', refresh_token: 'refresh-1',
        expires_at: Date.parse('2026-11-04T01:00:00.000Z'), scope: 'openid mcp:connect',
      },
    })
    expect((await fixture.store.read()).connectors.github.auth).toMatchObject({ flow: 'device' })
  }, 7_000)

  it('cancels device authorization without persisting partial state', async () => {
    const fixture = await startFixture({ device: true })
    const started = await fixture.service.startOAuth('github')
    await fixture.service.cancelOAuth(started.attemptId)

    expect(fixture.service.oauthStatus(started.attemptId)).toMatchObject({
      status: 'failed', error: 'OAuth authorization cancelled',
    })
    expect(await fixture.store.read()).toEqual({ schemaVersion: 1, connectors: {} })
    expect(await fixture.secrets.read('github')).toBeNull()
  })

  it.each([
    ['access_denied', 'OAuth authorization was denied'],
    ['expired_token', 'OAuth device code expired'],
  ])('reports device authorization failure %s', async (outcome, message) => {
    const fixture = await startFixture({ device: true })
    fixture.server.devicePollOutcomes.push(outcome)
    const started = await fixture.service.startOAuth('github')

    await waitFor(() => fixture.service.oauthStatus(started.attemptId).status === 'failed')
    expect(fixture.service.oauthStatus(started.attemptId).error).toBe(message)
    expect(await fixture.store.read()).toEqual({ schemaVersion: 1, connectors: {} })
  })

  it('migrates an existing API Key connector after successful device authorization', async () => {
    const fixture = await startFixture({ device: true })
    const item = fixture.catalogValue.connectors.find(connector => connector.id === 'github')
    await fixture.store.update(draft => {
      draft.connectors.github = {
        catalogRevision: 'api-key.1',
        remote: structuredClone(item.remote),
        auth: {
          type: 'api-key', in: 'header', name: 'Authorization', valueTemplate: 'Bearer ${value}',
          label: { zh: 'Key', en: 'Key' }, helpUrl: 'https://example.com/key',
        },
        enabled: true,
        addedAt: '2026-11-03T00:00:00.000Z',
      }
    })
    await fixture.secrets.write('github', { v: 1, apiKey: 'old-api-key' })
    const started = await fixture.service.startOAuth('github', { applyCatalogUpdate: true })
    await waitFor(() => fixture.service.oauthStatus(started.attemptId).status === 'success')

    expect((await fixture.store.read()).connectors.github).toMatchObject({
      catalogRevision: 'oauth-test.1', auth: { type: 'oauth', flow: 'device' },
    })
    expect(await fixture.secrets.read('github')).toMatchObject({ tokens: { access_token: 'access-1' } })
  })
})

async function completeAuthorization(fixture, started, authorization) {
  const response = await fetch(callbackUrl(started, authorization, fixture.server.origin))
  expect(response.status, fixture.service.oauthStatus(started.attemptId).error).toBe(200)
  expect(fixture.service.oauthStatus(started.attemptId)).toMatchObject({ status: 'success', error: null })
}

function callbackUrl(started, authorization, issuer) {
  const callback = new URL(authorization.searchParams.get('redirect_uri'))
  callback.searchParams.set('code', 'oauth-code')
  callback.searchParams.set('state', authorization.searchParams.get('state'))
  callback.searchParams.set('iss', issuer)
  return callback
}

async function startFixture(options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'connector-hub-oauth-'))
  const server = await startOAuthFixtureServer({ includeDeviceConnector: options.device === true })
  const oauth = new OAuthManager({
    timeoutMs: options.timeoutMs ?? 1000,
    now: () => new Date('2026-11-04T00:00:00.000Z'),
  })
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  cleanups.push(() => server.close())
  cleanups.push(() => oauth.close())
  let fixedPort = options.fixedPort
  if (options.fixed && fixedPort === undefined) {
    const reservation = createServer()
    await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve))
    fixedPort = reservation.address().port
    await new Promise(resolve => reservation.close(resolve))
  }
  const catalogValue = catalog(server.origin, options.fixed, fixedPort)
  if (options.device) catalogValue.connectors.push(structuredClone(server.catalog.connectors[1]))
  const catalogService = new CatalogService({
    dshHome: home,
    snapshot: catalogValue,
    fetchImpl: async () => Response.json(catalogValue),
  })
  const store = new ConnectorStore(home)
  const secrets = new MemorySecretStore()
  const context = fakeContext()
  const gateway = { endpoint: id => ({ url: `http://127.0.0.1:40000/c/${id}/mcp`, headers: { 'X-Connector-Hub-Key': 'hub' } }) }
  const mounts = new MountManager({ context, gateway, mcpClient: {} })
  const service = new ConnectorHubService({
    catalog: catalogService,
    store,
    secrets,
    mounts,
    gateway,
    oauth,
    probeOAuthCandidate: options.probeOAuthCandidate ?? (async id => ({ ...probe(true), tools: [`mcp__${id}__echo`] })),
    now: () => new Date('2026-11-04T00:00:00.000Z'),
  })
  await service.start()
  return { service, store, secrets, mounts, context, catalogValue, server, oauth, fixedPort }
}

function fakeContext() {
  const tools = []
  const fibers = []
  const context = {
    fibers,
    failMounts: false,
    logger: { warn: () => {} },
    get: () => ({ schemas: () => tools.map(name => ({ name })) }),
    plugin: (_plugin, config) => {
      const id = config.serverName
      let rejectPromise
      const promise = context.failMounts ? new Promise((_, reject) => { rejectPromise = reject }) : Promise.resolve()
      const fiber = {
        state: context.failMounts ? 3 : 2,
        disposed: false,
        then: (onFulfilled, onRejected) => promise.then(onFulfilled, onRejected),
        dispose: async () => {
          fiber.disposed = true
          fiber.state = 4
          for (let index = tools.length - 1; index >= 0; index--) {
            if (tools[index].startsWith(`mcp__${id}__`)) tools.splice(index, 1)
          }
        },
      }
      fibers.push(fiber)
      if (context.failMounts) queueMicrotask(() => rejectPromise(new Error('simulated mount failure')))
      else tools.push(`mcp__${id}__echo`)
      return fiber
    },
  }
  return context
}

function probe(ok) {
  return { ok, checkedAt: '2026-11-04T00:00:00.000Z', durationMs: 1, tools: [], server: null, error: ok ? null : 'OAuth probe rejected' }
}

function catalog(origin, fixed = false, fixedPort) {
  return {
    schemaVersion: 1,
    revision: 'oauth-test.1',
    connectors: [{
      id: 'notion',
      name: { zh: 'Notion', en: 'Notion' },
      description: { zh: '测试', en: 'Test' },
      icon: 'data:image/svg+xml;base64,PHN2Zy8+',
      homepage: 'https://example.com', publisher: 'Test', official: true,
      remote: { type: 'streamable-http', url: `${origin}/mcp` },
      auth: {
        type: 'oauth', scope: 'openid mcp:connect', authorizationParams: { prompt: 'consent' },
        ...(fixed ? { clientId: 'shared-public-client' } : { clientMetadataUrl: 'https://looori.github.io/dsh-connector-hub/oauth/notion/client.json' }),
        callbackPath: '/oauth/callback/notion',
        ...(fixed ? { portPolicy: 'fixed', fixedPort } : { portPolicy: 'random' }),
      },
    }],
  }
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for OAuth state')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
