import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { RemoteConfig } from '../shared/catalog'
import type { StoredConnector } from '../shared/config'
import type { ConnectorProbeResult } from '../shared/status'
import { CredentialGateway } from './gateway'
import { safeErrorMessage } from './redact'
import { MemorySecretStore, type OAuthSecret } from './secrets'

export const DEFAULT_PROBE_TIMEOUT_MS = 10_000

export interface ProbeEndpoint {
  url: string
  headers: Record<string, string>
}

export interface ProbeOptions {
  timeoutMs?: number
  now?: () => Date
  probe?: RemoteConfig['probe']
}

/** Probe initialize + tools/list, plus an optional read-only tool, through the credential gateway. */
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
        const tools = await client.listTools()
        if (options.probe) {
          const result = await client.callTool({
            name: options.probe.tool,
            arguments: options.probe.arguments,
          })
          const error = probeToolError(result)
          if (error) throw new Error(`MCP probe tool ${options.probe.tool} failed: ${error}`)
        }
        return tools
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
export function probeApiKeyConnector(
  id: string,
  connector: StoredConnector,
  key: string,
  options: ProbeOptions = {},
): Promise<ConnectorProbeResult> {
  return probeCandidateCredential(id, connector, { v: 1, apiKey: key }, options)
}

/** Probe newly authorized OAuth tokens without replacing a live connection's credentials. */
export function probeOAuthConnector(
  id: string,
  connector: StoredConnector,
  secret: OAuthSecret,
  options: ProbeOptions = {},
): Promise<ConnectorProbeResult> {
  return probeCandidateCredential(id, connector, secret, options)
}

async function probeCandidateCredential(
  id: string,
  connector: StoredConnector,
  secret: Parameters<MemorySecretStore['write']>[1],
  options: ProbeOptions,
): Promise<ConnectorProbeResult> {
  const secrets = new MemorySecretStore()
  await secrets.write(id, secret)
  const gateway = await CredentialGateway.start({
    getConnector: requested => requested === id ? connector : undefined,
    secrets,
  })
  try {
    return await probeConnector(id, gateway.endpoint(id), { ...options, probe: connector.remote.probe })
  } finally {
    await gateway.close()
  }
}

function probeToolError(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null
  const structured = 'structuredContent' in result && result.structuredContent && typeof result.structuredContent === 'object'
    ? result.structuredContent as Record<string, unknown>
    : null
  const structuredError = structured?.error
  if (typeof structuredError === 'string' && structuredError) return structuredError
  if (structuredError !== undefined && structuredError !== null && structuredError !== '' && structuredError !== false) {
    return JSON.stringify(structuredError) ?? String(structuredError)
  }
  if ('isError' in result && result.isError === true) return 'The tool returned isError=true'
  return null
}

function elapsedSince(started: number): number {
  return Math.max(0, Math.round(performance.now() - started))
}
