import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { StoredConnector } from '../shared/config'
import { OAuthReauthorizationError, type OAuthTokenRefresher } from './oauth-refresh'
import type { ApiKeySecret, OAuthSecret, SecretStore } from './secrets'
import { safeErrorMessage } from './redact'

export const GATEWAY_HEADER = 'X-Connector-Hub-Key'
export const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024

const FORWARD_REQUEST_HEADERS = [
  'accept',
  'content-type',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
] as const
const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length', 'content-encoding',
])

export interface CredentialGatewayOptions {
  getConnector(id: string): StoredConnector | undefined | Promise<StoredConnector | undefined>
  secrets: SecretStore
  /** Test-only deterministic key; production uses 32 random bytes. */
  hubKey?: string
  /** Defaults to global fetch so DSH's installed dispatcher remains effective. */
  fetchImpl?: typeof globalThis.fetch
  oauthRefresher?: OAuthTokenRefresher
}

export class CredentialGateway {
  readonly hubKey: string
  private readonly getConnector: CredentialGatewayOptions['getConnector']
  private readonly secrets: SecretStore
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly oauthRefresher?: OAuthTokenRefresher
  private readonly server: Server
  private gatewayOrigin: string | undefined

  private constructor(options: CredentialGatewayOptions) {
    this.getConnector = options.getConnector
    this.secrets = options.secrets
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
    this.oauthRefresher = options.oauthRefresher
    this.hubKey = options.hubKey ?? randomBytes(32).toString('base64url')
    this.server = createServer((request, response) => {
      void this.handle(request, response)
    })
  }

  static async start(options: CredentialGatewayOptions): Promise<CredentialGateway> {
    const gateway = new CredentialGateway(options)
    await new Promise<void>((resolve, reject) => {
      gateway.server.once('error', reject)
      gateway.server.listen(0, '127.0.0.1', () => {
        gateway.server.off('error', reject)
        resolve()
      })
    })
    const address = gateway.server.address()
    if (address === null || typeof address === 'string') throw new Error('Gateway did not bind to a TCP port')
    gateway.gatewayOrigin = `http://127.0.0.1:${address.port}`
    return gateway
  }

  /** Configuration consumed by mcp-client; the key never enters disk storage or logs. */
  endpoint(id: string): { url: string, headers: Record<string, string> } {
    if (!/^[a-z0-9-]{1,24}$/.test(id) || !this.gatewayOrigin) throw new Error('Invalid or unavailable gateway endpoint')
    return {
      url: `${this.gatewayOrigin}/c/${id}/mcp`,
      headers: { [GATEWAY_HEADER]: this.hubKey },
    }
  }

  async close(): Promise<void> {
    if (!this.server.listening) return
    const closed = new Promise<void>((resolve, reject) => {
      this.server.close(error => error ? reject(error) : resolve())
    })
    this.server.closeAllConnections()
    await closed
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const abort = new AbortController()
    const abortOnDisconnect = () => {
      if (!response.writableFinished) abort.abort()
    }
    response.once('close', abortOnDisconnect)
    try {
      const route = parseRoute(request.url ?? '/')
      if (!route) throw new GatewayHttpError(404, 'Unknown gateway route')
      if (!this.authorized(request.headers[GATEWAY_HEADER.toLowerCase()])) {
        throw new GatewayHttpError(403, 'Invalid gateway key')
      }

      const method = request.method ?? 'GET'
      if (!['POST', 'GET', 'DELETE'].includes(method)) throw new GatewayHttpError(405, 'Method not allowed')
      const connector = await this.getConnector(route.id)
      if (!connector) throw new GatewayHttpError(404, 'Unknown connector')

      const upstream = new URL(connector.remote.url)
      const headers = forwardedHeaders(request)
      const body = method === 'GET' ? undefined : await readBody(request)
      const credential = await this.injectCredential(route.id, connector, upstream, headers)

      let upstreamResponse = await this.fetchImpl(upstream, {
        method,
        headers,
        body,
        signal: abort.signal,
      })
      if (upstreamResponse.status === 401 && credential && this.oauthRefresher) {
        await upstreamResponse.body?.cancel().catch(() => {})
        const refreshed = await this.oauthRefresher.afterUnauthorized(route.id, connector, credential)
        headers.set('authorization', `Bearer ${refreshed.tokens.access_token}`)
        upstreamResponse = await this.fetchImpl(upstream, {
          method,
          headers,
          body,
          signal: abort.signal,
        })
      }
      writeUpstreamHeaders(response, upstreamResponse.headers)
      response.writeHead(upstreamResponse.status)
      if (upstreamResponse.body === null) response.end()
      else await pipeline(Readable.fromWeb(
        upstreamResponse.body as unknown as Parameters<typeof Readable.fromWeb>[0],
      ), response)
    } catch (error) {
      if (response.headersSent) {
        response.destroy()
        return
      }
      if (error instanceof GatewayHttpError || error instanceof OAuthReauthorizationError) {
        const status = error instanceof GatewayHttpError ? error.status : 401
        respondJson(response, status, { ok: false, error: error.message })
        return
      }
      const status = abort.signal.aborted ? 499 : 502
      respondJson(response, status, { ok: false, error: safeErrorMessage(error) })
    } finally {
      response.off('close', abortOnDisconnect)
    }
  }

  private authorized(supplied: string | string[] | undefined): boolean {
    const actual = Buffer.from(Array.isArray(supplied) ? '' : supplied ?? '')
    const expected = Buffer.from(this.hubKey)
    const actualDigest = createHash('sha256').update(actual).digest()
    const expectedDigest = createHash('sha256').update(expected).digest()
    return timingSafeEqual(actualDigest, expectedDigest) && actual.length === expected.length
  }

  private async injectCredential(
    id: string,
    connector: StoredConnector,
    upstream: URL,
    headers: Headers,
  ): Promise<OAuthSecret | undefined> {
    const auth = connector.auth
    if (auth.type === 'none') return undefined
    const secret = await this.secrets.read(id)
    if (secret === null) throw new GatewayHttpError(401, 'Connector credential is missing')

    if (auth.type === 'oauth') {
      if (!isOAuthSecret(secret)) throw new GatewayHttpError(401, 'OAuth credential is invalid')
      const credential = this.oauthRefresher
        ? await this.oauthRefresher.validSecret(id, connector)
        : secret
      headers.set('authorization', `Bearer ${credential.tokens.access_token}`)
      return credential
    }
    if (!isApiKeySecret(secret)) throw new GatewayHttpError(401, 'API Key credential is invalid')
    const value = auth.valueTemplate === 'Bearer ${value}' && secret.apiKey.startsWith('Bearer ')
      ? secret.apiKey
      : auth.valueTemplate?.replace('${value}', secret.apiKey) ?? secret.apiKey
    if (auth.in === 'header') headers.set(auth.name, value)
    else upstream.searchParams.set(auth.name, value)
    return undefined
  }
}

class GatewayHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function parseRoute(value: string): { id: string } | null {
  const match = /^\/c\/([a-z0-9-]{1,24})\/mcp$/.exec(value)
  return match ? { id: match[1] } : null
}

function forwardedHeaders(request: IncomingMessage): Headers {
  const headers = new Headers()
  for (const name of FORWARD_REQUEST_HEADERS) {
    const value = request.headers[name]
    if (typeof value === 'string') headers.set(name, value)
  }
  return headers
}

async function readBody(request: IncomingMessage): Promise<ArrayBuffer> {
  const declared = Number(request.headers['content-length'] ?? 0)
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BODY_BYTES) {
    request.resume()
    throw new GatewayHttpError(413, 'Request body exceeds 4 MiB')
  }

  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_REQUEST_BODY_BYTES) throw new GatewayHttpError(413, 'Request body exceeds 4 MiB')
    chunks.push(buffer)
  }
  const result = new Uint8Array(size)
  result.set(Buffer.concat(chunks, size))
  return result.buffer
}

function writeUpstreamHeaders(response: ServerResponse, headers: Headers): void {
  const connectionHeaders = new Set(
    (headers.get('connection') ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean),
  )
  headers.forEach((value, name) => {
    const lower = name.toLowerCase()
    if (!HOP_BY_HOP_HEADERS.has(lower) && !connectionHeaders.has(lower)) response.setHeader(name, value)
  })
}

function respondJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

function isOAuthSecret(secret: OAuthSecret | ApiKeySecret): secret is OAuthSecret {
  return 'tokens' in secret
}

function isApiKeySecret(secret: OAuthSecret | ApiKeySecret): secret is ApiKeySecret {
  return 'apiKey' in secret
}
