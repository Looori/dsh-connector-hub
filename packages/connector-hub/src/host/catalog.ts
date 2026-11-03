import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import bundledSnapshot from '../../catalog/index.json'
import type { Catalog, CatalogConnector, LocalizedText } from '../shared/catalog'
import { CONNECTOR_ID_PATTERN, parseConnectorConfig } from '../shared/config'
import { safeErrorMessage } from './redact'

export const DEFAULT_CATALOG_URL = 'https://looori.github.io/dsh-connector-hub/catalog/v1/index.json'
export const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000

interface CacheEntry {
  catalog: Catalog
  etag: string | null
  fetchedAt: string
}

export type CatalogSource = 'network' | 'cache' | 'snapshot'

export interface CatalogResult {
  catalog: Catalog
  source: CatalogSource
  fetchedAt: string
  stale: boolean
  error: string | null
}

export interface CatalogServiceOptions {
  dshHome: string
  catalogUrl?: string
  snapshot?: unknown
  fetchImpl?: typeof globalThis.fetch
  now?: () => Date
}

/** Network catalog with a persistent ETag cache and the package snapshot as final fallback. */
export class CatalogService {
  readonly cachePath: string
  private readonly catalogUrl: string
  private readonly snapshot: Catalog
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly now: () => Date
  private cache: CacheEntry | undefined
  private lastResult: CatalogResult | undefined
  private inFlight: Promise<CatalogResult> | undefined

  constructor(options: CatalogServiceOptions) {
    this.cachePath = resolve(options.dshHome, 'connector-hub', 'cache', 'catalog.json')
    this.catalogUrl = options.catalogUrl ?? DEFAULT_CATALOG_URL
    assertCatalogUrl(this.catalogUrl)
    this.snapshot = parseCatalog(options.snapshot ?? bundledSnapshot)
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.now = options.now ?? (() => new Date())
  }

  load(forceRefresh = false): Promise<CatalogResult> {
    if (this.inFlight) return this.inFlight
    this.inFlight = this.performLoad(forceRefresh).finally(() => { this.inFlight = undefined })
    return this.inFlight
  }

  async connector(id: string): Promise<CatalogConnector | undefined> {
    const result = await this.load()
    return result.catalog.connectors.find(connector => connector.id === id)
  }

  snapshotResult(): CatalogResult | undefined {
    return this.lastResult ? structuredClone(this.lastResult) : undefined
  }

  private async performLoad(forceRefresh: boolean): Promise<CatalogResult> {
    this.cache ??= await readCache(this.cachePath)
    const cache = this.cache
    if (!forceRefresh && cache && this.now().getTime() - Date.parse(cache.fetchedAt) < CATALOG_MAX_AGE_MS) {
      return this.remember({ catalog: cache.catalog, source: 'cache', fetchedAt: cache.fetchedAt, stale: false, error: null })
    }

    try {
      const response = await this.fetchImpl(this.catalogUrl, {
        headers: cache?.etag ? { 'if-none-match': cache.etag } : undefined,
        signal: AbortSignal.timeout(10_000),
      })
      if (response.status === 304) {
        if (!cache) throw new Error('Catalog returned 304 without a local cache')
        const next = { ...cache, fetchedAt: this.now().toISOString() }
        await writeCache(this.cachePath, next)
        this.cache = next
        return this.remember({ catalog: next.catalog, source: 'network', fetchedAt: next.fetchedAt, stale: false, error: null })
      }
      if (!response.ok) throw new Error(`Catalog request returned HTTP ${response.status}`)
      const catalog = parseCatalog(await response.json())
      const next: CacheEntry = {
        catalog,
        etag: response.headers.get('etag'),
        fetchedAt: this.now().toISOString(),
      }
      await writeCache(this.cachePath, next)
      this.cache = next
      return this.remember({ catalog, source: 'network', fetchedAt: next.fetchedAt, stale: false, error: null })
    } catch (error) {
      const message = safeErrorMessage(error)
      if (cache) {
        return this.remember({ catalog: cache.catalog, source: 'cache', fetchedAt: cache.fetchedAt, stale: true, error: message })
      }
      return this.remember({
        catalog: this.snapshot,
        source: 'snapshot',
        fetchedAt: this.now().toISOString(),
        stale: true,
        error: message,
      })
    }
  }

  private remember(result: CatalogResult): CatalogResult {
    this.lastResult = structuredClone(result)
    return structuredClone(result)
  }
}

export function parseCatalog(value: unknown): Catalog {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.revision !== 'string' || !value.revision) {
    throw new Error('Catalog must have schemaVersion 1 and a non-empty revision')
  }
  if (!Array.isArray(value.connectors)) throw new Error('Catalog connectors must be an array')
  const ids = new Set<string>()
  for (const item of value.connectors) {
    if (!isRecord(item) || typeof item.id !== 'string' || !CONNECTOR_ID_PATTERN.test(item.id)) {
      throw new Error('Catalog connector has an invalid id')
    }
    if (ids.has(item.id)) throw new Error(`Catalog contains duplicate connector ${item.id}`)
    ids.add(item.id)
    if (!localized(item.name) || !localized(item.description) || typeof item.publisher !== 'string' || !item.publisher
      || typeof item.official !== 'boolean' || typeof item.icon !== 'string'
      || !/^data:image\/svg\+xml;base64,[A-Za-z0-9+/]+={0,2}$/.test(item.icon) || item.icon.length > 8 * 1024
      || typeof item.homepage !== 'string' || !httpsUrl(item.homepage)) {
      throw new Error(`Catalog connector ${item.id} has invalid presentation metadata`)
    }
    parseConnectorConfig({
      schemaVersion: 1,
      connectors: {
        [item.id]: {
          catalogRevision: value.revision,
          remote: item.remote,
          auth: item.auth,
          enabled: true,
          addedAt: new Date(0).toISOString(),
        },
      },
    })
    validateAuth(item.auth, item.id)
  }
  return structuredClone(value) as unknown as Catalog
}

function validateAuth(value: unknown, id: string): void {
  if (!isRecord(value)) throw new Error(`Catalog connector ${id} has invalid auth`)
  if (value.type === 'none') return
  if (value.type === 'api-key') {
    if (!['header', 'query'].includes(String(value.in)) || typeof value.name !== 'string' || !value.name
      || !localized(value.label) || typeof value.helpUrl !== 'string' || !httpsUrl(value.helpUrl)) {
      throw new Error(`Catalog connector ${id} has invalid API Key auth`)
    }
    return
  }
  if (value.type === 'oauth') {
    const identities = Number(typeof value.clientId === 'string' && value.clientId.length > 0)
      + Number(typeof value.clientMetadataUrl === 'string' && httpsUrl(value.clientMetadataUrl))
    if (identities !== 1 || typeof value.callbackPath !== 'string' || !value.callbackPath.startsWith('/')
      || !['random', 'fixed'].includes(String(value.portPolicy))
      || (value.portPolicy === 'fixed' && (!Number.isInteger(value.fixedPort) || Number(value.fixedPort) < 1 || Number(value.fixedPort) > 65535))) {
      throw new Error(`Catalog connector ${id} has invalid OAuth auth`)
    }
  }
}

async function readCache(path: string): Promise<CacheEntry | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!isRecord(value) || value.etag !== null && typeof value.etag !== 'string'
      || typeof value.fetchedAt !== 'string' || !Number.isFinite(Date.parse(value.fetchedAt))) {
      return undefined
    }
    return { catalog: parseCatalog(value.catalog), etag: value.etag ?? null, fetchedAt: value.fetchedAt }
  } catch {
    return undefined
  }
}

async function writeCache(path: string, entry: CacheEntry): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(entry, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

function localized(value: unknown): value is LocalizedText {
  return isRecord(value) && typeof value.zh === 'string' && value.zh.length > 0
    && typeof value.en === 'string' && value.en.length > 0
}

function httpsUrl(value: string): boolean {
  try { return new URL(value).protocol === 'https:' } catch { return false }
}

function assertCatalogUrl(value: string): void {
  const url = new URL(value)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
    throw new Error('catalogUrl must use HTTPS or a loopback HTTP address')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
