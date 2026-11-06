import type { CatalogUpdate } from '../shared/catalog'
import type { ConnectorConfig, StoredConnector } from '../shared/config'
import type { ConnectorProbeResult } from '../shared/status'
import { CatalogService, type CatalogResult } from './catalog'
import { catalogUpdates } from './catalog-updates'
import { probeApiKeyConnector, probeConnector, probeOAuthConnector } from './health'
import { MountManager, type ConnectorMountSnapshot } from './mounts'
import { maskAccountName } from './oauth-account'
import type { OAuthTokenRefresher } from './oauth-refresh'
import { OAuthManager, type OAuthAttemptView, type OAuthStartResult } from './oauth'
import { redactUrl } from './redact'
import type { ConnectorSecret, OAuthSecret, SecretStore } from './secrets'
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
  account?: string | null
  catalogUpdate: Omit<CatalogUpdate, 'id'> | null
}

export interface CatalogUpdateApplicationOptions {
  applyCatalogUpdate?: boolean
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
  oauth?: OAuthManager
  oauthTokens?: OAuthTokenRefresher
  reauthRequired?: Set<string>
  probeCandidate?: (id: string, connector: StoredConnector, key: string) => Promise<ConnectorProbeResult>
  probeOAuthCandidate?: (id: string, connector: StoredConnector, secret: OAuthSecret) => Promise<ConnectorProbeResult>
  probeMounted?: (id: string) => Promise<ConnectorProbeResult>
  now?: () => Date
}

/** Transactional connector lifecycle shared by all Host routes. */
export class ConnectorHubService {
  private readonly catalog: CatalogService
  private readonly store: ConnectorStore
  private readonly secrets: SecretStore
  private readonly mounts: MountManager
  private readonly oauth?: OAuthManager
  private readonly oauthTokens?: OAuthTokenRefresher
  private readonly reauthRequired: Set<string>
  private readonly probeCandidate: NonNullable<ConnectorHubServiceOptions['probeCandidate']>
  private readonly probeOAuthCandidate: NonNullable<ConnectorHubServiceOptions['probeOAuthCandidate']>
  private readonly probeMounted: NonNullable<ConnectorHubServiceOptions['probeMounted']>
  private readonly now: () => Date
  private readonly probes = new Map<string, ConnectorProbeResult>()
  private readonly pendingProbes = new Map<string, Promise<ConnectorProbeResult>>()
  private readonly configurationGenerations = new Map<string, number>()
  private queue: Promise<void> = Promise.resolve()

  constructor(options: ConnectorHubServiceOptions) {
    this.catalog = options.catalog
    this.store = options.store
    this.secrets = options.secrets
    this.mounts = options.mounts
    this.oauth = options.oauth
    this.oauthTokens = options.oauthTokens
    this.reauthRequired = options.reauthRequired ?? new Set()
    this.probeCandidate = options.probeCandidate ?? probeApiKeyConnector
    this.probeOAuthCandidate = options.probeOAuthCandidate ?? probeOAuthConnector
    this.probeMounted = options.probeMounted ?? (id => probeConnector(id, options.gateway.endpoint(id)))
    this.now = options.now ?? (() => new Date())
  }

  async start(): Promise<void> {
    const config = await this.store.read()
    await this.mounts.reconcile(config.connectors)
  }

  async getCatalog(): Promise<CatalogResult & { updates: CatalogUpdate[] }> {
    const result = await this.catalog.load()
    const config = this.store.snapshot() ?? await this.store.read()
    return { ...result, updates: catalogUpdates(config, result.catalog) }
  }

  refreshCatalog(): Promise<CatalogResult & { updates: CatalogUpdate[] }> {
    return this.serialize(async () => {
      const result = await this.catalog.load(true)
      const config = await this.store.read()
      return { ...result, updates: catalogUpdates(config, result.catalog) }
    })
  }

  listConnectors(): Promise<ConnectorView[]> {
    return this.serialize(async () => {
      const config = await this.sync()
      return this.views(config)
    })
  }

  connectApiKey(id: string, key?: string, options: CatalogUpdateApplicationOptions = {}): Promise<ConnectorView> {
    return this.serialize(async () => {
      const config = await this.sync()
      const applyCatalogUpdate = options.applyCatalogUpdate === true
      const { candidate, existing } = await this.connectionCandidate(config, id, applyCatalogUpdate)
      if (candidate.auth.type !== 'api-key') throw new ConnectorHubError('Connector does not use API Key authentication')
      let candidateKey = key
      if (candidateKey === undefined && applyCatalogUpdate && existing) {
        const secret = await this.secrets.read(id)
        if (secret && 'apiKey' in secret) candidateKey = secret.apiKey
      }
      if (!candidateKey) throw new ConnectorHubError('API Key must not be empty')
      const probe = await this.probeCandidate(id, candidate, candidateKey)
      if (!probe.ok) throw new ConnectorHubError(probe.error ?? 'API Key probe failed')
      return this.commitCandidate(config, id, candidate, { v: 1, apiKey: candidateKey }, probe)
    })
  }

  startOAuth(id: string, options: CatalogUpdateApplicationOptions = {}): Promise<OAuthStartResult> {
    return this.serialize(async () => {
      if (!this.oauth) throw new ConnectorHubError('OAuth support is unavailable', 500)
      const config = await this.sync()
      const { candidate } = await this.connectionCandidate(config, id, options.applyCatalogUpdate === true)
      if (candidate.auth.type !== 'oauth') throw new ConnectorHubError('Connector does not use OAuth authentication')
      return this.oauth.start(id, candidate, secret => this.completeOAuth(id, candidate, secret))
    })
  }

  private async connectionCandidate(
    config: ConnectorConfig,
    id: string,
    applyCatalogUpdate: boolean,
  ): Promise<{ candidate: StoredConnector, existing: StoredConnector | undefined }> {
    const catalogResult = await this.catalog.load()
    const existing = config.connectors[id]
    const item = catalogResult.catalog.connectors.find(connector => connector.id === id)
    if (applyCatalogUpdate) {
      const changed = existing && item && catalogUpdates(config, catalogResult.catalog)
        .some(update => update.id === id && update.kind === 'changed')
      if (!changed) throw new ConnectorHubError('Catalog update is not available for this connector')
    }
    const source = existing && !applyCatalogUpdate ? existing : item
    if (!source) throw new ConnectorHubError('Unknown connector id', 404)
    return {
      existing,
      candidate: {
        catalogRevision: existing && !applyCatalogUpdate ? existing.catalogRevision : catalogResult.catalog.revision,
        remote: structuredClone(source.remote),
        auth: structuredClone(source.auth),
        enabled: existing?.enabled ?? true,
        addedAt: existing?.addedAt ?? this.now().toISOString(),
      },
    }
  }

  oauthStatus(attemptId: string): OAuthAttemptView {
    if (!this.oauth) throw new ConnectorHubError('OAuth support is unavailable', 500)
    return this.oauth.status(attemptId)
  }

  cancelOAuth(attemptId: string): Promise<{ cancelled: true }> {
    if (!this.oauth) throw new ConnectorHubError('OAuth support is unavailable', 500)
    return this.oauth.cancel(attemptId)
  }

  private completeOAuth(id: string, candidate: StoredConnector, secret: OAuthSecret): Promise<void> {
    return this.serialize(async () => {
      const config = await this.sync()
      const existing = config.connectors[id]
      const nextCandidate: StoredConnector = {
        ...structuredClone(candidate),
        enabled: existing?.enabled ?? candidate.enabled,
        addedAt: existing?.addedAt ?? candidate.addedAt,
      }
      const probe = await this.probeOAuthCandidate(id, nextCandidate, secret)
      if (!probe.ok) throw new ConnectorHubError(probe.error ?? 'OAuth probe failed')
      await this.commitCandidate(config, id, nextCandidate, secret, probe)
    })
  }

  private async commitCandidate(
    config: ConnectorConfig,
    id: string,
    candidate: StoredConnector,
    secret: ConnectorSecret,
    probe: ConnectorProbeResult,
  ): Promise<ConnectorView> {
    const existing = config.connectors[id]
    const previousSecret = existing ? await this.secrets.read(id) : null
    this.bumpConfiguration(id)
    try {
      await this.secrets.write(id, secret)
      const next = await this.store.update(draft => { draft.connectors[id] = candidate })
      const mount = candidate.enabled
        ? await this.mounts.remount(id, candidate)
        : await this.unmounted(id)
      if (mount.status === 'failed') throw new ConnectorHubError(mount.error ?? 'MCP client mount failed', 502)
      this.reauthRequired.delete(id)
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
  }

  async probe(id: string): Promise<ConnectorView> {
    const connector = this.store.snapshot()?.connectors[id]
    if (!connector) throw new ConnectorHubError('Connector is not added', 404)
    const generation = this.configurationGeneration(id)
    const result = await this.sharedProbe(id)
    if (this.configurationGeneration(id) === generation) this.probes.set(id, result)
    const current = this.store.snapshot()?.connectors[id]
    if (!current) throw new ConnectorHubError('Connector is not added', 404)
    return this.view(id, current)
  }

  private configurationGeneration(id: string): number {
    return this.configurationGenerations.get(id) ?? 0
  }

  private bumpConfiguration(id: string): void {
    this.configurationGenerations.set(id, this.configurationGeneration(id) + 1)
  }

  private async sharedProbe(id: string): Promise<ConnectorProbeResult> {
    const pending = this.pendingProbes.get(id)
    if (pending) return pending
    const promise = this.probeMounted(id)
    this.pendingProbes.set(id, promise)
    try {
      return await promise
    } finally {
      if (this.pendingProbes.get(id) === promise) this.pendingProbes.delete(id)
    }
  }

  remount(id: string): Promise<ConnectorView> {
    return this.serialize(async () => {
      const config = await this.sync()
      const connector = config.connectors[id]
      if (!connector) throw new ConnectorHubError('Connector is not added', 404)
      if (!connector.enabled) throw new ConnectorHubError('Enable the connector before remounting', 409)
      if (this.reauthRequired.has(id)) throw new ConnectorHubError('Reauthorization is required before remounting', 409)
      await this.mounts.remount(id, connector)
      return this.view(id, connector)
    })
  }

  setEnabled(id: string, enabled: boolean): Promise<ConnectorView> {
    return this.serialize(async () => {
      await this.sync()
      const current = await this.store.read()
      if (!current.connectors[id]) throw new ConnectorHubError('Connector is not added', 404)
      if (enabled && this.reauthRequired.has(id)) throw new ConnectorHubError('Reauthorization is required before enabling', 409)
      this.bumpConfiguration(id)
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
      const connector = config.connectors[id]
      if (!connector) throw new ConnectorHubError('Connector is not added', 404)
      const secret = await this.secrets.read(id).catch(() => null)
      this.bumpConfiguration(id)
      await this.oauth?.cancelConnector(id)
      await this.mounts.unmount(id)
      await this.secrets.delete(id)
      await this.store.update(draft => { delete draft.connectors[id] })
      this.reauthRequired.delete(id)
      this.probes.delete(id)
      if (connector.auth.type === 'oauth' && secret && 'tokens' in secret) {
        await this.oauthTokens?.revoke(id, connector, secret).catch(() => {})
      }
      return { removed: true }
    })
  }

  private async sync(): Promise<ConnectorConfig> {
    const { config, changed } = await this.store.reloadIfChanged()
    if (changed) await this.mounts.reconcile(config.connectors)
    return config
  }

  private async views(config: ConnectorConfig): Promise<ConnectorView[]> {
    const result = await this.catalog.load()
    const updates = catalogUpdates(config, result.catalog)
    return Promise.all(Object.keys(config.connectors).map(id => this.view(id, config.connectors[id], updates)))
  }

  private async view(id: string, connector: StoredConnector, updates?: CatalogUpdate[]): Promise<ConnectorView> {
    const probe = this.probes.get(id) ?? null
    const mount = this.mounts.list(
      { [id]: connector },
      probe ? { [id]: probe } : {},
      this.reauthRequired,
    )[0]
    let account: string | null = null
    if (connector.auth.type === 'oauth') {
      const secret = await this.secrets.read(id).catch(() => null)
      const name = secret && 'tokens' in secret ? secret.account?.name : undefined
      if (typeof name === 'string') account = maskAccountName(name)
    }
    const catalogResult = updates ? undefined : this.catalog.snapshotResult()
    const currentUpdates = updates ?? (catalogResult ? catalogUpdates({
      schemaVersion: 1,
      connectors: { [id]: connector },
    }, catalogResult.catalog) : [])
    const catalogUpdate = currentUpdates.find(update => update.id === id) ?? null
    return {
      ...mount,
      catalogRevision: connector.catalogRevision,
      addedAt: connector.addedAt,
      remote: { ...connector.remote, url: redactUrl(connector.remote.url) },
      auth: structuredClone(connector.auth),
      lastProbe: probe,
      account,
      catalogUpdate: catalogUpdate
        ? { kind: catalogUpdate.kind, fields: [...catalogUpdate.fields] }
        : null,
    }
  }

  private async unmounted(id: string): Promise<ConnectorMountSnapshot> {
    await this.mounts.unmount(id)
    return this.mounts.list({})[0] ?? {
      id, enabled: false, status: 'disabled', phase: null, generation: null,
      mountedAt: null, tools: [], error: null, errorCode: null,
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }
}
