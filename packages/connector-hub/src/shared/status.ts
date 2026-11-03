export type ConnectorStatus = 'connecting' | 'connected' | 'reauth-required' | 'failed' | 'disabled'

export type MountPhase = 'pending' | 'loading' | 'active' | 'failed' | 'disposed' | 'unloading' | 'unknown'

export interface MountStatusInput {
  phase: MountPhase
  settled: boolean
  error?: string
}

export interface ProbeStatusInput {
  ok: boolean
  error?: string | null
}

export interface ConnectorStatusInput {
  enabled: boolean
  mount?: MountStatusInput
  /** Null means the DSH tool registry itself is unavailable; an empty list is valid. */
  tools: string[] | null
  probe?: ProbeStatusInput
  requiresReauth?: boolean
}

export interface DerivedConnectorStatus {
  status: ConnectorStatus
  error: string | null
}

/** Combine configuration, mcp-client lifecycle, tool registration and the latest gateway probe. */
export function deriveConnectorStatus(input: ConnectorStatusInput): DerivedConnectorStatus {
  if (!input.enabled) return { status: 'disabled', error: null }
  if (input.requiresReauth) return { status: 'reauth-required', error: null }

  const mount = input.mount
  if (mount?.error || mount?.phase === 'failed') {
    return { status: 'failed', error: mount.error ?? 'MCP client mount failed' }
  }
  if (!mount || !mount.settled || mount.phase === 'pending' || mount.phase === 'loading') {
    return { status: 'connecting', error: null }
  }
  if (mount.phase !== 'active') {
    return { status: 'failed', error: `MCP client is ${mount.phase}` }
  }
  if (input.tools === null) {
    return { status: 'failed', error: 'DSH tool registry is unavailable' }
  }
  if (input.probe && !input.probe.ok) {
    return { status: 'failed', error: input.probe.error || 'MCP probe failed' }
  }
  return { status: 'connected', error: null }
}

export interface ConnectorProbeResult {
  ok: boolean
  checkedAt: string
  durationMs: number
  /** Fully qualified names visible to the model. */
  tools: string[]
  server: { name: string, version: string } | null
  error: string | null
}
