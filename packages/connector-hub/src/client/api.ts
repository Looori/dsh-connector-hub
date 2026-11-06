import type { CatalogUpdate } from '../shared/catalog'
import type { CatalogResult } from '../host/catalog'
import type { OAuthAttemptView, OAuthStartResult } from '../host/oauth'
import type { CatalogUpdateApplicationOptions, ConnectorView } from '../host/service'

export type CatalogResponse = CatalogResult & { updates: CatalogUpdate[] }
export type FetchImplementation = typeof globalThis.fetch

export interface ConnectorHubApi {
  getCatalog(): Promise<CatalogResponse>
  refreshCatalog(): Promise<CatalogResponse>
  listConnectors(): Promise<ConnectorView[]>
  connectApiKey(id: string, key?: string, options?: CatalogUpdateApplicationOptions): Promise<ConnectorView>
  startOAuth(id: string, options?: CatalogUpdateApplicationOptions): Promise<OAuthStartResult>
  oauthStatus(attemptId: string): Promise<OAuthAttemptView>
  cancelOAuth(attemptId: string): Promise<{ cancelled: true }>
  probe(id: string): Promise<ConnectorView>
  remount(id: string): Promise<ConnectorView>
  setEnabled(id: string, enabled: boolean): Promise<ConnectorView>
  remove(id: string): Promise<{ removed: true }>
}

export class ConnectorHubApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'ConnectorHubApiError'
  }
}

/** Browser transport for the owner-only Host routes. Keys only exist in request bodies. */
export function createConnectorHubApi(fetchImpl: FetchImplementation = globalThis.fetch): ConnectorHubApi {
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetchImpl(`api/connector-hub/${path}`, init)
    const body = await response.json().catch(() => null) as unknown
    if (!response.ok) {
      const message = isRecord(body) && typeof body.error === 'string'
        ? body.error
        : `HTTP ${response.status}`
      throw new ConnectorHubApiError(message, response.status)
    }
    return body as T
  }

  function post<T>(path: string, body?: Record<string, unknown>): Promise<T> {
    return request<T>(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }

  return {
    getCatalog: () => request<CatalogResponse>('catalog'),
    refreshCatalog: () => post<CatalogResponse>('catalog-refresh'),
    listConnectors: () => request<ConnectorView[]>('connectors'),
    connectApiKey: (id, key, options) => post<ConnectorView>('api-key-connect', { id, key, ...options }),
    startOAuth: (id, options) => post<OAuthStartResult>('oauth-start', { id, ...options }),
    oauthStatus: attemptId => post<OAuthAttemptView>('oauth-status', { attemptId }),
    cancelOAuth: attemptId => post<{ cancelled: true }>('oauth-cancel', { attemptId }),
    probe: id => post<ConnectorView>('probe', { id }),
    remount: id => post<ConnectorView>('remount', { id }),
    setEnabled: (id, enabled) => post<ConnectorView>('set-enabled', { id, enabled }),
    remove: id => post<{ removed: true }>('remove', { id }),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
