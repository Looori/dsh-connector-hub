import type { Context, Fiber } from '@deepseek-ai/cordis'
import * as defaultMcpClient from '@deepseek-ai/dsh-mcp-client'
import type { StoredConnector } from '../shared/config'
import {
  deriveConnectorStatus,
  type ConnectorStatus,
  type MountPhase,
  type ProbeStatusInput,
} from '../shared/status'
import { safeErrorMessage } from './redact'

type MountFiber = Fiber & PromiseLike<Fiber>
type McpClientPlugin = typeof defaultMcpClient

interface GatewayEndpoints {
  endpoint(id: string): { url: string, headers: Record<string, string> }
}

interface ToolRegistry {
  schemas(): ReadonlyArray<{ name: string }>
}

export interface MountManagerOptions {
  context: Context
  gateway: GatewayEndpoints
  /** Test seam; production uses DSH's own mcp-client peer dependency. */
  mcpClient?: McpClientPlugin
  now?: () => Date
}

interface MountEntry {
  id: string
  connector: StoredConnector
  fiber?: MountFiber
  generation: number
  mountedAt: string
  settled: boolean
  error?: string
}

export interface ConnectorMountSnapshot {
  id: string
  enabled: boolean
  status: ConnectorStatus
  phase: MountPhase | null
  generation: number | null
  mountedAt: string | null
  tools: string[]
  error: string | null
}

/** Owns all mcp-client child fibers so later session-scoped switches only change this module. */
export class MountManager {
  private readonly context: Context
  private readonly gateway: GatewayEndpoints
  private readonly mcpClient: McpClientPlugin
  private readonly now: () => Date
  private readonly mounts = new Map<string, MountEntry>()
  private queue: Promise<void> = Promise.resolve()
  private generation = 0

  constructor(options: MountManagerOptions) {
    this.context = options.context
    this.gateway = options.gateway
    this.mcpClient = options.mcpClient ?? defaultMcpClient
    this.now = options.now ?? (() => new Date())
  }

  mount(id: string, connector: StoredConnector): Promise<ConnectorMountSnapshot> {
    return this.serialize(async () => {
      this.mountInternal(id, connector)
      return this.snapshot(id, connector.enabled)
    })
  }

  unmount(id: string): Promise<void> {
    return this.serialize(() => this.unmountInternal(id))
  }

  /** Dispose first, then mount the same serverName and wait until startup succeeds or fails. */
  remount(id: string, connector: StoredConnector): Promise<ConnectorMountSnapshot> {
    return this.serialize(async () => {
      await this.unmountInternal(id)
      const entry = this.mountInternal(id, connector)
      await settle(entry.fiber)
      return this.snapshot(id, connector.enabled)
    })
  }

  /** Reconcile shared config changes without disturbing unchanged live connections. */
  reconcile(connectors: Readonly<Record<string, StoredConnector>>): Promise<void> {
    return this.serialize(async () => {
      for (const id of [...this.mounts.keys()]) {
        if (!connectors[id]?.enabled) await this.unmountInternal(id)
      }
      for (const [id, connector] of Object.entries(connectors)) {
        if (!connector.enabled) continue
        const current = this.mounts.get(id)
        if (!current) this.mountInternal(id, connector)
        else if (!sameMountConfig(current.connector, connector)) {
          await this.unmountInternal(id)
          this.mountInternal(id, connector)
        }
      }
    })
  }

  list(
    connectors: Readonly<Record<string, StoredConnector>>,
    probes: Readonly<Record<string, ProbeStatusInput>> = {},
    reauthRequired: ReadonlySet<string> = new Set(),
  ): ConnectorMountSnapshot[] {
    return Object.entries(connectors).map(([id, connector]) => this.snapshot(
      id,
      connector.enabled,
      probes[id],
      reauthRequired.has(id),
    ))
  }

  dispose(): Promise<void> {
    return this.serialize(async () => {
      for (const id of [...this.mounts.keys()]) await this.unmountInternal(id)
    })
  }

  private mountInternal(id: string, connector: StoredConnector): MountEntry {
    const existing = this.mounts.get(id)
    if (existing) throw new Error(`Connector ${id} is already mounted`)

    const entry: MountEntry = {
      id,
      connector: structuredClone(connector),
      generation: ++this.generation,
      mountedAt: this.now().toISOString(),
      settled: false,
    }
    this.mounts.set(id, entry)

    try {
      const endpoint = this.gateway.endpoint(id)
      const fiber = this.context.plugin(this.mcpClient, {
        transport: 'streamable-http',
        serverName: id,
        url: endpoint.url,
        headers: endpoint.headers,
        failOnStartupError: true,
      })
      entry.fiber = fiber
      fiber.then(
        () => { entry.settled = true },
        (error: unknown) => {
          entry.settled = true
          entry.error = safeErrorMessage(error)
          this.context.logger.warn('connector-hub: %s mount failed: %s', id, entry.error)
        },
      )
    } catch (error) {
      entry.settled = true
      entry.error = safeErrorMessage(error)
      this.context.logger.warn('connector-hub: %s mount failed: %s', id, entry.error)
    }
    return entry
  }

  private async unmountInternal(id: string): Promise<void> {
    const entry = this.mounts.get(id)
    if (!entry) return
    this.mounts.delete(id)
    await entry.fiber?.dispose()
  }

  private snapshot(
    id: string,
    enabled: boolean,
    probe?: ProbeStatusInput,
    requiresReauth = false,
  ): ConnectorMountSnapshot {
    const entry = this.mounts.get(id)
    const registeredTools = this.toolNames(id)
    const phase = entry ? phaseOf(entry.fiber) : null
    const derived = deriveConnectorStatus({
      enabled,
      mount: entry ? { phase: phase ?? 'unknown', settled: entry.settled, error: entry.error } : undefined,
      tools: entry ? registeredTools : [],
      probe,
      requiresReauth,
    })
    return {
      id,
      enabled,
      status: derived.status,
      phase,
      generation: entry?.generation ?? null,
      mountedAt: entry?.mountedAt ?? null,
      tools: registeredTools ?? [],
      error: derived.error,
    }
  }

  private toolNames(id: string): string[] | null {
    const registry = this.context.get('tools') as ToolRegistry | undefined
    if (!registry) return null
    const prefix = `mcp__${id}__`
    return registry.schemas()
      .map(schema => schema.name)
      .filter(name => name.startsWith(prefix))
      .sort()
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }
}

export function phaseOf(fiber: Fiber | undefined): MountPhase {
  if (!fiber) return 'failed'
  return (['pending', 'loading', 'active', 'failed', 'disposed', 'unloading'] as const)[fiber.state] ?? 'unknown'
}

function sameMountConfig(left: StoredConnector, right: StoredConnector): boolean {
  return JSON.stringify({ remote: left.remote, auth: left.auth })
    === JSON.stringify({ remote: right.remote, auth: right.auth })
}

async function settle(fiber: MountFiber | undefined): Promise<void> {
  if (!fiber) return
  await fiber.then(() => undefined, () => undefined)
}
