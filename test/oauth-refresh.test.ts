import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CredentialGateway } from '../packages/connector-hub/src/host/gateway'
import { MountManager } from '../packages/connector-hub/src/host/mounts'
import { extractOAuthAccount, maskAccountName } from '../packages/connector-hub/src/host/oauth-account'
import {
  OAuthReauthorizationError,
  OAuthTokenRefresher,
} from '../packages/connector-hub/src/host/oauth-refresh'
import { MemorySecretStore } from '../packages/connector-hub/src/host/secrets'
import { ConnectorHubService } from '../packages/connector-hub/src/host/service'
import { ConnectorStore } from '../packages/connector-hub/src/host/store'
import type { StoredConnector } from '../packages/connector-hub/src/shared/config'
import { startOAuthFixtureServer, type OAuthFixtureServer } from './oauth-fixture-server'

const NOW = Date.parse('2026-11-04T00:00:00.000Z')
const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe('OAuth token refresh', () => {
  it('refreshes inside the five-minute window, rotates tokens and uses the new access token upstream', async () => {
    const server = await startOAuthFixtureServer()
    const home = await temporaryHome()
    cleanups.push(() => server.close())
    const secrets = new MemorySecretStore()
    await secrets.write('notion', secret({ expiresAt: NOW + 4 * 60_000, account: 'Workspace' }))
    const refresher = new OAuthTokenRefresher({ secrets, dshHome: home, now: () => new Date(NOW) })

    const refreshed = await refresher.validSecret('notion', connector(server.origin))
    expect(refreshed.tokens).toMatchObject({ access_token: 'access-1', refresh_token: 'refresh-1' })
    expect(refreshed.account).toEqual({ name: 'Workspace' })
    expect(server.refreshRequests).toHaveLength(1)
    expect(server.refreshRequests[0].get('refresh_token')).toBe('refresh-0')
    expect(server.refreshRequests[0].get('client_id')).toBe('https://example.com/client.json')
    expect(server.registrationRequests).toBe(0)
    expect(await secrets.read('notion')).toEqual(refreshed)

    const upstream: Array<{ authorization: string | null, body: string }> = []
    const gateway = await CredentialGateway.start({
      getConnector: () => connector(server.origin),
      secrets,
      oauthRefresher: refresher,
      fetchImpl: async (_input, init) => {
        upstream.push({
          authorization: new Headers(init?.headers).get('authorization'),
          body: Buffer.from(init?.body as ArrayBuffer).toString('utf8'),
        })
        return Response.json({ ok: true })
      },
    })
    cleanups.push(() => gateway.close())
    const endpoint = gateway.endpoint('notion')
    const response = await fetch(endpoint.url, {
      method: 'POST', headers: endpoint.headers, body: '{"jsonrpc":"2.0"}',
    })
    expect(response.status).toBe(200)
    expect(upstream).toEqual([{ authorization: 'Bearer access-1', body: '{"jsonrpc":"2.0"}' }])
    expect(server.refreshRequests).toHaveLength(1)
  })

  it('refreshes once after a 401 and retries exactly once with an identical request body', async () => {
    const server = await startOAuthFixtureServer()
    const home = await temporaryHome()
    cleanups.push(() => server.close())
    const secrets = new MemorySecretStore()
    await secrets.write('notion', secret({ expiresAt: NOW + 60 * 60_000 }))
    const refresher = new OAuthTokenRefresher({ secrets, dshHome: home, now: () => new Date(NOW) })
    const upstream: Array<{ authorization: string | null, body: string }> = []
    const gateway = await CredentialGateway.start({
      getConnector: () => connector(server.origin),
      secrets,
      oauthRefresher: refresher,
      fetchImpl: async (_input, init) => {
        const authorization = new Headers(init?.headers).get('authorization')
        upstream.push({ authorization, body: Buffer.from(init?.body as ArrayBuffer).toString('utf8') })
        return authorization === 'Bearer access-0'
          ? new Response('expired', { status: 401 })
          : Response.json({ ok: true })
      },
    })
    cleanups.push(() => gateway.close())

    const endpoint = gateway.endpoint('notion')
    const body = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { text: '保持不变' } })
    const response = await fetch(endpoint.url, { method: 'POST', headers: endpoint.headers, body })
    expect(response.status).toBe(200)
    expect(upstream).toEqual([
      { authorization: 'Bearer access-0', body },
      { authorization: 'Bearer access-1', body },
    ])
    expect(server.refreshRequests).toHaveLength(1)
    expect((await secrets.read('notion'))).toMatchObject({
      tokens: { access_token: 'access-1', refresh_token: 'refresh-1' },
    })
  })

  it('uses a shared file lock so concurrent refreshers issue only one refresh request', async () => {
    const server = await startOAuthFixtureServer()
    const home = await temporaryHome()
    cleanups.push(() => server.close())
    const secrets = new MemorySecretStore()
    await secrets.write('notion', secret({ expiresAt: NOW + 60_000 }))
    const options = { secrets, dshHome: home, now: () => new Date(NOW) }
    const desktop = new OAuthTokenRefresher(options)
    const web = new OAuthTokenRefresher(options)

    const [first, second] = await Promise.all([
      desktop.validSecret('notion', connector(server.origin)),
      web.validSecret('notion', connector(server.origin)),
    ])
    expect(server.refreshRequests).toHaveLength(1)
    expect(first.tokens.access_token).toBe('access-1')
    expect(second.tokens.access_token).toBe('access-1')
    expect(first.tokens.refresh_token).toBe('refresh-1')
    expect(second.tokens.refresh_token).toBe('refresh-1')
  })

  it('requires reauthorization on invalid_grant, unmounts without waiting in the callback and retains credentials', async () => {
    const server = await startOAuthFixtureServer()
    server.rejectRefresh = true
    const fixture = await startServiceFixture(server, secret({
      expiresAt: NOW + 60_000,
      account: '13812345678',
    }))
    cleanups.push(() => server.close())

    await expect(fixture.refresher.validSecret('notion', connector(server.origin)))
      .rejects.toBeInstanceOf(OAuthReauthorizationError)
    await waitFor(() => fixture.context.fibers[0]?.disposed === true)
    expect(fixture.reauthRequired.has('notion')).toBe(true)
    expect(await fixture.secrets.read('notion')).toMatchObject({
      tokens: { access_token: 'access-0', refresh_token: 'refresh-0' },
      account: { name: '13812345678' },
    })
    expect((await fixture.service.listConnectors())[0]).toMatchObject({
      status: 'reauth-required', account: '138****5678', tools: [],
    })
    await expect(fixture.service.remount('notion')).rejects.toMatchObject({ status: 409 })
  })

  it.each([200, 503])('deletes local OAuth state even when revocation returns HTTP %s', async revocationStatus => {
    const server = await startOAuthFixtureServer()
    server.revocationStatus = revocationStatus
    const fixture = await startServiceFixture(server, secret({ expiresAt: NOW + 60 * 60_000 }))
    cleanups.push(() => server.close())

    await expect(fixture.service.remove('notion')).resolves.toEqual({ removed: true })
    expect(server.revocationRequests).toBe(1)
    expect(await fixture.secrets.read('notion')).toBeNull()
    expect(await fixture.store.read()).toEqual({ schemaVersion: 1, connectors: {} })
    expect(await fixture.service.listConnectors()).toEqual([])
  })
})

describe('OAuth account display', () => {
  it('extracts Notion workspace and user names and Xmind id_token names', () => {
    expect(extractOAuthAccount({ workspace_name: 'Engineering', user: { name: 'Alice' } }))
      .toEqual({ name: 'Engineering' })
    expect(extractOAuthAccount({ owner: { user: { name: 'Alice' } } })).toEqual({ name: 'Alice' })
    const idToken = [
      Buffer.from('{"alg":"none"}').toString('base64url'),
      Buffer.from('{"name":"小明"}').toString('base64url'),
      'signature',
    ].join('.')
    expect(extractOAuthAccount({ id_token: idToken })).toEqual({ name: '小明' })
    expect(maskAccountName('13812345678')).toBe('138****5678')
    expect(maskAccountName('Alice')).toBe('Alice')
  })
})

async function startServiceFixture(server: OAuthFixtureServer, initialSecret: ReturnType<typeof secret>) {
  const home = await temporaryHome()
  const store = new ConnectorStore(home)
  await store.write({ schemaVersion: 1, connectors: { notion: connector(server.origin) } })
  const secrets = new MemorySecretStore()
  await secrets.write('notion', initialSecret)
  const context = fakeContext()
  const gateway = {
    endpoint: (id: string) => ({
      url: `http://127.0.0.1:40000/c/${id}/mcp`,
      headers: { 'X-Connector-Hub-Key': 'hub' },
    }),
  }
  const mounts = new MountManager({ context, gateway, mcpClient: {} })
  const reauthRequired = new Set<string>()
  const refresher = new OAuthTokenRefresher({
    secrets,
    dshHome: home,
    now: () => new Date(NOW),
    onReauthRequired: id => {
      reauthRequired.add(id)
      void mounts.unmount(id).catch(() => {})
    },
  })
  const service = new ConnectorHubService({
    store,
    secrets,
    mounts,
    gateway,
    oauthTokens: refresher,
    reauthRequired,
    catalog: {} as never,
  })
  await service.start()
  return { home, store, secrets, context, mounts, reauthRequired, refresher, service }
}

function connector(origin: string): StoredConnector {
  return {
    catalogRevision: 'oauth-test.1',
    remote: { type: 'streamable-http', url: `${origin}/mcp` },
    auth: {
      type: 'oauth',
      scope: 'openid mcp:connect',
      clientMetadataUrl: 'https://example.com/client.json',
      callbackPath: '/oauth/callback/notion',
      portPolicy: 'random',
    },
    enabled: true,
    addedAt: '2026-11-04T00:00:00.000Z',
  }
}

function secret(options: { expiresAt: number, account?: string }) {
  return {
    v: 1 as const,
    tokens: {
      access_token: 'access-0',
      refresh_token: 'refresh-0',
      expires_at: options.expiresAt,
      scope: 'openid mcp:connect',
    },
    ...(options.account ? { account: { name: options.account } } : {}),
  }
}

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'connector-hub-refresh-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  return home
}

function fakeContext() {
  const tools: string[] = []
  const fibers: Array<{ disposed: boolean }> = []
  const context = {
    fibers,
    logger: { warn: () => {} },
    get: () => ({ schemas: () => tools.map(name => ({ name })) }),
    plugin: (_plugin: unknown, config: { serverName: string }) => {
      const id = config.serverName
      const fiber = {
        state: 2,
        disposed: false,
        then: (onFulfilled: () => unknown) => Promise.resolve().then(onFulfilled),
        dispose: async () => {
          fiber.disposed = true
          fiber.state = 4
          for (let index = tools.length - 1; index >= 0; index--) {
            if (tools[index].startsWith(`mcp__${id}__`)) tools.splice(index, 1)
          }
        },
      }
      fibers.push(fiber)
      tools.push(`mcp__${id}__echo`)
      return fiber
    },
  }
  return context
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for asynchronous unmount')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
