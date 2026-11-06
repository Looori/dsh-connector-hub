import { describe, expect, it, vi } from 'vitest'
import { registerHostRoutes } from '../packages/connector-hub/src/host/routes'
import { ConnectorHubError } from '../packages/connector-hub/src/host/service'

describe('Host routes', () => {
  it('registers the catalog, API Key and OAuth lifecycle endpoints', () => {
    const { routes } = routeFixture()
    expect(routes.map(route => [route.path, route.methods[0]])).toEqual([
      ['/api/connector-hub/catalog', 'GET'],
      ['/api/connector-hub/catalog-refresh', 'POST'],
      ['/api/connector-hub/connectors', 'GET'],
      ['/api/connector-hub/api-key-connect', 'POST'],
      ['/api/connector-hub/oauth-start', 'POST'],
      ['/api/connector-hub/oauth-status', 'POST'],
      ['/api/connector-hub/oauth-cancel', 'POST'],
      ['/api/connector-hub/remount', 'POST'],
      ['/api/connector-hub/set-enabled', 'POST'],
      ['/api/connector-hub/probe', 'POST'],
      ['/api/connector-hub/remove', 'POST'],
    ])
    expect(routes.every(route => route.requestBody === 'buffered')).toBe(true)
  })

  it('passes a valid API Key request to Host without echoing the Key', async () => {
    const { service, routes } = routeFixture()
    service.connectApiKey.mockResolvedValue({ id: 'amap', status: 'connected' })
    const route = routes.find(route => route.path.endsWith('/api-key-connect'))

    const response = await route.fetch(new Request('http://localhost', {
      method: 'POST', body: JSON.stringify({ id: 'amap', key: 'api-secret' }),
    }))
    expect(response.status).toBe(200)
    expect(service.connectApiKey).toHaveBeenCalledWith('amap', 'api-secret')
    expect(await response.text()).not.toContain('api-secret')
  })

  it('allows an omitted Key only for catalog updates and forwards the update flag', async () => {
    const { service, routes } = routeFixture()
    service.connectApiKey.mockResolvedValue({ id: 'amap', status: 'connected' })
    service.startOAuth.mockResolvedValue({ attemptId: 'attempt', authorizationUrl: 'https://example.com/auth' })
    const connect = routes.find(route => route.path.endsWith('/api-key-connect'))
    const oauth = routes.find(route => route.path.endsWith('/oauth-start'))

    const updated = await connect.fetch(new Request('http://localhost', {
      method: 'POST', body: JSON.stringify({ id: 'amap', applyCatalogUpdate: true }),
    }))
    expect(updated.status).toBe(200)
    expect(service.connectApiKey).toHaveBeenCalledWith('amap', undefined, { applyCatalogUpdate: true })
    const missing = await connect.fetch(new Request('http://localhost', {
      method: 'POST', body: JSON.stringify({ id: 'amap' }),
    }))
    expect(missing.status).toBe(400)
    const invalid = await connect.fetch(new Request('http://localhost', {
      method: 'POST', body: JSON.stringify({ id: 'amap', key: 'secret', applyCatalogUpdate: 'yes' }),
    }))
    expect(invalid.status).toBe(400)

    await oauth.fetch(new Request('http://localhost', {
      method: 'POST', body: JSON.stringify({ id: 'notion', applyCatalogUpdate: true }),
    }))
    expect(service.startOAuth).toHaveBeenCalledWith('notion', { applyCatalogUpdate: true })
  })

  it.each([
    [{ id: 'amap', key: 'secret', url: 'https://attacker.example' }, 'Unexpected request field'],
    [{ id: 'amap' }, 'Missing request field'],
    [{ id: 'INVALID', key: 'secret' }, undefined],
  ])('rejects malformed API Key input before calling the service', async (body, message) => {
    const { service, routes } = routeFixture()
    const route = routes.find(route => route.path.endsWith('/api-key-connect'))
    const response = await route.fetch(new Request('http://localhost', { method: 'POST', body: JSON.stringify(body) }))
    expect(response.status).toBe(400)
    if (message) expect(await response.text()).toContain(message)
    expect(service.connectApiKey).not.toHaveBeenCalled()
  })

  it('validates OAuth requests and forwards only the id or attemptId', async () => {
    const { service, routes } = routeFixture()
    const start = routes.find(route => route.path.endsWith('/oauth-start'))
    const status = routes.find(route => route.path.endsWith('/oauth-status'))
    const cancel = routes.find(route => route.path.endsWith('/oauth-cancel'))
    const id = '123e4567-e89b-42d3-a456-426614174000'

    await start.fetch(new Request('http://localhost', { method: 'POST', body: '{"id":"notion"}' }))
    await status.fetch(new Request('http://localhost', { method: 'POST', body: JSON.stringify({ attemptId: id }) }))
    await cancel.fetch(new Request('http://localhost', { method: 'POST', body: JSON.stringify({ attemptId: id }) }))
    expect(service.startOAuth).toHaveBeenCalledWith('notion')
    expect(service.oauthStatus).toHaveBeenCalledWith(id)
    expect(service.cancelOAuth).toHaveBeenCalledWith(id)

    expect((await status.fetch(new Request('http://localhost', {
      method: 'POST', body: JSON.stringify({ attemptId: id, code: 'must-not-be-here' }),
    }))).status).toBe(400)
    expect((await cancel.fetch(new Request('http://localhost', {
      method: 'POST', body: '{"attemptId":"invalid"}',
    }))).status).toBe(400)
  })

  it('validates set-enabled and remove bodies strictly', async () => {
    const { service, routes } = routeFixture()
    const setEnabled = routes.find(route => route.path.endsWith('/set-enabled'))
    const remove = routes.find(route => route.path.endsWith('/remove'))

    expect((await setEnabled.fetch(new Request('http://localhost', {
      method: 'POST', body: JSON.stringify({ id: 'amap', enabled: 'yes' }),
    }))).status).toBe(400)
    expect((await remove.fetch(new Request('http://localhost', {
      method: 'POST', body: JSON.stringify({ id: 'amap', key: 'must-not-be-here' }),
    }))).status).toBe(400)
    expect(service.setEnabled).not.toHaveBeenCalled()
    expect(service.remove).not.toHaveBeenCalled()
  })

  it('returns safe JSON errors with the service status code', async () => {
    const { service, routes } = routeFixture()
    service.remove.mockRejectedValue(new ConnectorHubError('Unknown connector; key=secret', 404))
    const route = routes.find(route => route.path.endsWith('/remove'))
    const response = await route.fetch(new Request('http://localhost', { method: 'POST', body: '{"id":"amap"}' }))
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ ok: false, error: 'Unknown connector; key=secret' })
  })
})

function routeFixture() {
  const routes = []
  const service = {
    getCatalog: vi.fn(), refreshCatalog: vi.fn(), listConnectors: vi.fn(),
    connectApiKey: vi.fn(), startOAuth: vi.fn(), oauthStatus: vi.fn(), cancelOAuth: vi.fn(),
    remount: vi.fn(), setEnabled: vi.fn(), probe: vi.fn(), remove: vi.fn(),
  }
  // Capture registrations through the same effect/register boundary used in production.
  const context = {
    effect: register => register(),
    connection: { fetch: { register: route => { routes.push(route); return async () => {} } } },
  }
  registerHostRoutes(context, service)
  return { service, routes, context }
}
