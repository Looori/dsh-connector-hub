import { mkdir, open, stat, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  discoverOAuthServerInfo,
  OAuthError,
  OAuthErrorCode,
  refreshAuthorization,
  type OAuthTokens,
} from '@modelcontextprotocol/client'
import type { StoredConnector } from '../shared/config'
import type { ConnectorSecret, OAuthSecret, SecretStore } from './secrets'

export const OAUTH_REFRESH_WINDOW_MS = 5 * 60 * 1000
const LOCK_STALE_MS = 30_000

interface OAuthTokenRefresherOptions {
  secrets: SecretStore
  dshHome: string
  fetchImpl?: typeof globalThis.fetch
  now?: () => Date
  onReauthRequired?: (id: string) => void | Promise<void>
}

/** Refresh rotating OAuth tokens behind a cross-process lock, without remounting MCP clients. */
export class OAuthTokenRefresher {
  private readonly secrets: SecretStore
  private readonly lockDirectory: string
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly now: () => Date
  private readonly onReauthRequired?: (id: string) => void | Promise<void>

  constructor(options: OAuthTokenRefresherOptions) {
    this.secrets = options.secrets
    this.lockDirectory = resolve(options.dshHome, 'connector-hub', 'locks')
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.now = options.now ?? (() => new Date())
    this.onReauthRequired = options.onReauthRequired
  }

  async validSecret(id: string, connector: StoredConnector): Promise<OAuthSecret> {
    const secret = await this.readOAuthSecret(id)
    if (!secret.tokens.refresh_token || secret.tokens.expires_at > this.now().getTime() + OAUTH_REFRESH_WINDOW_MS) {
      return secret
    }
    return this.refreshWithLock(id, connector, secret)
  }

  async afterUnauthorized(id: string, connector: StoredConnector, failed: OAuthSecret): Promise<OAuthSecret> {
    if (!failed.tokens.refresh_token) {
      await this.requireReauth(id)
      throw new OAuthReauthorizationError('OAuth access token was rejected; reauthorization is required')
    }
    return this.refreshWithLock(id, connector, failed)
  }

  async revoke(id: string, connector: StoredConnector, secret: OAuthSecret): Promise<void> {
    if (connector.auth.type !== 'oauth') return
    const fetchFn = this.guardedFetch.bind(this)
    const discovered = await discoverOAuthServerInfo(connector.remote.url, { fetchFn })
    const metadata: unknown = discovered.authorizationServerMetadata
    const endpoint = isRecord(metadata) && typeof metadata.revocation_endpoint === 'string'
      ? metadata.revocation_endpoint
      : undefined
    if (!endpoint) return
    const clientId = connector.auth.clientId ?? connector.auth.clientMetadataUrl
    if (!clientId) throw new Error('OAuth public client identity is unavailable')
    const body = new URLSearchParams({
      token: secret.tokens.refresh_token ?? secret.tokens.access_token,
      client_id: clientId,
    })
    const response = await fetchFn(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`OAuth token revocation failed with HTTP ${response.status}`)
    await response.body?.cancel()
  }

  private async refreshWithLock(
    id: string,
    connector: StoredConnector,
    original: OAuthSecret,
  ): Promise<OAuthSecret> {
    return withFileLock(this.lockDirectory, id, async () => {
      const latest = await this.readOAuthSecret(id)
      if (latest.tokens.access_token !== original.tokens.access_token) return latest
      if (!latest.tokens.refresh_token) {
        await this.requireReauth(id)
        throw new OAuthReauthorizationError('OAuth refresh token is missing; reauthorization is required')
      }
      try {
        const tokens = await this.refresh(connector, latest.tokens.refresh_token)
        const next = secretFromTokens(tokens, this.now(), latest.account)
        await this.secrets.write(id, next)
        return next
      } catch (error) {
        if (isInvalidGrant(error)) {
          await this.requireReauth(id)
          throw new OAuthReauthorizationError('OAuth refresh token was rejected; reauthorization is required')
        }
        throw error
      }
    })
  }

  private async refresh(connector: StoredConnector, refreshToken: string): Promise<OAuthTokens> {
    if (connector.auth.type !== 'oauth') throw new Error('OAuth refresh requires OAuth configuration')
    const fetchFn = this.guardedFetch.bind(this)
    const discovered = await discoverOAuthServerInfo(connector.remote.url, { fetchFn })
    const metadata = discovered.authorizationServerMetadata
    const issuer = metadata?.issuer ?? String(discovered.authorizationServerUrl)
    const clientId = connector.auth.clientId ?? connector.auth.clientMetadataUrl
    if (!clientId) throw new Error('OAuth public client identity is unavailable')
    return refreshAuthorization(discovered.authorizationServerUrl, {
      metadata,
      clientInformation: { client_id: clientId, token_endpoint_auth_method: 'none', issuer },
      refreshToken,
      resource: discovered.resourceMetadata?.resource ?? connector.remote.url,
      fetchFn,
    })
  }

  private async readOAuthSecret(id: string): Promise<OAuthSecret> {
    const secret = await this.secrets.read(id)
    if (!secret || !('tokens' in secret)) throw new Error('OAuth credential is missing or invalid')
    return secret
  }

  private async requireReauth(id: string): Promise<void> {
    await this.onReauthRequired?.(id)
  }

  private guardedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : input)
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    if (method.toUpperCase() === 'POST' && /\/(?:register|registration)$/.test(url.pathname)) {
      throw new Error('Dynamic OAuth client registration is forbidden')
    }
    return this.fetchImpl(input, init)
  }
}

export class OAuthReauthorizationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OAuthReauthorizationError'
  }
}

function secretFromTokens(
  tokens: OAuthTokens,
  now: Date,
  account?: Record<string, unknown>,
): OAuthSecret {
  return {
    v: 1,
    tokens: {
      access_token: tokens.access_token,
      ...(tokens.refresh_token === undefined ? {} : { refresh_token: tokens.refresh_token }),
      expires_at: tokens.expires_in === undefined
        ? Number.MAX_SAFE_INTEGER
        : now.getTime() + tokens.expires_in * 1000,
      ...(tokens.scope === undefined ? {} : { scope: tokens.scope }),
    },
    ...(account === undefined ? {} : { account: structuredClone(account) }),
  }
}

function isInvalidGrant(error: unknown): boolean {
  return error instanceof OAuthError && error.code === OAuthErrorCode.InvalidGrant
}

async function withFileLock<T>(directory: string, id: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(directory, { recursive: true })
  const path = resolve(directory, `${id}.lock`)
  let handle
  while (!handle) {
    try {
      handle = await open(path, 'wx', 0o600)
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), 'utf8')
    } catch (error) {
      if (!isErrorCode(error, 'EEXIST')) {
        await handle?.close().catch(() => {})
        throw error
      }
      const info = await stat(path).catch(error => {
        if (isErrorCode(error, 'ENOENT')) return null
        throw error
      })
      if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) await unlink(path).catch(() => {})
      else await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  try {
    return await operation()
  } finally {
    await handle.close()
    await unlink(path).catch(() => {})
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === code
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
