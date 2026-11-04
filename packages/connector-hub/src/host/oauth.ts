import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  auth,
  type OAuthClientInformationContext,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from '@modelcontextprotocol/client'
import type { StoredConnector } from '../shared/config'
import { safeErrorMessage } from './redact'
import type { OAuthSecret } from './secrets'

export const OAUTH_ATTEMPT_TIMEOUT_MS = 10 * 60 * 1000

export interface OAuthStartResult {
  attemptId: string
  authorizationUrl: string
}

export interface OAuthAttemptView {
  attemptId: string
  connectorId: string
  status: 'waiting' | 'success' | 'failed'
  error: string | null
}

interface OAuthManagerOptions {
  fetchImpl?: typeof globalThis.fetch
  now?: () => Date
  timeoutMs?: number
}

type AttemptStatus = 'waiting' | 'completing' | 'success' | 'failed'

interface OAuthAttempt {
  attemptId: string
  connectorId: string
  connector: StoredConnector
  provider: SharedClientProvider
  server: Server
  abort: AbortController
  onAuthorized: (secret: OAuthSecret) => Promise<void>
  status: AttemptStatus
  error: string | null
  callbackUsed: boolean
  timer: NodeJS.Timeout
}

/** Owns short-lived loopback callback servers and in-memory authorization attempts. */
export class OAuthManager {
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly now: () => Date
  private readonly timeoutMs: number
  private readonly attempts = new Map<string, OAuthAttempt>()

  constructor(options: OAuthManagerOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.now = options.now ?? (() => new Date())
    this.timeoutMs = options.timeoutMs ?? OAUTH_ATTEMPT_TIMEOUT_MS
  }

  async start(
    id: string,
    connector: StoredConnector,
    onAuthorized: (secret: OAuthSecret) => Promise<void>,
  ): Promise<OAuthStartResult> {
    const config = connector.auth
    if (config.type !== 'oauth') throw new OAuthFlowError('Connector does not use OAuth authentication')
    for (const attempt of this.attempts.values()) {
      if (attempt.connectorId === id && ['waiting', 'completing'].includes(attempt.status)) {
        throw new OAuthFlowError('An OAuth authorization is already in progress for this connector', 409)
      }
    }

    const attemptId = randomUUID()
    const abort = new AbortController()
    let attempt: OAuthAttempt | undefined
    const server = createServer((request, response) => {
      void this.handleCallback(attempt!, request, response)
    })
    try {
      await listen(server, config.portPolicy === 'fixed' ? config.fixedPort : 0)
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('OAuth callback server did not bind to a TCP port')
      const redirectUrl = `http://127.0.0.1:${address.port}${config.callbackPath}`
      const provider = new SharedClientProvider(connector, redirectUrl)
      attempt = {
        attemptId,
        connectorId: id,
        connector: structuredClone(connector),
        provider,
        server,
        abort,
        onAuthorized,
        status: 'waiting',
        error: null,
        callbackUsed: false,
        timer: setTimeout(() => {
          void this.fail(attempt!, 'OAuth authorization timed out')
        }, this.timeoutMs),
      }
      attempt.timer.unref()
      this.attempts.set(attemptId, attempt)
      const activeAttempt = attempt

      const result = await auth(provider, {
        serverUrl: connector.remote.url,
        scope: config.scope,
        fetchFn: (input, init) => this.fetchForAttempt(activeAttempt, input, init),
      })
      if (result !== 'REDIRECT' || !provider.authorizationUrl) {
        throw new Error('OAuth server did not return an authorization redirect')
      }
      return { attemptId, authorizationUrl: provider.authorizationUrl }
    } catch (error) {
      clearTimeout(attempt?.timer)
      this.attempts.delete(attemptId)
      abort.abort()
      await closeServer(server)
      if (isAddressInUse(error) && config.portPolicy === 'fixed') {
        throw new OAuthFlowError(`Fixed OAuth callback port ${config.fixedPort} is already in use`, 409)
      }
      throw error
    }
  }

  status(attemptId: string): OAuthAttemptView {
    const attempt = this.attempts.get(attemptId)
    if (!attempt) throw new OAuthFlowError('Unknown OAuth attempt', 404)
    return {
      attemptId,
      connectorId: attempt.connectorId,
      status: attempt.status === 'success' ? 'success' : attempt.status === 'failed' ? 'failed' : 'waiting',
      error: attempt.error,
    }
  }

  async cancel(attemptId: string): Promise<{ cancelled: true }> {
    const attempt = this.attempts.get(attemptId)
    if (!attempt) throw new OAuthFlowError('Unknown OAuth attempt', 404)
    if (attempt.status === 'completing') throw new OAuthFlowError('OAuth callback is already completing', 409)
    if (attempt.status === 'waiting') await this.fail(attempt, 'OAuth authorization cancelled')
    return { cancelled: true }
  }

  async cancelConnector(id: string): Promise<void> {
    const pending = [...this.attempts.values()].filter(attempt => (
      attempt.connectorId === id && attempt.status === 'waiting'
    ))
    await Promise.all(pending.map(attempt => this.fail(attempt, 'OAuth authorization cancelled')))
  }

  async close(): Promise<void> {
    await Promise.all([...this.attempts.values()].map(async attempt => {
      if (attempt.status === 'waiting' || attempt.status === 'completing') {
        await this.fail(attempt, 'OAuth authorization cancelled')
      }
    }))
  }

  private async handleCallback(
    attempt: OAuthAttempt,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    let callbackAccepted = false
    try {
      if (request.method !== 'GET') {
        respondText(response, 405, 'Method not allowed')
        return
      }
      const config = attempt.connector.auth
      if (config.type !== 'oauth') throw new Error('OAuth attempt has invalid authentication configuration')
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname !== config.callbackPath) {
        respondText(response, 404, 'Not found')
        return
      }
      if (attempt.status !== 'waiting' || attempt.callbackUsed || !sameState(
        url.searchParams.get('state'), attempt.provider.stateValue,
      )) {
        respondText(response, 403, 'Invalid or replayed OAuth callback')
        return
      }
      attempt.callbackUsed = true
      callbackAccepted = true
      attempt.status = 'completing'
      const code = url.searchParams.get('code')
      if (!code) throw new Error(`Authorization callback did not contain a code: ${url.searchParams.get('error') ?? 'unknown error'}`)

      const result = await auth(attempt.provider, {
        serverUrl: attempt.connector.remote.url,
        scope: config.scope,
        authorizationCode: code,
        iss: url.searchParams.get('iss') ?? undefined,
        fetchFn: (input, init) => this.fetchForAttempt(attempt, input, init),
      })
      if (result !== 'AUTHORIZED' || !attempt.provider.savedTokens) throw new Error('OAuth token exchange failed')
      const secret = this.toSecret(attempt.provider.savedTokens)
      await attempt.onAuthorized(secret)
      attempt.status = 'success'
      respondText(response, 200, '已连接，可以关闭此页')
    } catch (error) {
      attempt.status = 'failed'
      attempt.error = safeErrorMessage(error)
      if (!response.headersSent) respondText(response, 400, '授权失败，可以关闭此页')
      else if (!response.writableFinished) response.end()
    } finally {
      if (callbackAccepted) {
        clearTimeout(attempt.timer)
        await closeServer(attempt.server)
      }
    }
  }

  private async fail(attempt: OAuthAttempt, message: string): Promise<void> {
    if (attempt.status === 'success' || attempt.status === 'failed') return
    attempt.status = 'failed'
    attempt.error = message
    clearTimeout(attempt.timer)
    attempt.abort.abort()
    await closeServer(attempt.server)
  }

  private fetchForAttempt(
    attempt: OAuthAttempt,
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : input)
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    if (method.toUpperCase() === 'POST' && /\/(?:register|registration)$/.test(url.pathname)) {
      throw new OAuthFlowError('Dynamic OAuth client registration is forbidden')
    }
    const signal = init?.signal ? AbortSignal.any([init.signal, attempt.abort.signal]) : attempt.abort.signal
    return this.fetchImpl(input, { ...init, signal })
  }

  private toSecret(tokens: StoredOAuthTokens): OAuthSecret {
    return {
      v: 1,
      tokens: {
        access_token: tokens.access_token,
        ...(tokens.refresh_token === undefined ? {} : { refresh_token: tokens.refresh_token }),
        expires_at: tokens.expires_in === undefined
          ? Number.MAX_SAFE_INTEGER
          : this.now().getTime() + tokens.expires_in * 1000,
        ...(tokens.scope === undefined ? {} : { scope: tokens.scope }),
      },
    }
  }
}

export class OAuthFlowError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
    this.name = 'OAuthFlowError'
  }
}

class SharedClientProvider implements OAuthClientProvider {
  readonly redirectUrl: string
  readonly clientMetadataUrl?: string
  readonly clientMetadata: OAuthClientMetadata
  readonly stateValue = randomBytes(32).toString('base64url')
  authorizationUrl?: string
  savedTokens?: StoredOAuthTokens
  private savedClient?: StoredOAuthClientInformation
  private verifier?: string
  private discovery?: OAuthDiscoveryState
  private readonly auth: Extract<StoredConnector['auth'], { type: 'oauth' }>

  constructor(connector: StoredConnector, redirectUrl: string) {
    if (connector.auth.type !== 'oauth') throw new Error('OAuth provider requires OAuth configuration')
    this.auth = connector.auth
    this.redirectUrl = redirectUrl
    this.clientMetadataUrl = this.auth.clientMetadataUrl
    this.clientMetadata = {
      client_name: 'DSH Connector Hub',
      client_uri: 'https://looori.github.io/dsh-connector-hub/',
      redirect_uris: [redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: 'native',
      ...(this.auth.scope === undefined ? {} : { scope: this.auth.scope }),
    }
  }

  clientInformation(context?: OAuthClientInformationContext): StoredOAuthClientInformation | undefined {
    if (this.savedClient) return structuredClone(this.savedClient)
    if (!this.auth.clientId) return undefined
    return {
      client_id: this.auth.clientId,
      token_endpoint_auth_method: 'none',
      ...(context?.issuer === undefined ? {} : { issuer: context.issuer }),
    }
  }

  saveClientInformation(value: StoredOAuthClientInformation): void {
    const expected = this.auth.clientId ?? this.auth.clientMetadataUrl
    if (value.client_id !== expected || 'client_secret' in value) {
      throw new OAuthFlowError('OAuth client information does not match the shared public client')
    }
    this.savedClient = structuredClone(value)
  }

  tokens(): StoredOAuthTokens | undefined {
    return this.savedTokens
  }

  saveTokens(tokens: StoredOAuthTokens): void {
    this.savedTokens = structuredClone(tokens)
  }

  state(): string {
    return this.stateValue
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error('OAuth PKCE verifier is unavailable')
    return this.verifier
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.discovery = structuredClone(state)
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discovery
  }

  redirectToAuthorization(url: URL): void {
    for (const [key, value] of Object.entries(this.auth.authorizationParams ?? {})) {
      url.searchParams.set(key, value)
    }
    this.authorizationUrl = url.toString()
  }
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError)
      resolve()
    })
  })
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve()
  const closed = new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  })
  server.closeAllConnections()
  return closed
}

function sameState(actual: string | null, expected: string): boolean {
  if (!actual) return false
  const left = Buffer.from(actual)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

function isAddressInUse(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EADDRINUSE'
}

function respondText(response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  response.end(text)
}
