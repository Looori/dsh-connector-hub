export interface LocalizedText {
  zh: string
  en: string
}

export interface RemoteConfig {
  type: 'streamable-http'
  url: string
}

export interface OAuthAuthBase {
  type: 'oauth'
  scope?: string
  authorizationParams?: Record<string, string>
  callbackPath: string
}

export type OAuthClientIdentity =
  | { clientId: string, clientMetadataUrl?: never }
  | { clientId?: never, clientMetadataUrl: string }

export type OAuthPortPolicy =
  | { portPolicy: 'random', fixedPort?: never }
  | { portPolicy: 'fixed', fixedPort: number }

export type OAuthAuth = OAuthAuthBase & OAuthClientIdentity & OAuthPortPolicy

export interface ApiKeyAuth {
  type: 'api-key'
  in: 'header' | 'query'
  name: string
  valueTemplate?: string
  label: LocalizedText
  helpUrl: string
}

export interface NoneAuth {
  type: 'none'
}

export type AuthConfig = OAuthAuth | ApiKeyAuth | NoneAuth

export interface CatalogConnector {
  id: string
  name: LocalizedText
  description: LocalizedText
  icon: string
  homepage: string
  publisher: string
  official: boolean
  remote: RemoteConfig
  auth: AuthConfig
}

export interface Catalog {
  schemaVersion: 1
  revision: string
  connectors: CatalogConnector[]
}

export interface CatalogUpdate {
  id: string
  kind: 'changed' | 'removed'
  fields: string[]
}
