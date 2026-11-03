import type { Catalog } from '../shared/catalog'
import type { ConnectorConfig, StoredConnector } from '../shared/config'
import type { ConnectorProbeResult } from '../shared/status'
import { CatalogService, type CatalogResult } from './catalog'
import { probeApiKeyConnector, probeConnector } from './health'
import { MountManager, type ConnectorMountSnapshot } from './mounts'
import { redactUrl } from './redact'
import type { SecretStore } from './secrets'
import type { ConnectorStore } from './store'

export class ConnectorHubError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
    this.name = 'ConnectorHubError'
  }
}

export interface ConnectorView extends ConnectorMountSnapshot {
  catalogRevision: string
  addedAt: string
  remote: StoredConnector['remote']
  auth: StoredConnector['auth']
  lastProbe: ConnectorProbeResult | null
}

interface GatewayEndpoints {
  endpoint(id: string): { url: string, headers: Record<string, string> }
}

export interface ConnectorHubServiceOptions {
  catalog: CatalogService
  store: ConnectorStore
  secrets: SecretStore
  mounts: MountManager
  gateway: GatewayEndpoints
  probeCandidate?: (id: string, connector: StoredConnector, key: string) => Promise<ConnectorProbeResult>
  probeMounted?: (id: string) => Promise<ConnectorProbeResult>
  now?: () => Date
}

/** Transactional API Key lifecycle shared by all Host routes. */
export class ConnectorHubService {
  private readonly catalog: CatalogService
  private readonly store: ConnectorStore
  private readonly secrets: SecretStore
  private readonly mounts: MountManager
  private readonly probeCandidate: NonNullable<ConnectorHubServiceOptions['probeCandidate']>
  private readonly probeMounted: NonNullable<ConnectorHubServiceOptions['probeMounted']>
  private readonly now: () => Date
  private readonly probes = new Map<string, ConnectorProbeResult>()
  private queue: Promise<void> = Promise.resolve()

  constructor(options: ConnectorHubServiceOptions) {
    this.catalog = options.catalog
    this.store = options.store
    this.secrets = options.secrets
    this.mounts = options.mounts
    this.probeCandidate = options.probeCandidate ?? probeApiKeyConnector
    this.probeMounted = options.probeMounted ?? (id => probeConnector(id, options.gateway.endpoint(id)))
    this.now = options.now ?? (() => new Date())
  }

  async start(): Promise<void> {
    const config = await this.store.read()
    await this.mounts.reconcile(config.connectors)
  }

  async getCatalog(): Promise<CatalogResult & { updates: string[] }> {
    const result = await this.catalog.load()
    const config = this.store.snapshot() ?? await this.store.read()
    return { ...result, updates: changedConnectors(config, result.catalog) }
  }

  refreshCatalog(): Promise<CatalogResult & { updates: string[] }> {
    return this.serialize(async () => {
      const result = await this.catalog.load(true)
      const config = await this.store.read()
      return { ...result, updates: changedConnectors(config, result.catalog) }
    })
  }

  listConnectors(): Promise<ConnectorView[]> {
    return this.serialize(async () => {
      const config = await this.sync()
      return this.views(config)
    })
  }

  connectApiKey(id: string, key: string): Promise<ConnectorView> {
    return this.serialize(async () => {
      if (!key) throw new ConnectorHubError('API Key must not be empty')
      const config = await this.sync()
      const catalogResult = await this.catalog.load()
      const item = catalogResult.catalog.connectors.find(connector => connector.id === id)
      if (!item) throw new ConnectorHubError('Unknown connector id', 404)
      if (item.auth.type !== 'api-key') throw new ConnectorHubError('Connector does not use API Key authentication')

      const existing = config.connectors[id]
      const candidate: StoredConnector = {
        catalogRevision: catalogResult.catalog.revision,
        remote: structuredClone(item.remote),
        auth: structuredClone(item.auth),
        enabled: existing?.enabled ?? true,
        addedAt: existing?.addedAt ?? this.now().toISOString(),
      }
      const probe = await this.probeCandidate(id, candidate, key)
      if (!probe.ok) throw new ConnectorHubError(probe.error ?? 'API Key probe failed')

      const previousSecret = existing ? await this.secrets.read(id) : null
      try {
        await this.secrets.write(id, { v: 1, apiKey: key })
        const next = await this.store.update(draft => { draft.connectors[id] = candidate })
        const mount = candidate.enabled
          ? await this.mounts.remount(id, candidate)
          : await this.unmounted(id)
        if (mount.status === 'failed') throw new ConnectorHubError(mount.error ?? 'MCP client mount failed', 502)
        this.probes.set(id, probe)
        return this.view(id, next.connectors[id])
      } catch (error) {
        await this.store.write(config).catch(() => {})
        if (previousSecret) await this.secrets.write(id, previousSecret).catch(() => {})
        else await this.secrets.delete(id).catch(() => {})
        if (existing?.enabled) await this.mounts.remount(id, existing).catch(() => {})
        else await this.mounts.unmount(id).catch(() => {})
        throw error
      }
    })
  }

  probe(id: string): Promise<ConnectorView> {
    return this.serialize(async () => {
      const config = await this.sync()
      if (!config.connectors[id]) throw new ConnectorHubError('Connector is not added', 404)
      const result = await this.probeMounted(id)
      this.probes.set(id, result)
      return this.view(id, config.connectors[id])
    })
  }

  remount(id: string): Promise<ConnectorView> {
    return this.serialize(async () => {
      const config = await this.sync()
      const connector = config.connectors[id]
      if (!connector) throw new ConnectorHubError('Connector is not added', 404)
      if (!connector.enabled) throw new ConnectorHubError('Enable the connector before remounting', 409)
      await this.mounts.remount(id, connector)
      return this.view(id, connector)
    })
  }

  setEnabled(id: string, enabled: boolean): Promise<ConnectorView> {
    return this.serialize(async () => {
      await this.sync()
      const current = await this.store.read()
      if (!current.connectors[id]) throw new ConnectorHubError('Connector is not added', 404)
      const next = await this.store.update(draft => { draft.connectors[id].enabled = enabled })
      const connector = next.connectors[id]
      if (enabled) await this.mounts.remount(id, connector)
      else await this.mounts.unmount(id)
      return this.view(id, connector)
    })
  }

  remove(id: string): Promise<{ removed: true }> {
    return this.serialize(async () => {
      const config = await this.sync()
      if (!config.connectors[id]) throw new ConnectorHubError('Connector is not added', 404)
      await this.mounts.unmount(id)
      await this.secrets.delete(id)
      await this.store.update(draft => { delete draft.connectors[id] })
      this.probes.delete(id)
      return { removed: true }
    })
  }

  private async sync(): Promise<ConnectorConfig> {
    const { config, changed } = await this.store.reloadIfChanged()
    if (changed) await this.mounts.reconcile(config.connectors)
    return config
  }

  private views(config: ConnectorConfig): ConnectorView[] {
    return Object.keys(config.connectors).map(id => this.view(id, config.connectors[id]))
  }

  private view(id: string, connector: StoredConnector): ConnectorView {
    const probe = this.probes.get(id) ?? null
    const mount = this.mounts.list({ [id]: connector }, probe ? { [id]: probe } : {})[0]
    return {
      ...mount,
      catalogRevision: connector.catalogRevision,
      addedAt: connector.addedAt,
      remote: { ...connector.remote, url: redactUrl(connector.remote.url) },
      auth: structuredClone(connector.auth),
      lastProbe: probe,
    }
  }

  private async unmounted(id: string): Promise<ConnectorMountSnapshot> {
    await this.mounts.unmount(id)
    return this.mounts.list({})[0] ?? {
      id, enabled: false, status: 'disabled', phase: null, generation: null,
      mountedAt: null, tools: [], error: null,
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }
}

function changedConnectors(config: ConnectorConfig, catalog: Catalog): string[] {
  return catalog.connectors.filter(item => {
    const stored = config.connectors[item.id]
    return stored && JSON.stringify({ remote: stored.remote, auth: stored.auth })
      !== JSON.stringify({ remote: item.remote, auth: item.auth })
  }).map(item => item.id)
}
