import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CatalogService } from '../packages/connector-hub/src/host/catalog'
import { MountManager } from '../packages/connector-hub/src/host/mounts'
import { MemorySecretStore } from '../packages/connector-hub/src/host/secrets'
import { ConnectorHubService } from '../packages/connector-hub/src/host/service'
import { ConnectorStore } from '../packages/connector-hub/src/host/store'

const cleanups = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe('ConnectorHubService API Key lifecycle', () => {
  it('does not persist a rejected Key or leave config and mounts behind', async () => {
    const fixture = await startFixture({ probeCandidate: async () => probe(false, 'Invalid API Key') })

    await expect(fixture.service.connectApiKey('amap', 'wrong-secret')).rejects.toThrow('Invalid API Key')
    expect(await fixture.store.read()).toEqual({ schemaVersion: 1, connectors: {} })
    expect(await fixture.secrets.read('amap')).toBeNull()
    expect(fixture.context.fibers).toHaveLength(0)
  })

  it('saves and mounts only after a successful probe without exposing the Key', async () => {
    const seen = []
    const fixture = await startFixture({
      probeCandidate: async (id, connector, key) => {
        seen.push({ id, connector, key })
        return probe(true)
      },
    })

    const view = await fixture.service.connectApiKey('amap', 'api-secret')
    expect(view).toMatchObject({
      id: 'amap', status: 'connected', catalogRevision: '2026-11-03.2',
      tools: ['mcp__amap__echo'], lastProbe: { ok: true },
    })
    expect(seen[0].connector.remote.url).toBe('https://example.com/mcp')
    expect(await fixture.secrets.read('amap')).toEqual({ v: 1, apiKey: 'api-secret' })
    expect((await fixture.store.read()).connectors.amap.auth).toEqual(catalog().connectors[0].auth)
    expect(JSON.stringify(view)).not.toContain('api-secret')
    expect(JSON.stringify(await fixture.store.read())).not.toContain('api-secret')
  })

  it('keeps the previous Key and live connection when replacement probing fails', async () => {
    let currentProbe = true
    const fixture = await startFixture({ probeCandidate: async () => probe(currentProbe, 'new Key rejected') })
    await fixture.service.connectApiKey('amap', 'old-secret')
    const originalFiber = fixture.context.fibers[0]
    const originalAddedAt = (await fixture.store.read()).connectors.amap.addedAt
    currentProbe = false

    await expect(fixture.service.connectApiKey('amap', 'new-secret')).rejects.toThrow('new Key rejected')
    expect(await fixture.secrets.read('amap')).toEqual({ v: 1, apiKey: 'old-secret' })
    expect((await fixture.store.read()).connectors.amap.addedAt).toBe(originalAddedAt)
    expect(fixture.context.fibers[0]).toBe(originalFiber)
    expect(originalFiber.disposed).toBe(false)
  })

  it('replaces an existing Key only after success and preserves addedAt', async () => {
    const fixture = await startFixture()
    await fixture.service.connectApiKey('amap', 'old-secret')
    const originalAddedAt = (await fixture.store.read()).connectors.amap.addedAt

    const view = await fixture.service.connectApiKey('amap', 'new-secret')
    expect(view.status).toBe('connected')
    expect(view.addedAt).toBe(originalAddedAt)
    expect(await fixture.secrets.read('amap')).toEqual({ v: 1, apiKey: 'new-secret' })
    expect(fixture.context.fibers).toHaveLength(2)
    expect(fixture.context.fibers[0].disposed).toBe(true)
  })

  it('rolls back a new connection if mounting fails after a successful probe', async () => {
    const fixture = await startFixture()
    fixture.context.failMounts = true
    await expect(fixture.service.connectApiKey('amap', 'api-secret')).rejects.toThrow('simulated mount failure')

    expect(await fixture.store.read()).toEqual({ schemaVersion: 1, connectors: {} })
    expect(await fixture.secrets.read('amap')).toBeNull()
    expect(await fixture.service.listConnectors()).toEqual([])
  })

  it('disables without deleting credentials, re-enables, probes and removes all state', async () => {
    const fixture = await startFixture()
    await fixture.service.connectApiKey('amap', 'api-secret')

    const disabled = await fixture.service.setEnabled('amap', false)
    expect(disabled.status).toBe('disabled')
    expect(disabled.tools).toEqual([])
    expect(await fixture.secrets.read('amap')).toEqual({ v: 1, apiKey: 'api-secret' })

    const enabled = await fixture.service.setEnabled('amap', true)
    expect(enabled.status).toBe('connected')
    expect(enabled.tools).toEqual(['mcp__amap__echo'])
    const probed = await fixture.service.probe('amap')
    expect(probed.lastProbe).toMatchObject({ ok: true, tools: ['mcp__amap__echo'] })

    expect(await fixture.service.remove('amap')).toEqual({ removed: true })
    expect(await fixture.secrets.read('amap')).toBeNull()
    expect(await fixture.service.listConnectors()).toEqual([])
  })

  it('deduplicates concurrent probes for the same connector', async () => {
    let calls = 0
    let finishProbe
    const fixture = await startFixture({
      probeMounted: () => {
        calls++
        return new Promise(resolve => { finishProbe = resolve })
      },
    })
    await fixture.service.connectApiKey('amap', 'api-secret')

    const first = fixture.service.probe('amap')
    const second = fixture.service.probe('amap')
    expect(calls).toBe(1)
    finishProbe(probe(true))
    const results = await Promise.all([first, second])
    expect(results.map(result => result.lastProbe)).toEqual([probe(true), probe(true)])
    expect(calls).toBe(1)
  })

  it('does not block Key replacement or overwrite its probe with a stale result', async () => {
    const pending = []
    const fixture = await startFixture({
      probeMounted: () => new Promise(resolve => { pending.push(resolve) }),
    })
    await fixture.service.connectApiKey('amap', 'old-secret')

    const probing = fixture.service.probe('amap')
    expect(pending).toHaveLength(1)
    const replaced = await fixture.service.connectApiKey('amap', 'new-secret')
    expect(replaced.lastProbe).toMatchObject({ ok: true })
    expect(await fixture.secrets.read('amap')).toEqual({ v: 1, apiKey: 'new-secret' })

    pending.shift()(probe(false, 'stale probe'))
    const result = await probing
    expect(result.lastProbe).toMatchObject({ ok: true })
    expect(result.lastProbe.error).toBeNull()
  })

  it('does not block removal and discards a probe that finishes afterward', async () => {
    const pending = []
    const fixture = await startFixture({
      probeMounted: () => new Promise(resolve => { pending.push(resolve) }),
    })
    await fixture.service.connectApiKey('amap', 'api-secret')

    const probing = fixture.service.probe('amap')
    expect(pending).toHaveLength(1)
    expect(await fixture.service.remove('amap')).toEqual({ removed: true })
    pending.shift()(probe(false, 'removed connector'))
    await expect(probing).rejects.toMatchObject({ status: 404 })
    expect(await fixture.service.listConnectors()).toEqual([])
  })

  it('rejects unknown and non-API-Key catalog connectors', async () => {
    const fixture = await startFixture()
    await expect(fixture.service.connectApiKey('unknown', 'secret')).rejects.toMatchObject({ status: 404 })
    fixture.catalogValue.connectors[0].auth = { type: 'none' }
    await fixture.service.refreshCatalog()
    await expect(fixture.service.connectApiKey('amap', 'secret')).rejects.toThrow('does not use API Key')
    expect(await fixture.store.read()).toEqual({ schemaVersion: 1, connectors: {} })
  })

  it('reports catalog changes without modifying the connected remote copy', async () => {
    const fixture = await startFixture()
    await fixture.service.connectApiKey('amap', 'api-secret')
    fixture.catalogValue.connectors[0].remote.url = 'https://example.com/v2/mcp'

    const result = await fixture.service.refreshCatalog()
    expect(result.updates).toEqual([{ id: 'amap', kind: 'changed', fields: ['remote.url'] }])
    expect((await fixture.store.read()).connectors.amap.remote.url).toBe('https://example.com/mcp')
  })

  it('keeps saved remote, auth and revision when replacing a Key after a catalog update', async () => {
    const fixture = await startFixture()
    await fixture.service.connectApiKey('amap', 'old-secret')
    fixture.catalogValue.connectors[0].remote.url = 'https://example.com/v2/mcp'
    fixture.catalogValue.connectors[0].auth.name = 'ak'
    fixture.catalogValue.revision = '2026-11-06.1'
    await fixture.service.refreshCatalog()

    const view = await fixture.service.connectApiKey('amap', 'new-secret')
    const stored = (await fixture.store.read()).connectors.amap
    expect(stored).toMatchObject({
      catalogRevision: '2026-11-03.2',
      remote: { url: 'https://example.com/mcp' },
      auth: { name: 'key' },
    })
    expect(view.catalogUpdate).toEqual({ kind: 'changed', fields: ['auth.name', 'remote.url'] })
    expect(await fixture.secrets.read('amap')).toEqual({ v: 1, apiKey: 'new-secret' })
  })

  it('applies a catalog update with the saved Key and updates config and revision', async () => {
    const seen = []
    const fixture = await startFixture({
      probeCandidate: async (id, connector, key) => {
        seen.push({ connector, key })
        return probe(true)
      },
    })
    await fixture.service.connectApiKey('amap', 'saved-secret')
    fixture.catalogValue.connectors[0].remote.url = 'https://example.com/v2/mcp'
    fixture.catalogValue.connectors[0].auth.name = 'ak'
    fixture.catalogValue.revision = '2026-11-06.1'
    await fixture.service.refreshCatalog()

    const view = await fixture.service.connectApiKey('amap', undefined, { applyCatalogUpdate: true })
    const stored = (await fixture.store.read()).connectors.amap
    expect(seen.at(-1)).toMatchObject({ key: 'saved-secret', connector: {
      catalogRevision: '2026-11-06.1', remote: { url: 'https://example.com/v2/mcp' }, auth: { name: 'ak' },
    } })
    expect(stored).toMatchObject({
      catalogRevision: '2026-11-06.1', remote: { url: 'https://example.com/v2/mcp' }, auth: { name: 'ak' },
    })
    expect(view.catalogUpdate).toBeNull()
    expect(await fixture.secrets.read('amap')).toEqual({ v: 1, apiKey: 'saved-secret' })
  })

  it('preserves old config, credentials and mounts when applying an update fails', async () => {
    let accept = true
    const fixture = await startFixture({ probeCandidate: async () => probe(accept, 'update rejected') })
    await fixture.service.connectApiKey('amap', 'old-secret')
    const originalFiber = fixture.context.fibers[0]
    fixture.catalogValue.connectors[0].remote.url = 'https://example.com/v2/mcp'
    fixture.catalogValue.revision = '2026-11-06.1'
    await fixture.service.refreshCatalog()
    accept = false

    await expect(fixture.service.connectApiKey('amap', undefined, { applyCatalogUpdate: true })).rejects.toThrow('update rejected')
    expect((await fixture.store.read()).connectors.amap).toMatchObject({
      catalogRevision: '2026-11-03.2', remote: { url: 'https://example.com/mcp' },
    })
    expect(await fixture.secrets.read('amap')).toEqual({ v: 1, apiKey: 'old-secret' })
    expect(fixture.context.fibers[0]).toBe(originalFiber)
    expect(originalFiber.disposed).toBe(false)
  })

  it('allows replacing a Key after the connector is removed from the catalog', async () => {
    const fixture = await startFixture()
    await fixture.service.connectApiKey('amap', 'old-secret')
    fixture.catalogValue.connectors = []
    await fixture.service.refreshCatalog()

    const view = await fixture.service.connectApiKey('amap', 'new-secret')
    expect(view.catalogUpdate).toEqual({ kind: 'removed', fields: [] })
    expect(view.remote.url).toBe('https://example.com/mcp')
    expect(view.catalogRevision).toBe('2026-11-03.2')
    expect(await fixture.secrets.read('amap')).toEqual({ v: 1, apiKey: 'new-secret' })
  })

  it('uses saved OAuth config for reauthorization and new config only when applying an update', async () => {
    const attempts = []
    const oauth = {
      start: async (id, candidate, complete) => {
        attempts.push({ candidate, complete })
        return { attemptId: `attempt-${attempts.length}`, authorizationUrl: 'https://example.com/authorize' }
      },
    }
    const fixture = await startFixture({ oauth })
    await fixture.service.connectApiKey('amap', 'old-secret')
    const oauthAuth = {
      type: 'oauth', scope: 'old-scope', clientId: 'client-id',
      callbackPath: '/oauth/callback/amap', portPolicy: 'random',
    }
    await fixture.store.update(draft => { draft.connectors.amap.auth = structuredClone(oauthAuth) })
    fixture.catalogValue.connectors[0].auth = structuredClone(oauthAuth)
    await fixture.service.refreshCatalog()
    fixture.catalogValue.connectors[0].remote.url = 'https://example.com/v2/mcp'
    fixture.catalogValue.connectors[0].auth.scope = 'new-scope'
    fixture.catalogValue.revision = '2026-11-06.1'
    await fixture.service.refreshCatalog()

    await fixture.service.startOAuth('amap')
    expect(attempts[0].candidate).toMatchObject({
      catalogRevision: '2026-11-03.2', remote: { url: 'https://example.com/mcp' }, auth: { scope: 'old-scope' },
    })
    await fixture.service.startOAuth('amap', { applyCatalogUpdate: true })
    expect(attempts[1].candidate).toMatchObject({
      catalogRevision: '2026-11-06.1', remote: { url: 'https://example.com/v2/mcp' }, auth: { scope: 'new-scope' },
    })

    await attempts[1].complete({ v: 1, tokens: { access_token: 'access', expires_at: Date.now() + 60_000 } })
    expect((await fixture.store.read()).connectors.amap).toMatchObject({
      catalogRevision: '2026-11-06.1', remote: { url: 'https://example.com/v2/mcp' }, auth: { scope: 'new-scope' },
    })
  })

  it('rejects applying a catalog update when there is no change', async () => {
    const fixture = await startFixture()
    await fixture.service.connectApiKey('amap', 'api-secret')

    await expect(fixture.service.connectApiKey('amap', undefined, { applyCatalogUpdate: true }))
      .rejects.toMatchObject({ status: 400 })
  })
})

async function startFixture(options = {}) {
  const home = await mkdtemp(join(tmpdir(), 'connector-hub-service-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const catalogValue = catalog()
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
    oauth: options.oauth,
    probeCandidate: options.probeCandidate ?? (async () => probe(true)),
    probeOAuthCandidate: options.probeOAuthCandidate ?? (async () => probe(true)),
    probeMounted: options.probeMounted ?? (async id => ({ ...probe(true), tools: [`mcp__${id}__echo`] })),
    now: () => new Date('2026-11-03T10:30:00.000Z'),
  })
  await service.start()
  return { service, store, secrets, mounts, context, catalogValue }
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
      const promise = context.failMounts
        ? new Promise((_, reject) => { rejectPromise = reject })
        : Promise.resolve()
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

function probe(ok, error = null) {
  return {
    ok,
    checkedAt: '2026-11-03T10:29:00.000Z',
    durationMs: 1,
    tools: ok ? ['mcp__amap__echo'] : [],
    server: null,
    error,
  }
}

function catalog() {
  return {
    schemaVersion: 1,
    revision: '2026-11-03.2',
    connectors: [{
      id: 'amap',
      name: { zh: '高德地图', en: 'Amap' },
      description: { zh: '地图', en: 'Maps' },
      icon: `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`,
      homepage: 'https://example.com', publisher: 'Amap', official: true,
      remote: { type: 'streamable-http', url: 'https://example.com/mcp' },
      auth: {
        type: 'api-key', in: 'query', name: 'key',
        label: { zh: 'Key', en: 'Key' }, helpUrl: 'https://example.com/key',
      },
    }],
  }
}
