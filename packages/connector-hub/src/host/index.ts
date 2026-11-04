import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { CatalogService } from './catalog'
import { CredentialGateway } from './gateway'
import { MountManager } from './mounts'
import { OAuthManager } from './oauth'
import { OAuthTokenRefresher } from './oauth-refresh'
import { registerHostRoutes } from './routes'
import { KeychainSecretStore } from './secrets'
import { ConnectorHubService } from './service'
import { ConnectorStore } from './store'

export const name = 'connector-hub'

export interface ConnectorHubConfig {
  catalogUrl?: string
}

/** Compose the Host services against the rc.5 Cordis boundary. */
export async function apply(ctx: Context, config: ConnectorHubConfig = {}): Promise<void> {
  const dshHome = resolveDshHome()
  const store = new ConnectorStore(dshHome)
  await store.read()
  const secrets = new KeychainSecretStore()
  const reauthRequired = new Set<string>()
  let mounts: MountManager | undefined
  const oauthTokens = new OAuthTokenRefresher({
    secrets,
    dshHome,
    onReauthRequired: id => {
      reauthRequired.add(id)
      void mounts?.unmount(id).catch(() => {})
    },
  })
  const gateway = await CredentialGateway.start({
    getConnector: id => store.snapshot()?.connectors[id],
    secrets,
    oauthRefresher: oauthTokens,
  })
  try {
    const catalog = new CatalogService({ dshHome, catalogUrl: config.catalogUrl })
    mounts = new MountManager({ context: ctx, gateway })
    const oauth = new OAuthManager()
    const service = new ConnectorHubService({
      catalog, store, secrets, mounts, gateway, oauth, oauthTokens, reauthRequired,
    })
    await service.start()

    ctx.effect(() => async () => {
      await oauth.close()
      await mounts?.dispose()
      await gateway.close()
    }, 'connector-hub: runtime')
    ctx.inject(['connection'], scope => registerHostRoutes(scope, service))
  } catch (error) {
    await gateway.close()
    throw error
  }
}
