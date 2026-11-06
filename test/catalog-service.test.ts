import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CatalogService, DEFAULT_CATALOG_URL, parseCatalog } from '../packages/connector-hub/src/host/catalog'

const temporaryPaths = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('CatalogService', () => {
  it('uses the v2 channel and an independent cache by default', async () => {
    const home = await temporaryHome()
    const fetchImpl = vi.fn(async () => Response.json(catalog()))
    const service = new CatalogService({ dshHome: home, snapshot: catalog('snapshot'), fetchImpl })

    expect(DEFAULT_CATALOG_URL).toBe('https://looori.github.io/dsh-connector-hub/catalog/v2/index.json')
    expect(service.cachePath).toBe(join(home, 'connector-hub', 'cache', 'catalog-v2.json'))
    await service.load()
    expect(fetchImpl).toHaveBeenCalledWith(DEFAULT_CATALOG_URL, expect.anything())
  })

  it('fetches and validates the network catalog, then reuses a fresh persistent cache', async () => {
    const home = await temporaryHome()
    const fetchImpl = vi.fn(async () => Response.json(catalog(), { headers: { etag: 'rev-1' } }))
    const now = () => new Date('2026-11-03T10:00:00.000Z')
    const first = new CatalogService({ dshHome: home, snapshot: catalog('snapshot'), fetchImpl, now })

    const network = await first.load()
    expect(network).toMatchObject({ source: 'network', stale: false, error: null })
    expect(network.catalog.revision).toBe('2026-11-03.2')
    expect(JSON.parse(await readFile(first.cachePath, 'utf8')).etag).toBe('rev-1')

    const second = new CatalogService({ dshHome: home, snapshot: catalog('snapshot'), fetchImpl, now })
    expect((await second.load()).source).toBe('cache')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('uses ETag on manual refresh and accepts a 304 revalidation', async () => {
    const home = await temporaryHome()
    let now = new Date('2026-11-03T10:00:00.000Z')
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json(catalog(), { headers: { etag: 'rev-1' } }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
    const service = new CatalogService({ dshHome: home, snapshot: catalog(), fetchImpl, now: () => now })
    await service.load()
    now = new Date('2026-11-04T11:00:00.000Z')

    const result = await service.load(true)
    expect(result.source).toBe('network')
    expect(result.fetchedAt).toBe(now.toISOString())
    expect(fetchImpl.mock.calls[1][1].headers).toEqual({ 'if-none-match': 'rev-1' })
  })

  it('falls back to stale cache and then to the bundled snapshot on fetch failures', async () => {
    const home = await temporaryHome()
    const online = new CatalogService({
      dshHome: home,
      snapshot: catalog('snapshot'),
      fetchImpl: async () => Response.json(catalog()),
      now: () => new Date('2026-11-03T10:00:00.000Z'),
    })
    await online.load()

    const offline = new CatalogService({
      dshHome: home,
      snapshot: catalog('snapshot'),
      fetchImpl: async () => { throw new Error('offline') },
      now: () => new Date('2026-11-05T10:00:00.000Z'),
    })
    expect(await offline.load()).toMatchObject({ source: 'cache', stale: true, error: 'offline' })

    const emptyHome = await temporaryHome()
    const snapshotOnly = new CatalogService({
      dshHome: emptyHome,
      snapshot: catalog('snapshot'),
      fetchImpl: async () => { throw new Error('offline') },
    })
    const result = await snapshotOnly.load()
    expect(result.source).toBe('snapshot')
    expect(result.catalog.revision).toBe('2026-11-03.snapshot')
  })

  it('rejects an invalid network catalog instead of caching it', async () => {
    const service = new CatalogService({
      dshHome: await temporaryHome(),
      snapshot: catalog('snapshot'),
      fetchImpl: async () => Response.json({ schemaVersion: 1, revision: 'bad', connectors: [{ id: 'evil' }] }),
    })
    const result = await service.load()
    expect(result.source).toBe('snapshot')
    expect(result.stale).toBe(true)
    await expect(readFile(service.cachePath, 'utf8')).rejects.toThrow()
  })

  it('validates connector identity, metadata and authentication at the trust boundary', () => {
    expect(() => parseCatalog(catalog())).not.toThrow()
    const duplicate = catalog()
    duplicate.connectors.push(duplicate.connectors[0])
    expect(() => parseCatalog(duplicate)).toThrow('duplicate connector')

    const insecure = catalog()
    insecure.connectors[0].remote.url = 'https://example.com/mcp'
    insecure.connectors[0].remote.url = 'http://192.0.2.1/mcp'
    expect(() => parseCatalog(insecure)).toThrow('must use HTTPS')
  })
})

function catalog(suffix = '2') {
  return {
    schemaVersion: 1,
    revision: `2026-11-03.${suffix}`,
    connectors: [{
      id: 'amap',
      name: { zh: '高德地图', en: 'Amap' },
      description: { zh: '地图', en: 'Maps' },
      icon: `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`,
      homepage: 'https://example.com',
      publisher: 'Amap',
      official: true,
      remote: { type: 'streamable-http', url: 'https://example.com/mcp' },
      auth: {
        type: 'api-key', in: 'query', name: 'key',
        label: { zh: 'Key', en: 'Key' }, helpUrl: 'https://example.com/key',
      },
    }],
  }
}

async function temporaryHome() {
  const path = await mkdtemp(join(tmpdir(), 'connector-hub-catalog-'))
  temporaryPaths.push(path)
  return path
}
