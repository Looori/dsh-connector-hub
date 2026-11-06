import type { AuthConfig, RemoteConfig } from './catalog'

export const CONNECTOR_CONFIG_VERSION = 1
export const CONNECTOR_ID_PATTERN = /^[a-z0-9-]{1,24}$/

export interface StoredConnector {
  catalogRevision: string
  remote: RemoteConfig
  auth: AuthConfig
  enabled: boolean
  addedAt: string
}

export interface ConnectorConfig {
  schemaVersion: 1
  connectors: Record<string, StoredConnector>
}

export type ConfigMigration = (value: unknown) => unknown

export class ConnectorConfigError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid' | 'unsupported-version' | 'missing-migration',
  ) {
    super(message)
    this.name = 'ConnectorConfigError'
  }
}

export function emptyConnectorConfig(): ConnectorConfig {
  return { schemaVersion: CONNECTOR_CONFIG_VERSION, connectors: {} }
}

/** Migrate an unknown on-disk value to the current version without mutating it. */
export function migrateConnectorConfig(
  value: unknown,
  migrations: Readonly<Record<number, ConfigMigration>> = {},
): unknown {
  if (!isRecord(value)) throw invalid('config must be an object')
  let current = value
  let version = readVersion(current)

  while (version < CONNECTOR_CONFIG_VERSION) {
    const migrate = migrations[version]
    if (!migrate) {
      throw new ConnectorConfigError(`No migration registered for config schemaVersion ${version}`, 'missing-migration')
    }
    const next = migrate(current)
    if (!isRecord(next)) throw invalid(`Migration from schemaVersion ${version} must return an object`)
    const nextVersion = readVersion(next)
    if (nextVersion <= version) throw invalid(`Migration from schemaVersion ${version} did not advance the version`)
    current = next
    version = nextVersion
  }

  if (version !== CONNECTOR_CONFIG_VERSION) {
    throw new ConnectorConfigError(`Unsupported config schemaVersion ${version}`, 'unsupported-version')
  }
  return current
}

export function parseConnectorConfig(
  value: unknown,
  migrations: Readonly<Record<number, ConfigMigration>> = {},
): ConnectorConfig {
  const config = migrateConnectorConfig(value, migrations)
  if (!isRecord(config)) throw invalid('config must be an object')
  if (!isRecord(config.connectors)) throw invalid('config.connectors must be an object')

  for (const [id, connector] of Object.entries(config.connectors)) {
    const path = `config.connectors.${id}`
    if (!CONNECTOR_ID_PATTERN.test(id)) throw invalid(`${path}: invalid connector id`)
    if (!isRecord(connector)) throw invalid(`${path} must be an object`)
    if (typeof connector.catalogRevision !== 'string' || connector.catalogRevision.length === 0) {
      throw invalid(`${path}.catalogRevision must be a non-empty string`)
    }
    if (typeof connector.enabled !== 'boolean') throw invalid(`${path}.enabled must be a boolean`)
    if (typeof connector.addedAt !== 'string' || connector.addedAt.length === 0) {
      throw invalid(`${path}.addedAt must be a non-empty string`)
    }
    validateRemote(connector.remote, path)
    if (!isRecord(connector.auth) || !['oauth', 'api-key', 'none'].includes(String(connector.auth.type))) {
      throw invalid(`${path}.auth has an unsupported type`)
    }
    if (connector.auth.type === 'api-key' && Object.hasOwn(connector.auth, 'valueTemplate')
      && (typeof connector.auth.valueTemplate !== 'string'
        || connector.auth.valueTemplate.split('${value}').length !== 2)) {
      throw invalid(`${path}.auth.valueTemplate must contain exactly one \${value} placeholder`)
    }
    assertNoSecrets(connector, path)
  }
  return config as unknown as ConnectorConfig
}

function validateRemote(remote: unknown, path: string): void {
  if (!isRecord(remote) || remote.type !== 'streamable-http' || typeof remote.url !== 'string') {
    throw invalid(`${path}.remote must be a streamable-http remote`)
  }
  let url: URL
  try {
    url = new URL(remote.url)
  } catch {
    throw invalid(`${path}.remote.url must be a valid URL`)
  }
  const loopbackHttp = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !loopbackHttp) throw invalid(`${path}.remote.url must use HTTPS`)
}

function assertNoSecrets(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecrets(item, `${path}[${index}]`))
    return
  }
  if (!isRecord(value)) return
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[_-]/g, '')
    if (['token', 'accesstoken', 'refreshtoken', 'apikey', 'secret', 'clientsecret', 'password'].includes(normalized)) {
      throw invalid(`${path}.${key}: credentials are not allowed in connector config`)
    }
    assertNoSecrets(child, `${path}.${key}`)
  }
}

function readVersion(value: Record<string, unknown>): number {
  if (!Number.isInteger(value.schemaVersion) || Number(value.schemaVersion) < 0) {
    throw invalid('config.schemaVersion must be a non-negative integer')
  }
  return Number(value.schemaVersion)
}

function invalid(message: string): ConnectorConfigError {
  return new ConnectorConfigError(message, 'invalid')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
