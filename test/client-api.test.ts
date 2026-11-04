import { describe, expect, it, vi } from 'vitest'
import { ConnectorHubApiError, createConnectorHubApi } from '../packages/connector-hub/src/client/api'

describe('connector hub browser API', () => {
  it('uses relative Host routes and JSON POST bodies', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({ catalog: { connectors: [] } }))
      .mockResolvedValueOnce(Response.json({ id: 'amap', status: 'connected' }))
      .mockResolvedValueOnce(Response.json({ removed: true }))
    const api = createConnectorHubApi(fetchImpl)

    await api.getCatalog()
    await api.connectApiKey('amap', 'secret-key')
    await api.remove('amap')

    expect(fetchImpl.mock.calls[0]).toEqual(['api/connector-hub/catalog', undefined])
    expect(fetchImpl.mock.calls[1][0]).toBe('api/connector-hub/api-key-connect')
    expect(fetchImpl.mock.calls[1][1]).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"id":"amap","key":"secret-key"}',
    })
    expect(fetchImpl.mock.calls[2][0]).toBe('api/connector-hub/remove')
  })

  it('surfaces safe Host error messages and HTTP status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json(
      { ok: false, error: 'API Key probe failed' },
      { status: 502 },
    ))
    const api = createConnectorHubApi(fetchImpl)

    const error = await api.probe('amap').catch(value => value)
    expect(error).toBeInstanceOf(ConnectorHubApiError)
    expect(error).toMatchObject({ message: 'API Key probe failed', status: 502 })
  })

  it('falls back to the status code for non-JSON errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('not json', { status: 503 }))
    const api = createConnectorHubApi(fetchImpl)
    await expect(api.listConnectors()).rejects.toMatchObject({ message: 'HTTP 503', status: 503 })
  })

  it('uses attempt IDs for OAuth start, polling and cancellation', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({ attemptId: 'attempt-1', authorizationUrl: 'https://example.com/auth' }))
      .mockResolvedValueOnce(Response.json({ attemptId: 'attempt-1', status: 'waiting' }))
      .mockResolvedValueOnce(Response.json({ cancelled: true }))
    const api = createConnectorHubApi(fetchImpl)

    await api.startOAuth('notion')
    await api.oauthStatus('attempt-1')
    await api.cancelOAuth('attempt-1')

    expect(fetchImpl.mock.calls.map(call => call[0])).toEqual([
      'api/connector-hub/oauth-start',
      'api/connector-hub/oauth-status',
      'api/connector-hub/oauth-cancel',
    ])
    expect(fetchImpl.mock.calls.map(call => JSON.parse(call[1].body))).toEqual([
      { id: 'notion' }, { attemptId: 'attempt-1' }, { attemptId: 'attempt-1' },
    ])
  })
})
