import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConnectorStore } from '../packages/connector-hub/src/host/store'
import {
  ConnectorConfigError,
  emptyConnectorConfig,
  parseConnectorConfig,
} from '../packages/connector-hub/src/shared/config'

const temporaryPaths = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('connector config parsing and migration', () => {
  it('accepts the current v1 format and rejects future versions', () => {
    const config = configWith('notion')
    expect(parseConnectorConfig(config)).toEqual(config)
    expect(() => parseConnectorConfig({ ...config, schemaVersion: 2 })).toThrowError(
      expect.objectContaining({ code: 'unsupported-version' }),
    )
  })

  it('dispatches test-only historical migrations without inventing a production v0', () => {
    const migrated = parseConnectorConfig(
      { schemaVersion: 0, connectors: {} },
      { 0: value => ({ ...value, schemaVersion: 1 }) },
    )
    expect(migrated).toEqual(emptyConnectorConfig())
    expect(() => parseConnectorConfig({ schemaVersion: 0, connectors: {} })).toThrowError(
      expect.objectContaining({ code: 'missing-migration' }),
    )
  })

  it('accepts legacy and templated API Key auth but rejects malformed templates', () => {
    const legacy = configWith('amap')
    expect(parseConnectorConfig(legacy)).toEqual(legacy)

    const templated = configWith('amap')
    templated.connectors.amap.auth.valueTemplate = 'Bearer ${value}'
    expect(parseConnectorConfig(templated)).toEqual(templated)

    for (const valueTemplate of ['Bearer key', '${value} ${value}', 42]) {
      const invalid = configWith('amap')
      invalid.connectors.amap.auth.valueTemplate = valueTemplate
      expect(() => parseConnectorConfig(invalid)).toThrow('exactly one ${value} placeholder')
    }
  })

  it('rejects malformed entries and credentials without echoing secret values', () => {
    const malformed = configWith('notion')
    malformed.connectors.notion.enabled = 'yes'
    expect(() => parseConnectorConfig(malformed)).toThrow('enabled must be a boolean')

    const secret = configWith('notion')
    secret.connectors.notion.auth = { type: 'api-key', apiKey: 'never-print-this' }
    expect(() => parseConnectorConfig(secret)).toThrow('credentials are not allowed')
    expect(() => parseConnectorConfig(secret)).toThrow(expect.not.objectContaining({
      message: expect.stringContaining('never-print-this'),
    }))
  })
})

describe('ConnectorStore', () => {
  it('returns an empty v1 config when the file is missing', async () => {
    const store = new ConnectorStore(await temporaryHome())
    expect(await store.read()).toEqual(emptyConnectorConfig())
    expect(await store.reloadIfChanged()).toEqual({ config: emptyConnectorConfig(), changed: false })
  })

  it('round-trips complete connector settings and writes a private file', async () => {
    const store = new ConnectorStore(await temporaryHome())
    const config = configWith('notion')
    await store.write(config)

    expect(await store.read()).toEqual(config)
    expect(JSON.parse(await readFile(store.filePath, 'utf8'))).toEqual(config)
    expect((await stat(store.filePath)).mode & 0o777).toBe(0o600)
  })

  it('serializes concurrent read-modify-write updates without losing entries', async () => {
    const store = new ConnectorStore(await temporaryHome())
    await Promise.all(Array.from({ length: 12 }, (_, index) => store.update(config => {
      config.connectors[`connector-${index}`] = connector(`connector-${index}`)
    })))

    const result = await store.read()
    expect(Object.keys(result.connectors)).toHaveLength(12)
    for (let index = 0; index < 12; index++) {
      expect(result.connectors[`connector-${index}`].enabled).toBe(true)
    }
  })

  it('cleans temporary files when atomic replacement fails', async () => {
    const store = new ConnectorStore(await temporaryHome())
    await mkdir(store.filePath, { recursive: true })
    await expect(store.write(emptyConnectorConfig())).rejects.toThrow()
    const names = await readdir(dirname(store.filePath))
    expect(names.filter(name => name.includes('.tmp'))).toEqual([])
  })

  it('reloads external replacements once and then reuses the valid snapshot', async () => {
    const store = new ConnectorStore(await temporaryHome())
    await store.read()
    const external = configWith('amap')
    await mkdir(dirname(store.filePath), { recursive: true })
    await writeFile(store.filePath, `${JSON.stringify(external)}\n`, 'utf8')

    expect(await store.reloadIfChanged()).toEqual({ config: external, changed: true })
    expect(await store.reloadIfChanged()).toEqual({ config: external, changed: false })
  })

  it('keeps the last valid snapshot when an external file is corrupt', async () => {
    const store = new ConnectorStore(await temporaryHome())
    const original = configWith('notion')
    await store.write(original)
    await writeFile(store.filePath, '{broken', 'utf8')

    await expect(store.reloadIfChanged()).rejects.toThrowError(ConnectorConfigError)
    expect(store.snapshot()).toEqual(original)

    const repaired = configWith('xmind-cn')
    await writeFile(store.filePath, `${JSON.stringify(repaired)}\n`, 'utf8')
    expect(await store.reloadIfChanged()).toEqual({ config: repaired, changed: true })
  })

  it('returns isolated snapshots that callers cannot mutate behind the store', async () => {
    const store = new ConnectorStore(await temporaryHome())
    await store.write(configWith('notion'))
    const result = await store.read()
    delete result.connectors.notion
    expect(store.snapshot()).toEqual(configWith('notion'))
  })

  it('treats external deletion as an empty shared configuration', async () => {
    const store = new ConnectorStore(await temporaryHome())
    await store.write(configWith('notion'))
    await rm(store.filePath)
    expect(await store.reloadIfChanged()).toEqual({ config: emptyConnectorConfig(), changed: true })
  })
})

function configWith(id) {
  return { schemaVersion: 1, connectors: { [id]: connector(id) } }
}

function connector(id) {
  return {
    catalogRevision: '2026-11-03.1',
    remote: { type: 'streamable-http', url: `https://example.com/${id}/mcp` },
    auth: id === 'none-auth' ? { type: 'none' } : id === 'amap'
      ? { type: 'api-key', in: 'query', name: 'key', label: { zh: 'Key', en: 'Key' }, helpUrl: 'https://example.com/key' }
      : {
          type: 'oauth', scope: '', clientMetadataUrl: 'https://example.com/client.json',
          callbackPath: `/oauth/callback/${id}`, portPolicy: 'random',
        },
    enabled: true,
    addedAt: '2026-11-03T08:00:00.000Z',
  }
}

async function temporaryHome() {
  const path = await mkdtemp(join(tmpdir(), 'connector-hub-store-'))
  temporaryPaths.push(path)
  return path
}
