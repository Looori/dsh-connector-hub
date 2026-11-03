import { describe, expect, it } from 'vitest'
import { deriveConnectorStatus } from '../packages/connector-hub/src/shared/status'

const activeMount = { phase: 'active', settled: true }

describe('deriveConnectorStatus', () => {
  it('uses disabled and reauthorization states before runtime health', () => {
    expect(deriveConnectorStatus({
      enabled: false,
      mount: { phase: 'failed', settled: true, error: 'stale failure' },
      tools: [],
      probe: { ok: false, error: 'stale probe' },
    })).toEqual({ status: 'disabled', error: null })

    expect(deriveConnectorStatus({
      enabled: true,
      mount: activeMount,
      tools: [],
      requiresReauth: true,
    })).toEqual({ status: 'reauth-required', error: null })
  })

  it.each([
    [{ phase: 'pending', settled: false }, undefined],
    [{ phase: 'loading', settled: false }, []],
    [{ phase: 'active', settled: false }, []],
  ])('reports connecting while mount startup is unsettled', (mount, tools) => {
    expect(deriveConnectorStatus({ enabled: true, mount, tools }).status).toBe('connecting')
  })

  it('reports a connected active mount even when the server publishes no tools', () => {
    expect(deriveConnectorStatus({
      enabled: true,
      mount: activeMount,
      tools: [],
      probe: { ok: true },
    })).toEqual({ status: 'connected', error: null })
  })

  it('surfaces mount, registry and probe failures with safe summaries', () => {
    expect(deriveConnectorStatus({
      enabled: true,
      mount: { phase: 'failed', settled: true, error: 'serverName already in use' },
      tools: [],
    })).toEqual({ status: 'failed', error: 'serverName already in use' })

    expect(deriveConnectorStatus({
      enabled: true,
      mount: activeMount,
      tools: null,
    })).toEqual({ status: 'failed', error: 'DSH tool registry is unavailable' })

    expect(deriveConnectorStatus({
      enabled: true,
      mount: activeMount,
      tools: ['mcp__amap__maps_geo'],
      probe: { ok: false, error: 'Invalid API Key' },
    })).toEqual({ status: 'failed', error: 'Invalid API Key' })
  })

  it('treats an enabled but unexpectedly disposed mount as failed', () => {
    expect(deriveConnectorStatus({
      enabled: true,
      mount: { phase: 'disposed', settled: true },
      tools: [],
    })).toEqual({ status: 'failed', error: 'MCP client is disposed' })
  })
})
