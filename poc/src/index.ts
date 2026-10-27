/**
 * Connector hub PoC, Host half.
 *
 * On apply it mounts one `@deepseek-ai/dsh-mcp-client` child plugin for the
 * local test server (`pocdemo` at http://127.0.0.1:3988/mcp). Each mount
 * sends a new `X-Connector-Token` header value, standing in for a refreshed
 * credential. While the Web connection service is mounted it registers
 * owner-only routes on the `/api` channel:
 *
 * - `status` / `keychain-test`: runtime facts and one OS keychain round trip;
 * - `mcp-status`: the child fiber's state and the `mcp__pocdemo__*` tools seen
 *   globally and by every live Agent;
 * - `mcp-probe`: a direct connect + `tools/list` against the server;
 * - `mcp-remount`: dispose the child and mount it again, reporting the tool
 *   names before, in between, and after.
 */
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

const require = createRequire(import.meta.url)
const KEYCHAIN_SERVICE = 'dsh-connector-hub-poc'
const SERVER_NAME = 'pocdemo'
const SERVER_URL = 'http://127.0.0.1:3988/mcp'
const TOOL_PREFIX = `mcp__${SERVER_NAME}__`
const PROBE_TIMEOUT_MS = 10_000
/** Index → name for Cordis `FiberState`, a const enum that is not available at runtime. */
const FIBER_STATES = ['PENDING', 'LOADING', 'ACTIVE', 'FAILED', 'DISPOSED', 'UNLOADING'] as const

/** Exact Fetch route accepted by `ctx.connection.fetch.register`. */
interface FetchRoute {
  path: string
  methods: Array<'GET' | 'POST'>
  requestBody: 'buffered'
  fetch: (request: Request) => Promise<Response>
}

/** The Cordis fiber members this PoC reads; `ctx.plugin()` also makes it awaitable. */
interface Fiber extends PromiseLike<unknown> {
  state: number
  dispose(): Promise<void>
}

interface ToolsService {
  /** Present in both 0.2.1-rc.3 and later releases (`definitions()` is not in 0.2.1-rc.3). */
  schemas(scope?: object): ReadonlyArray<{ name: string }>
}

interface AgentsService {
  list(): Array<{ id: string }>
}

/** The Host context members this PoC touches. */
interface HostContext {
  inject(deps: string[], callback: (scope: HostContext) => void): void
  effect(execute: () => unknown, label?: string): unknown
  plugin(plugin: object, config: object): Fiber
  get(name: 'tools'): ToolsService | undefined
  get(name: 'agents'): AgentsService | undefined
  logger: { info(...args: unknown[]): void, warn(...args: unknown[]): void }
  connection: { fetch: { register(route: FetchRoute): () => Promise<void> } }
}

/** `@napi-rs/keyring`'s Entry, as far as this check uses it. */
interface KeyringEntry {
  setPassword(password: string): void
  getPassword(): string | null | undefined
  deletePassword(): boolean
}

/** One mount of the MCP client child plugin. */
interface Mount {
  fiber: Fiber
  generation: number
  token: string
  mountedAt: string
  settled: boolean
  error?: string
}

export const name = 'connector-hub-poc'

/**
 * Mount the test connector and register the PoC routes whenever the
 * connection service is available.
 * @param ctx - the Host plugin context.
 */
export function apply(ctx: HostContext): void {
  ctx.logger.info('connector-hub-poc: loaded in %s (electron %s)', process.execPath, process.versions.electron ?? 'none')

  let generation = 0
  let current = mount()

  function mount(): Mount {
    generation += 1
    const token = `gen-${generation}`
    const fiber = ctx.plugin(mcpClient, {
      serverName: SERVER_NAME,
      transport: 'streamable-http',
      url: SERVER_URL,
      headers: { 'X-Connector-Token': token },
      failOnStartupError: true,
    })
    const record: Mount = { fiber, generation, token, mountedAt: new Date().toISOString(), settled: false }
    fiber.then(
      () => { record.settled = true },
      (error: unknown) => {
        record.settled = true
        record.error = String(error)
        ctx.logger.warn('connector-hub-poc: %s mount %d failed: %s', SERVER_NAME, record.generation, record.error)
      },
    )
    return record
  }

  function globalToolNames(): string[] | null {
    const tools = ctx.get('tools')
    return tools === undefined ? null : ownTools(tools.schemas())
  }

  function mcpStatus(): Record<string, unknown> {
    const tools = ctx.get('tools')
    const agents = ctx.get('agents')
    const global = globalToolNames()
    const fiberState = FIBER_STATES[current.fiber.state] ?? String(current.fiber.state)
    return {
      connector: { serverName: SERVER_NAME, url: SERVER_URL },
      status: deriveStatus(fiberState, current, global),
      fiberState,
      generation: current.generation,
      token: current.token,
      mountedAt: current.mountedAt,
      error: current.error ?? null,
      tools: {
        global,
        agents: tools === undefined || agents === undefined ? null : agents.list().map(agent => {
          const visible = tools.schemas(agent)
          return { id: agent.id, connectorTools: ownTools(visible), totalVisible: visible.length }
        }),
      },
    }
  }

  async function remount(): Promise<Record<string, unknown>> {
    const before = globalToolNames()
    await current.fiber.dispose()
    const afterDispose = globalToolNames()
    current = mount()
    await settle(current.fiber)
    const after = globalToolNames()
    return {
      before,
      afterDispose,
      after,
      sameNames: before !== null && after !== null && before.length > 0 && sameSet(before, after),
      status: mcpStatus(),
    }
  }

  ctx.inject(['connection'], (scope) => {
    const routes: FetchRoute[] = [
      { path: '/api/connector-hub/status', methods: ['GET'], requestBody: 'buffered', fetch: async () => Response.json(runtimeStatus()) },
      { path: '/api/connector-hub/keychain-test', methods: ['POST'], requestBody: 'buffered', fetch: async () => Response.json(keychainTest()) },
      { path: '/api/connector-hub/mcp-status', methods: ['GET'], requestBody: 'buffered', fetch: async () => Response.json(mcpStatus()) },
      { path: '/api/connector-hub/mcp-probe', methods: ['POST'], requestBody: 'buffered', fetch: async () => Response.json(await probe()) },
      { path: '/api/connector-hub/mcp-remount', methods: ['POST'], requestBody: 'buffered', fetch: async () => Response.json(await remount()) },
    ]
    for (const route of routes) {
      scope.effect(() => scope.connection.fetch.register({ ...route, fetch: request => answerErrors(route.fetch, request) }), `connector-hub-poc: ${route.path}`)
    }
  })
}

/** Report a handler failure as JSON instead of the webserver's empty 400. */
async function answerErrors(handler: (request: Request) => Promise<Response>, request: Request): Promise<Response> {
  try {
    return await handler(request)
  } catch (error) {
    return Response.json({ ok: false, error: String(error), stack: error instanceof Error ? error.stack : undefined }, { status: 500 })
  }
}

function ownTools(schemas: ReadonlyArray<{ name: string }>): string[] {
  return schemas.map(schema => schema.name).filter(toolName => toolName.startsWith(TOOL_PREFIX)).sort()
}

function deriveStatus(fiberState: string, mount: Mount, global: string[] | null): string {
  if (fiberState === 'FAILED' || mount.error !== undefined) return 'failed'
  if (fiberState === 'PENDING' || fiberState === 'LOADING' || !mount.settled) return 'connecting'
  if (fiberState !== 'ACTIVE') return fiberState.toLowerCase()
  return global !== null && global.length > 0 ? 'connected' : 'no-tools'
}

function settle(fiber: Fiber): Promise<void> {
  return new Promise(resolve => { fiber.then(() => resolve(), () => resolve()) })
}

function sameSet(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

async function probe(): Promise<Record<string, unknown>> {
  const started = performance.now()
  const client = new Client({ name: 'connector-hub-poc-probe', version: '0.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(SERVER_URL), {
    requestInit: { headers: { 'X-Connector-Token': 'probe' } },
  })
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`no answer within ${PROBE_TIMEOUT_MS} ms`)), PROBE_TIMEOUT_MS).unref()
  })
  try {
    await Promise.race([client.connect(transport), timeout])
    const { tools } = await Promise.race([client.listTools(), timeout])
    return { ok: true, ms: Math.round(performance.now() - started), server: client.getServerVersion() ?? null, tools: tools.map(tool => tool.name) }
  } catch (error) {
    return { ok: false, ms: Math.round(performance.now() - started), error: String(error) }
  } finally {
    await client.close().catch((error: unknown) => {
      // The probe result is already decided; a close failure on a dead connection adds nothing.
      void error
    })
  }
}

function runtimeStatus(): Record<string, unknown> {
  return {
    pid: process.pid,
    execPath: process.execPath,
    node: process.versions.node,
    electron: process.versions.electron ?? null,
    runAsNode: process.env.ELECTRON_RUN_AS_NODE === '1',
    platform: process.platform,
    arch: process.arch,
    module: import.meta.url,
    mcpClientModule: resolveOrError('@deepseek-ai/dsh-mcp-client'),
  }
}

function resolveOrError(specifier: string): string {
  try {
    return import.meta.resolve(specifier)
  } catch (error) {
    return `unresolved: ${String(error)}`
  }
}

function keychainTest(): Record<string, unknown> {
  const started = performance.now()
  let Entry: new (service: string, account: string) => KeyringEntry
  try {
    ({ Entry } = require('@napi-rs/keyring') as { Entry: typeof Entry })
  } catch (error) {
    return { ok: false, stage: 'load-native-module', error: String(error) }
  }
  const account = `poc-${randomUUID()}`
  const secret = randomUUID()
  const entry = new Entry(KEYCHAIN_SERVICE, account)
  try {
    entry.setPassword(secret)
    const matched = entry.getPassword() === secret
    const deleted = entry.deletePassword()
    let goneAfterDelete: boolean
    try {
      goneAfterDelete = entry.getPassword() == null
    } catch {
      // keyring reports a missing entry by throwing; that is the expected state here.
      goneAfterDelete = true
    }
    return { ok: matched && deleted && goneAfterDelete, service: KEYCHAIN_SERVICE, account, matched, deleted, goneAfterDelete, ms: Math.round(performance.now() - started) }
  } catch (error) {
    try {
      entry.deletePassword()
    } catch (cleanupError) {
      return { ok: false, stage: 'roundtrip', error: String(error), cleanupError: String(cleanupError), service: KEYCHAIN_SERVICE, account }
    }
    return { ok: false, stage: 'roundtrip', error: String(error), service: KEYCHAIN_SERVICE, account }
  }
}
