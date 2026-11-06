import { describe, expect, it } from 'vitest'
import { catalogUpdates } from '../packages/connector-hub/src/host/catalog-updates'
import type { Catalog } from '../packages/connector-hub/src/shared/catalog'
import type { ConnectorConfig } from '../packages/connector-hub/src/shared/config'

describe('catalogUpdates', () => {
  it('ignores object field order and treats missing fields as undefined', () => {
    const config = fixtureConfig()
    const catalog = fixtureCatalog()
    catalog.connectors[0].auth = {
      helpUrl: 'https://example.com/key',
      label: { en: 'Key', zh: 'Key' },
      name: 'key',
      in: 'query',
      type: 'api-key',
      valueTemplate: undefined,
    } as Catalog['connectors'][number]['auth']

    expect(catalogUpdates(config, catalog)).toEqual([])
  })

  it('lists changed remote and authentication field paths', () => {
    const config = fixtureConfig()
    const catalog = fixtureCatalog()
    catalog.connectors[0].remote.url = 'https://example.com/v2/mcp'
    if (catalog.connectors[0].auth.type === 'api-key') catalog.connectors[0].auth.name = 'ak'

    expect(catalogUpdates(config, catalog)).toEqual([
      { id: 'amap', kind: 'changed', fields: ['auth.name', 'remote.url'] },
    ])
  })

  it('marks stored connectors missing from the catalog as removed', () => {
    const catalog = fixtureCatalog()
    catalog.connectors = []

    expect(catalogUpdates(fixtureConfig(), catalog)).toEqual([
      { id: 'amap', kind: 'removed', fields: [] },
    ])
  })
})

function fixtureConfig(): ConnectorConfig {
  return {
    schemaVersion: 1,
    connectors: {
      amap: {
        catalogRevision: 'test.1',
        remote: { type: 'streamable-http', url: 'https://example.com/mcp' },
        auth: {
          type: 'api-key', in: 'query', name: 'key',
          label: { zh: 'Key', en: 'Key' }, helpUrl: 'https://example.com/key',
        },
        enabled: true,
        addedAt: '2026-11-03T08:00:00.000Z',
      },
    },
  }
}

function fixtureCatalog(): Catalog {
  const stored = fixtureConfig().connectors.amap
  return {
    schemaVersion: 1,
    revision: 'test.2',
    connectors: [{
      id: 'amap',
      name: { zh: '高德地图', en: 'Amap' },
      description: { zh: '地图', en: 'Maps' },
      icon: 'data:image/svg+xml;base64,AA==',
      homepage: 'https://example.com',
      publisher: 'Amap',
      official: true,
      remote: structuredClone(stored.remote),
      auth: structuredClone(stored.auth),
    }],
  }
}
