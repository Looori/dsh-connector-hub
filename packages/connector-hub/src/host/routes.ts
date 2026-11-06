import type { Context } from '@deepseek-ai/cordis'
import { OAuthFlowError } from './oauth'
import { safeErrorMessage } from './redact'
import { ConnectorHubError, type ConnectorHubService } from './service'

interface FetchRoute {
  path: string
  methods: Array<'GET' | 'POST'>
  requestBody: 'buffered'
  fetch: (request: Request) => Promise<Response>
}

interface ConnectionContext {
  effect(execute: () => unknown, label?: string): unknown
  connection: { fetch: { register(route: FetchRoute): () => Promise<void> } }
}

/** Register owner-only DSH routes; browser input can select catalog IDs but never upstream URLs. */
export function registerHostRoutes(ctx: Context, service: ConnectorHubService): void {
  const scope = ctx as unknown as ConnectionContext
  const routes: FetchRoute[] = [
    route('/api/connector-hub/catalog', 'GET', () => service.getCatalog()),
    route('/api/connector-hub/catalog-refresh', 'POST', () => service.refreshCatalog()),
    route('/api/connector-hub/connectors', 'GET', () => service.listConnectors()),
    route('/api/connector-hub/api-key-connect', 'POST', async request => {
      const body = await jsonBody(request, ['id'], ['key', 'applyCatalogUpdate'])
      if (body.applyCatalogUpdate !== undefined && typeof body.applyCatalogUpdate !== 'boolean') {
        throw new ConnectorHubError('applyCatalogUpdate must be a boolean')
      }
      if (body.key === undefined && body.applyCatalogUpdate !== true) {
        throw new ConnectorHubError('Missing request field: key')
      }
      if (body.key !== undefined && (typeof body.key !== 'string' || body.key.length === 0 || body.key.length > 16 * 1024)) {
        throw new ConnectorHubError('Expected a non-empty string API Key')
      }
      if (body.applyCatalogUpdate === true) {
        return service.connectApiKey(stringId(body.id), body.key as string | undefined, { applyCatalogUpdate: true })
      }
      return service.connectApiKey(stringId(body.id), body.key as string)
    }),
    route('/api/connector-hub/oauth-start', 'POST', async request => {
      const body = await jsonBody(request, ['id'], ['applyCatalogUpdate'])
      if (body.applyCatalogUpdate !== undefined && typeof body.applyCatalogUpdate !== 'boolean') {
        throw new ConnectorHubError('applyCatalogUpdate must be a boolean')
      }
      if (body.applyCatalogUpdate === true) {
        return service.startOAuth(stringId(body.id), { applyCatalogUpdate: true })
      }
      return service.startOAuth(stringId(body.id))
    }),
    route('/api/connector-hub/oauth-status', 'POST', async request => {
      const body = await jsonBody(request, ['attemptId'])
      return service.oauthStatus(attemptId(body.attemptId))
    }),
    route('/api/connector-hub/oauth-cancel', 'POST', async request => {
      const body = await jsonBody(request, ['attemptId'])
      return service.cancelOAuth(attemptId(body.attemptId))
    }),
    route('/api/connector-hub/remount', 'POST', async request => {
      const body = await jsonBody(request, ['id'])
      return service.remount(stringId(body.id))
    }),
    route('/api/connector-hub/set-enabled', 'POST', async request => {
      const body = await jsonBody(request, ['id', 'enabled'])
      if (typeof body.enabled !== 'boolean') throw new ConnectorHubError('enabled must be a boolean')
      return service.setEnabled(stringId(body.id), body.enabled)
    }),
    route('/api/connector-hub/probe', 'POST', async request => {
      const body = await jsonBody(request, ['id'])
      return service.probe(stringId(body.id))
    }),
    route('/api/connector-hub/remove', 'POST', async request => {
      const body = await jsonBody(request, ['id'])
      return service.remove(stringId(body.id))
    }),
  ]

  for (const item of routes) {
    scope.effect(
      () => scope.connection.fetch.register({ ...item, fetch: request => answer(item.fetch, request) }),
      `connector-hub: ${item.path}`,
    )
  }
}

function route(
  path: string,
  method: 'GET' | 'POST',
  handler: (request: Request) => Promise<unknown>,
): FetchRoute {
  return { path, methods: [method], requestBody: 'buffered', fetch: async request => Response.json(await handler(request)) }
}

async function answer(handler: (request: Request) => Promise<Response>, request: Request): Promise<Response> {
  try {
    return await handler(request)
  } catch (error) {
    const status = error instanceof ConnectorHubError || error instanceof OAuthFlowError ? error.status : 500
    return Response.json({ ok: false, error: safeErrorMessage(error) }, { status })
  }
}

async function jsonBody(
  request: Request,
  requiredKeys: string[],
  optionalKeys: string[] = [],
): Promise<Record<string, unknown>> {
  let value: unknown
  try { value = await request.json() } catch { throw new ConnectorHubError('Request body must be valid JSON') }
  if (!isRecord(value)) throw new ConnectorHubError('Request body must be a JSON object')
  const allowed = new Set([...requiredKeys, ...optionalKeys])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new ConnectorHubError(`Unexpected request field: ${key}`)
  }
  for (const key of requiredKeys) {
    if (!Object.hasOwn(value, key)) throw new ConnectorHubError(`Missing request field: ${key}`)
  }
  return value
}

function stringId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9-]{1,24}$/.test(value)) {
    throw new ConnectorHubError('id must be a valid connector id')
  }
  return value
}

function attemptId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/.test(value)) {
    throw new ConnectorHubError('attemptId must be a valid OAuth attempt id')
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
