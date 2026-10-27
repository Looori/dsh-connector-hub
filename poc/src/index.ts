/**
 * Connector hub PoC, Host half. While the Web connection service is mounted it
 * registers two owner-only routes on the `/api` channel: `status` reports the
 * runtime the plugin runs in, and `keychain-test` writes, reads, and deletes
 * one OS keychain entry under the `dsh-connector-hub-poc` service.
 */
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const SERVICE = 'dsh-connector-hub-poc'

/** Exact Fetch route accepted by `ctx.connection.fetch.register`. */
interface FetchRoute {
  path: string
  methods: Array<'GET' | 'POST'>
  requestBody: 'buffered'
  fetch: (request: Request) => Promise<Response>
}

/** The Host context members this PoC touches. */
interface HostContext {
  inject(deps: string[], callback: (scope: HostContext) => void): void
  effect(execute: () => unknown, label?: string): unknown
  logger: { info(...args: unknown[]): void }
  connection: { fetch: { register(route: FetchRoute): () => Promise<void> } }
}

/** `@napi-rs/keyring`'s Entry, as far as this check uses it. */
interface KeyringEntry {
  setPassword(password: string): void
  getPassword(): string | null | undefined
  deletePassword(): boolean
}

export const name = 'connector-hub-poc'

/**
 * Register the PoC routes whenever the connection service is available.
 * @param ctx - the Host plugin context.
 */
export function apply(ctx: HostContext): void {
  ctx.logger.info('connector-hub-poc: loaded in %s (electron %s)', process.execPath, process.versions.electron ?? 'none')
  ctx.inject(['connection'], (scope) => {
    scope.effect(() => scope.connection.fetch.register({
      path: '/api/connector-hub/status', methods: ['GET'], requestBody: 'buffered',
      fetch: async () => Response.json(status()),
    }), 'connector-hub-poc: status route')
    scope.effect(() => scope.connection.fetch.register({
      path: '/api/connector-hub/keychain-test', methods: ['POST'], requestBody: 'buffered',
      fetch: async () => Response.json(keychainTest()),
    }), 'connector-hub-poc: keychain route')
  })
}

function status(): Record<string, unknown> {
  return {
    pid: process.pid,
    execPath: process.execPath,
    node: process.versions.node,
    electron: process.versions.electron ?? null,
    runAsNode: process.env.ELECTRON_RUN_AS_NODE === '1',
    platform: process.platform,
    arch: process.arch,
    module: import.meta.url,
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
  const entry = new Entry(SERVICE, account)
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
    return { ok: matched && deleted && goneAfterDelete, service: SERVICE, account, matched, deleted, goneAfterDelete, ms: Math.round(performance.now() - started) }
  } catch (error) {
    try {
      entry.deletePassword()
    } catch (cleanupError) {
      return { ok: false, stage: 'roundtrip', error: String(error), cleanupError: String(cleanupError), service: SERVICE, account }
    }
    return { ok: false, stage: 'roundtrip', error: String(error), service: SERVICE, account }
  }
}
