import { Entry } from '@napi-rs/keyring'
import { CONNECTOR_ID_PATTERN } from '../shared/config'

export const KEYCHAIN_SERVICE = 'dsh-connector-hub'
export const SECRET_VERSION = 1

export interface OAuthTokens {
  access_token: string
  refresh_token?: string
  /** Unix epoch milliseconds. */
  expires_at: number
  scope?: string
}

export interface OAuthSecret {
  v: 1
  tokens: OAuthTokens
  account?: Record<string, unknown>
}

export interface ApiKeySecret {
  v: 1
  apiKey: string
}

export type ConnectorSecret = OAuthSecret | ApiKeySecret

export interface SecretStore {
  read(id: string): Promise<ConnectorSecret | null>
  write(id: string, secret: ConnectorSecret): Promise<void>
  delete(id: string): Promise<boolean>
}

export class SecretFormatError extends Error {
  constructor(message: string, readonly code: 'invalid' | 'unsupported-version') {
    super(message)
    this.name = 'SecretFormatError'
  }
}

export function encodeSecret(secret: ConnectorSecret): string {
  return JSON.stringify(normalizeSecret(secret))
}

export function decodeSecret(serialized: string): ConnectorSecret {
  let value: unknown
  try {
    value = JSON.parse(serialized)
  } catch {
    throw new SecretFormatError('Stored credential is not valid JSON', 'invalid')
  }
  return normalizeSecret(value)
}

/** In-memory implementation stores serialized values to exercise the same codec boundary. */
export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>()

  async read(id: string): Promise<ConnectorSecret | null> {
    assertConnectorId(id)
    const value = this.values.get(id)
    return value === undefined ? null : decodeSecret(value)
  }

  async write(id: string, secret: ConnectorSecret): Promise<void> {
    assertConnectorId(id)
    this.values.set(id, encodeSecret(secret))
  }

  async delete(id: string): Promise<boolean> {
    assertConnectorId(id)
    return this.values.delete(id)
  }
}

interface KeyringEntry {
  setPassword(password: string): void
  getPassword(): string | null
  deleteCredential(): boolean
}

type EntryFactory = (service: string, account: string) => KeyringEntry

/** macOS keychain implementation; tests inject an Entry factory and never touch real credentials. */
export class KeychainSecretStore implements SecretStore {
  constructor(private readonly entryFactory: EntryFactory = (service, account) => new Entry(service, account)) {}

  async read(id: string): Promise<ConnectorSecret | null> {
    assertConnectorId(id)
    try {
      const value = this.entryFactory(KEYCHAIN_SERVICE, id).getPassword()
      return value === null ? null : decodeSecret(value)
    } catch (error) {
      if (isMissingEntryError(error)) return null
      throw error
    }
  }

  async write(id: string, secret: ConnectorSecret): Promise<void> {
    assertConnectorId(id)
    this.entryFactory(KEYCHAIN_SERVICE, id).setPassword(encodeSecret(secret))
  }

  async delete(id: string): Promise<boolean> {
    assertConnectorId(id)
    try {
      return this.entryFactory(KEYCHAIN_SERVICE, id).deleteCredential()
    } catch (error) {
      if (isMissingEntryError(error)) return false
      throw error
    }
  }
}

function normalizeSecret(value: unknown): ConnectorSecret {
  if (!isRecord(value)) throw new SecretFormatError('Stored credential must be an object', 'invalid')
  if (value.v !== SECRET_VERSION) {
    throw new SecretFormatError('Unsupported credential version', 'unsupported-version')
  }

  if (Object.hasOwn(value, 'apiKey')) {
    if (typeof value.apiKey !== 'string' || value.apiKey.length === 0) {
      throw new SecretFormatError('API Key credential requires a non-empty apiKey', 'invalid')
    }
    return { v: SECRET_VERSION, apiKey: value.apiKey }
  }

  if (!isRecord(value.tokens)) throw new SecretFormatError('OAuth credential requires tokens', 'invalid')
  const tokens = value.tokens
  if (typeof tokens.access_token !== 'string' || tokens.access_token.length === 0) {
    throw new SecretFormatError('OAuth credential requires access_token', 'invalid')
  }
  if (tokens.refresh_token !== undefined && typeof tokens.refresh_token !== 'string') {
    throw new SecretFormatError('OAuth refresh_token must be a string', 'invalid')
  }
  if (typeof tokens.expires_at !== 'number' || !Number.isFinite(tokens.expires_at)) {
    throw new SecretFormatError('OAuth expires_at must be a finite Unix millisecond timestamp', 'invalid')
  }
  if (tokens.scope !== undefined && typeof tokens.scope !== 'string') {
    throw new SecretFormatError('OAuth scope must be a string', 'invalid')
  }
  if (value.account !== undefined && !isRecord(value.account)) {
    throw new SecretFormatError('OAuth account must be an object', 'invalid')
  }

  return {
    v: SECRET_VERSION,
    tokens: {
      access_token: tokens.access_token,
      ...(tokens.refresh_token === undefined ? {} : { refresh_token: tokens.refresh_token }),
      expires_at: tokens.expires_at,
      ...(tokens.scope === undefined ? {} : { scope: tokens.scope }),
    },
    ...(value.account === undefined ? {} : { account: structuredClone(value.account) }),
  }
}

function assertConnectorId(id: string): void {
  if (!CONNECTOR_ID_PATTERN.test(id)) throw new Error('Invalid connector id for credential storage')
}

function isMissingEntryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /noentry|no entry|not found/i.test(message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
