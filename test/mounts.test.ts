import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { MountManager } from '../packages/connector-hub/src/host/mounts'

class FakeFiber {
  state = 1
  disposed = false
  private readonly promise
  private resolvePromise
  private rejectPromise

  constructor(readonly config, readonly tools, readonly onSucceed) {
    this.promise = new Promise((resolve, reject) => {
      this.resolvePromise = resolve
      this.rejectPromise = reject
    })
  }

  then(onFulfilled, onRejected) {
    return this.promise.then(onFulfilled, onRejected)
  }

  succeed(toolNames = ['echo']) {
    this.state = 2
    for (const name of toolNames) this.tools.push(`mcp__${this.config.serverName}__${name}`)
    this.onSucceed(this)
    this.resolvePromise()
  }

  fail(error) {
    this.state = 3
    this.rejectPromise(error)
  }

  async dispose() {
    this.disposed = true
    this.state = 4
    const prefix = `mcp__${this.config.serverName}__`
    for (let index = this.tools.length - 1; index >= 0; index--) {
      if (this.tools[index].startsWith(prefix)) this.tools.splice(index, 1)
    }
  }
}

function fixture(options = {}) {
  const tools = []
  const warnings = []
  const fibers = []
  const mountedConfigs = []
  const context = {
    logger: { warn: (...args) => warnings.push(args) },
    get: name => name === 'tools' && !options.registryUnavailable
      ? { schemas: () => tools.map(name => ({ name })) }
      : undefined,
    plugin: (_plugin, config) => {
      if (options.mountError) throw options.mountError
      mountedConfigs.push(config)
      const fiber = new FakeFiber(config, tools, options.onSucceed ?? (() => {}))
      fibers.push(fiber)
      if (options.autoStart) queueMicrotask(() => fiber.succeed())
      return fiber
    },
  }
  const gateway = {
    endpoint: id => ({
      url: `http://127.0.0.1:43210/c/${id}/mcp`,
      headers: { 'X-Connector-Hub-Key': 'in-memory-hub-key' },
    }),
  }
  const manager = new MountManager({
    context,
    gateway,
    mcpClient: {},
    now: () => new Date('2026-11-03T09:00:00.000Z'),
  })
  return { manager, context, gateway, tools, warnings, fibers, mountedConfigs }
}

describe('MountManager', () => {
  it('mounts through the gateway and transitions from connecting to connected', async () => {
    const { manager, fibers, mountedConfigs } = fixture()
    const connectors = { amap: connector('amap') }

    const pending = await manager.mount('amap', connectors.amap)
    expect(pending).toMatchObject({ status: 'connecting', phase: 'loading', tools: [] })
    expect(mountedConfigs[0]).toEqual({
      transport: 'streamable-http',
      serverName: 'amap',
      url: 'http://127.0.0.1:43210/c/amap/mcp',
      headers: { 'X-Connector-Hub-Key': 'in-memory-hub-key' },
      failOnStartupError: true,
    })
    expect(JSON.stringify(mountedConfigs[0])).not.toContain('api-secret')

    fibers[0].succeed(['maps_geo'])
    await delay(0)
    expect(manager.list(connectors)[0]).toMatchObject({
      status: 'connected',
      phase: 'active',
      tools: ['mcp__amap__maps_geo'],
      mountedAt: '2026-11-03T09:00:00.000Z',
      error: null,
    })
  })

  it('contains synchronous mount failures without a specialized error code', async () => {
    const { manager, warnings } = fixture({ mountError: new Error('serverName already in use') })
    const connectors = { notion: connector('notion') }

    const result = await manager.mount('notion', connectors.notion)
    expect(result.status).toBe('failed')
    expect(result.phase).toBe('failed')
    expect(result.error).toContain('already in use')
    expect(result.errorCode).toBeNull()
    expect(warnings).toHaveLength(1)
  })

  it('classifies the rc.5 duplicate serverName error', async () => {
    const message = 'mcp-client: serverName "amap" is already in use by another mcp-client instance — pick a unique serverName in cordis.yml'
    const { manager } = fixture({ mountError: new Error(message) })

    const result = await manager.mount('amap', connector('amap'))
    expect(result).toMatchObject({
      status: 'failed',
      error: message,
      errorCode: 'server-name-conflict',
    })
  })

  it('sanitizes asynchronous mount failures without leaking credentials', async () => {
    const { manager, fibers, warnings } = fixture()
    const connectors = { amap: connector('amap') }
    await manager.mount('amap', connectors.amap)
    fibers[0].fail(new Error('fetch https://example.com/mcp?key=api-secret failed'))
    await delay(0)

    const result = manager.list(connectors)[0]
    expect(result.status).toBe('failed')
    expect(result.error).toContain('key=REDACTED')
    expect(result.error).not.toContain('api-secret')
    expect(JSON.stringify(warnings)).not.toContain('api-secret')
  })

  it('remounts after disposal and preserves fully qualified tool names', async () => {
    const { manager, fibers } = fixture()
    const connectors = { amap: connector('amap') }
    await manager.mount('amap', connectors.amap)
    fibers[0].succeed(['maps_geo'])
    await delay(0)
    const before = manager.list(connectors)[0].tools

    const remounting = manager.remount('amap', connectors.amap)
    await waitFor(() => fibers.length === 2)
    expect(fibers[0].disposed).toBe(true)
    fibers[1].succeed(['maps_geo'])
    const after = await remounting

    expect(after.status).toBe('connected')
    expect(after.tools).toEqual(before)
    expect(after.generation).toBeGreaterThan(1)
  })

  it('reconciles disabled, removed, new and changed connectors independently', async () => {
    const { manager, fibers, mountedConfigs } = fixture({ autoStart: true })
    const amap = connector('amap')
    const baidu = connector('baidu-map')
    await manager.reconcile({ amap, baidu })
    await delay(0)
    await manager.reconcile({ amap, baidu })
    expect(mountedConfigs).toHaveLength(2)

    const changedAmap = {
      ...amap,
      remote: { type: 'streamable-http', url: 'https://example.com/amap/v2/mcp' },
    }
    const notion = connector('notion')
    await manager.reconcile({ amap: changedAmap, notion })
    await delay(0)

    expect(fibers[0].disposed).toBe(true)
    expect(fibers[1].disposed).toBe(true)
    expect(mountedConfigs).toHaveLength(4)
    expect(mountedConfigs.slice(2).map(config => config.serverName).sort()).toEqual(['amap', 'notion'])
    expect(manager.list({ amap: changedAmap, notion }).every(item => item.status === 'connected')).toBe(true)

    await manager.reconcile({ amap: { ...changedAmap, enabled: false }, notion })
    expect(manager.list({ amap: { ...changedAmap, enabled: false }, notion })
      .find(item => item.id === 'amap').status).toBe('disabled')
    expect(manager.list({ amap: { ...changedAmap, enabled: false }, notion })
      .find(item => item.id === 'notion').status).toBe('connected')
  })

  it('combines probe health and registry availability into connector status', async () => {
    const healthy = fixture({ autoStart: true })
    const connectors = { amap: connector('amap') }
    await healthy.manager.reconcile(connectors)
    await delay(0)
    expect(healthy.manager.list(connectors, {
      amap: { ok: false, error: 'upstream returned 401' },
    })[0]).toMatchObject({ status: 'failed', error: 'upstream returned 401' })

    const unavailable = fixture({ autoStart: true, registryUnavailable: true })
    await unavailable.manager.reconcile(connectors)
    await delay(0)
    expect(unavailable.manager.list(connectors)[0]).toMatchObject({
      status: 'failed',
      error: 'DSH tool registry is unavailable',
      tools: [],
    })
  })
})

function connector(id) {
  return {
    catalogRevision: '2026-11-03.1',
    remote: { type: 'streamable-http', url: `https://example.com/${id}/mcp` },
    auth: {
      type: 'api-key', in: 'header', name: 'ak',
      label: { zh: 'Key', en: 'Key' }, helpUrl: 'https://example.com/key',
    },
    enabled: true,
    addedAt: '2026-11-03T08:00:00.000Z',
  }
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return
    await delay(5)
  }
  throw new Error('Timed out waiting for fake mount')
}
