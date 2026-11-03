import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { StoredConnector } from '../shared/config'
import type { ConnectorProbeResult } from '../shared/status'
import { CredentialGateway } from './gateway'
import { safeErrorMessage } from './redact'
import { MemorySecretStore } from './secrets'

export const DEFAULT_PROBE_TIMEOUT_MS = 10_000

export interface ProbeEndpoint {
  url: string
  headers: Record<string, string>
}

export interface ProbeOptions {
  timeoutMs?: number
  now?: () => Date
}

/** Probe initialize + tools/list through the same credential gateway used by real tool calls. */
export async function probeConnector(
  id: string,
  endpoint: ProbeEndpoint,
  options: ProbeOptions = {},
): Promise<ConnectorProbeResult> {
  const started = performance.now()
  const now = options.now ?? (() => new Date())
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
  const client = new Client({ name: 'dsh-connector-hub-probe', version: '0.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(endpoint.url), {
    requestInit: { headers: endpoint.headers },
  })

  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`MCP probe timed out after ${timeoutMs} ms`)), timeoutMs)
    timer.unref()
  })

  try {
    const tools = await Promise.race([
      (async () => {
        await client.connect(transport)
        return client.listTools()
      })(),
      deadline,
    ])
    return {
      ok: true,
      checkedAt: now().toISOString(),
      durationMs: elapsedSince(started),
      tools: tools.tools.map(tool => `mcp__${id}__${tool.name}`).sort(),
      server: client.getServerVersion() ?? null,
      error: null,
    }
  } catch (error) {
    return {
      ok: false,
      checkedAt: now().toISOString(),
      durationMs: elapsedSince(started),
      tools: [],
      server: null,
      error: safeErrorMessage(error),
    }
  } finally {
    if (timer) clearTimeout(timer)
    await client.close().catch(() => {})
  }
}

/** Probe a candidate Key on an isolated gateway so live mounts keep using the previous credential. */
export async function probeApiKeyConnector(
  id: string,
  connector: StoredConnector,
  key: string,
  options: ProbeOptions = {},
): Promise<ConnectorProbeResult> {
  const secrets = new MemorySecretStore()
  await secrets.write(id, { v: 1, apiKey: key })
  const gateway = await CredentialGateway.start({
    getConnector: requested => requested === id ? connector : undefined,
    secrets,
  })
  try {
    return await probeConnector(id, gateway.endpoint(id), options)
  } finally {
    await gateway.close()
  }
}

function elapsedSince(started: number): number {
  return Math.max(0, Math.round(performance.now() - started))
}
