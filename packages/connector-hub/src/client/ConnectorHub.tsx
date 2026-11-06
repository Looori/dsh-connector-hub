import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import {
  Button,
  DisclosureRow,
  Input,
  Menu,
  Modal,
  SegmentedTabs,
  StateDot,
  Switch,
  Tag,
  Toast,
  type StateDotState,
  type TagTone,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ApiKeyAuth, CatalogConnector, LocalizedText } from '../shared/catalog'
import type { ConnectorStatus } from '../shared/status'
import type { ConnectorView } from '../host/service'
import { createConnectorHubApi, type CatalogResponse, type ConnectorHubApi } from './api'
import type { LocaleKey, Translate } from './locales'

const DEFAULT_POLL_MS = 60_000
const OAUTH_POLL_MS = 500
const OAUTH_SUCCESS_CLOSE_MS = 900

type Page = 'mine' | 'discover'
type KeyMode = 'add' | 'replace'

interface AuthorizationTarget {
  connector: CatalogConnector
  mode: KeyMode
  applyCatalogUpdate?: boolean
}

interface CatalogUpdateTarget {
  connector: ConnectorView
  catalogItem: CatalogConnector
}

export interface ConnectorHubProps {
  t: Translate
  api?: ConnectorHubApi
  resolveText?: (text: LocalizedText) => string
  pollMs?: number
  oauthPollMs?: number
  openWindow?: (url: string, target?: string, features?: string) => Window | null
  copyText?: (text: string) => Promise<void>
}

/** The two-page connector UI. Credentials are passed to Host and never retained by this component. */
export function ConnectorHub({
  t,
  api: providedApi,
  resolveText = defaultResolveText,
  pollMs = DEFAULT_POLL_MS,
  oauthPollMs = OAUTH_POLL_MS,
  openWindow,
  copyText,
}: ConnectorHubProps): ReactNode {
  const api = useMemo(() => providedApi ?? createConnectorHubApi(), [providedApi])
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null)
  const [connectors, setConnectors] = useState<ConnectorView[] | null>(null)
  const [page, setPage] = useState<Page | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [catalogBusy, setCatalogBusy] = useState(false)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [menuId, setMenuId] = useState<string | null>(null)
  const [keyTarget, setKeyTarget] = useState<AuthorizationTarget | null>(null)
  const [oauthTarget, setOauthTarget] = useState<AuthorizationTarget | null>(null)
  const [catalogUpdateTarget, setCatalogUpdateTarget] = useState<CatalogUpdateTarget | null>(null)
  const [removeTarget, setRemoveTarget] = useState<CatalogConnector | null>(null)
  const [toast, setToast] = useState<{ id: number, text: string } | null>(null)
  const toastSequence = useRef(0)
  const probeInProgress = useRef(false)
  const busyIdRef = useRef<string | null>(null)

  const showToast = useCallback((text: string) => {
    setToast({ id: ++toastSequence.current, text })
  }, [])

  const refresh = useCallback(async (probeRequested = false): Promise<ConnectorView[] | null> => {
    const shouldProbe = probeRequested && !probeInProgress.current
    if (shouldProbe) probeInProgress.current = true
    try {
      const [nextCatalog, nextConnectors] = await Promise.all([api.getCatalog(), api.listConnectors()])
      setCatalog(nextCatalog)
      setConnectors(nextConnectors)
      setPage(current => current ?? (nextConnectors.length > 0 ? 'mine' : 'discover'))
      setLoadError(null)
      setLoading(false)

      if (shouldProbe) {
        const probes = await Promise.all(nextConnectors
          .filter(item => item.enabled && item.id !== busyIdRef.current)
          .map(async item => {
            try { return await api.probe(item.id) } catch { return null }
          }))
        const byId = new Map(probes.filter(item => item !== null).map(item => [item.id, item]))
        const probed = nextConnectors.map(item => byId.get(item.id) ?? item)
        setConnectors(probed)
        return probed
      }
      return nextConnectors
    } catch (error) {
      setLoadError(errorMessage(error))
      setLoading(false)
      return null
    } finally {
      if (shouldProbe) probeInProgress.current = false
    }
  }, [api])

  useEffect(() => {
    void refresh(true)
    const timer = setInterval(() => {
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
      void refresh(!hidden)
    }, pollMs)
    return () => clearInterval(timer)
  }, [pollMs, refresh])

  async function runAction(id: string, action: () => Promise<unknown>, success?: LocaleKey): Promise<void> {
    busyIdRef.current = id
    setBusyId(id)
    setActionError(null)
    try {
      await action()
      if (success) showToast(t(success))
      await refresh()
    } catch (error) {
      setActionError(errorMessage(error))
    } finally {
      busyIdRef.current = null
      setBusyId(null)
    }
  }

  async function refreshCatalog(): Promise<void> {
    setCatalogBusy(true)
    setActionError(null)
    try {
      setCatalog(await api.refreshCatalog())
    } catch (error) {
      setActionError(errorMessage(error))
    } finally {
      setCatalogBusy(false)
    }
  }

  async function saveKey(key: string): Promise<void> {
    if (!keyTarget) return
    await api.connectApiKey(keyTarget.connector.id, key)
    showToast(t(keyTarget.mode === 'add' ? 'addedToast' : 'replacedToast'))
    await refresh()
  }

  async function completeOAuth(target: AuthorizationTarget): Promise<string | null> {
    const next = await refresh()
    showToast(t(target.mode === 'add' ? 'authorizedToast' : 'reauthorizedToast'))
    return next?.find(item => item.id === target.connector.id)?.account ?? null
  }

  function toggleExpanded(id: string): void {
    setExpanded(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const currentPage = page ?? 'discover'
  const changedCatalogUpdates = catalog?.updates.filter(update => update.kind === 'changed') ?? []
  const tabItems: [
    { value: 'mine', label: string, id: string, panelId: string },
    { value: 'discover', label: string, id: string, panelId: string },
  ] = [
    { value: 'mine', label: t('mine'), id: 'connector-hub-mine-tab', panelId: 'connector-hub-mine-panel' },
    { value: 'discover', label: t('discover'), id: 'connector-hub-discover-tab', panelId: 'connector-hub-discover-panel' },
  ]

  return (
    <div style={styles.page}>
      <SegmentedTabs items={tabItems} value={currentPage} onChange={setPage} label={t('tabsLabel')} />

      {catalog?.stale && (
        <div style={styles.banner} role="status">
          <span>{t('catalogStale')}</span>
          <Button size="sm" variant="outline" disabled={catalogBusy} onClick={() => { void refreshCatalog() }}>
            {t('refreshCatalog')}
          </Button>
        </div>
      )}
      {changedCatalogUpdates.length > 0 && (
        <div style={styles.banner} role="status">
          <span>{t('catalogUpdates').replace('{names}', changedCatalogUpdates.map(update => {
            const item = catalog?.catalog.connectors.find(connector => connector.id === update.id)
            return item ? resolveText(item.name) : update.id
          }).join(', '))}</span>
          <Button size="sm" variant="outline" onClick={() => setPage('mine')}>{t('goMine')}</Button>
        </div>
      )}
      {actionError !== null && <div role="alert" style={styles.error}>{actionError}</div>}

      {loading && <p style={styles.muted}>{t('loading')}</p>}
      {!loading && loadError !== null && catalog === null && (
        <div style={styles.empty}>
          <strong>{t('loadFailed')}</strong>
          <span style={styles.error}>{loadError}</span>
          <Button variant="outline" onClick={() => { setLoading(true); void refresh() }}>{t('retry')}</Button>
        </div>
      )}

      {!loading && currentPage === 'discover' && catalog !== null && connectors !== null && (
        <section id="connector-hub-discover-panel" role="tabpanel" aria-labelledby="connector-hub-discover-tab">
          <DiscoverPage
            t={t}
            catalog={catalog}
            connectors={connectors}
            resolveText={resolveText}
            onAdd={connector => {
              const target = { connector, mode: 'add' as const }
              if (connector.auth.type === 'oauth') setOauthTarget(target)
              else setKeyTarget(target)
            }}
          />
        </section>
      )}

      {!loading && currentPage === 'mine' && connectors !== null && (
        <section id="connector-hub-mine-panel" role="tabpanel" aria-labelledby="connector-hub-mine-tab">
          {connectors.length === 0 ? (
            <div style={styles.empty}>
              <span>{t('emptyMine')}</span>
              <Button variant="primary" onClick={() => setPage('discover')}>{t('goDiscover')}</Button>
            </div>
          ) : (
            <div style={styles.list}>
              {connectors.map(connector => {
                const catalogItem = catalog?.catalog.connectors.find(item => item.id === connector.id)
                return (
                  <MineRow
                    key={connector.id}
                    t={t}
                    connector={connector}
                    catalogItem={catalogItem}
                    resolveText={resolveText}
                    open={expanded.has(connector.id)}
                    busy={busyId === connector.id}
                    menuOpen={menuId === connector.id}
                    onToggle={() => toggleExpanded(connector.id)}
                    onMenuChange={open => setMenuId(open ? connector.id : null)}
                    onProbe={() => { void runAction(connector.id, async () => {
                      const result = await api.probe(connector.id)
                      if (!result.lastProbe?.ok) {
                        await refresh()
                        throw new Error(result.lastProbe?.error || t('probeFailed'))
                      }
                    }, 'probeSucceeded') }}
                    onRemount={() => { void runAction(connector.id, () => api.remount(connector.id)) }}
                    onSetEnabled={enabled => { void runAction(
                      connector.id,
                      () => api.setEnabled(connector.id, enabled),
                      enabled ? 'enabledToast' : 'disabledToast',
                    ) }}
                    onApplyCatalogUpdate={() => {
                      if (catalogItem && connector.catalogUpdate?.kind === 'changed') {
                        setCatalogUpdateTarget({ connector, catalogItem })
                      }
                    }}
                    onReplaceKey={() => setKeyTarget({ connector: catalogItemFromView(connector), mode: 'replace' })}
                    onReauthorize={() => setOauthTarget({ connector: catalogItemFromView(connector), mode: 'replace' })}
                    onRemove={() => setRemoveTarget(catalogItem ?? catalogItemFromView(connector))}
                  />
                )
              })}
            </div>
          )}
        </section>
      )}

      {catalogUpdateTarget !== null && (
        <CatalogUpdateModal
          t={t}
          target={catalogUpdateTarget}
          resolveText={resolveText}
          api={api}
          onClose={() => setCatalogUpdateTarget(null)}
          onApplyOAuth={() => {
            setCatalogUpdateTarget(null)
            setOauthTarget({
              connector: catalogUpdateTarget.catalogItem,
              mode: 'replace',
              applyCatalogUpdate: true,
            })
          }}
          onApplied={async () => {
            setCatalogUpdateTarget(null)
            showToast(t('catalogUpdateApplied'))
            await refresh()
          }}
        />
      )}
      {keyTarget !== null && (
        <ApiKeyModal
          key={`${keyTarget.connector.id}:${keyTarget.mode}`}
          t={t}
          connector={keyTarget.connector}
          mode={keyTarget.mode}
          resolveText={resolveText}
          onClose={() => setKeyTarget(null)}
          onSave={saveKey}
        />
      )}
      {oauthTarget !== null && (
        <OAuthModal
          key={`${oauthTarget.connector.id}:${oauthTarget.mode}`}
          t={t}
          connector={oauthTarget.connector}
          mode={oauthTarget.mode}
          resolveText={resolveText}
          api={api}
          pollMs={oauthPollMs}
          openWindow={openWindow}
          copyText={copyText}
          applyCatalogUpdate={oauthTarget.applyCatalogUpdate}
          onClose={() => setOauthTarget(null)}
          onAuthorized={() => completeOAuth(oauthTarget)}
        />
      )}
      {removeTarget !== null && (
        <RemoveModal
          t={t}
          connector={removeTarget}
          resolveText={resolveText}
          api={api}
          onClose={() => setRemoveTarget(null)}
          onRemoved={async () => {
            setRemoveTarget(null)
            showToast(t('removedToast'))
            await refresh()
          }}
        />
      )}
      {toast !== null && (
        <Toast key={toast.id} text={toast.text} tone="success" onDone={() => setToast(null)} />
      )}
    </div>
  )
}

interface DiscoverPageProps {
  t: Translate
  catalog: CatalogResponse
  connectors: ConnectorView[]
  resolveText: (text: LocalizedText) => string
  onAdd: (connector: CatalogConnector) => void
}

function DiscoverPage({ t, catalog, connectors, resolveText, onAdd }: DiscoverPageProps): ReactNode {
  const added = new Set(connectors.map(item => item.id))
  return (
    <div style={styles.grid}>
      {catalog.catalog.connectors.map(connector => {
        const isAdded = added.has(connector.id)
        return (
          <article key={connector.id} style={styles.card} data-testid={`connector-card-${connector.id}`}>
            <div style={styles.cardHead}>
              <ConnectorIcon connector={connector} resolveText={resolveText} size={44} />
              <div style={styles.grow}>
                <strong>{resolveText(connector.name)}</strong>
                <div style={styles.muted}>{connector.publisher}</div>
              </div>
              <Button
                size="sm"
                variant={isAdded ? 'outline' : 'primary'}
                disabled={isAdded || connector.auth.type === 'none'}
                onClick={() => onAdd(connector)}
              >
                {isAdded ? t('added') : t('add')}
              </Button>
            </div>
            <p style={styles.description}>{resolveText(connector.description)}</p>
            <div style={styles.tags}>
              <Tag tone="neutral">{authLabel(connector.auth.type, t)}</Tag>
              {connector.official && <Tag tone="info">{t('official')}</Tag>}
            </div>
          </article>
        )
      })}
    </div>
  )
}

interface MineRowProps {
  t: Translate
  connector: ConnectorView
  catalogItem?: CatalogConnector
  resolveText: (text: LocalizedText) => string
  open: boolean
  busy: boolean
  menuOpen: boolean
  onToggle: () => void
  onMenuChange: (open: boolean) => void
  onProbe: () => void
  onRemount: () => void
  onSetEnabled: (enabled: boolean) => void
  onApplyCatalogUpdate: () => void
  onReplaceKey: () => void
  onReauthorize: () => void
  onRemove: () => void
}

function MineRow(props: MineRowProps): ReactNode {
  const { t, connector, catalogItem, resolveText } = props
  const name = catalogItem ? resolveText(catalogItem.name) : connector.id
  const apiKey = connector.auth.type === 'api-key'
  const oauth = connector.auth.type === 'oauth'
  const hasCatalogUpdate = connector.catalogUpdate?.kind === 'changed'
  const menuItems = [
    { id: 'probe', label: t('probe'), disabled: props.busy || !connector.enabled },
    { id: 'remount', label: t('remount'), disabled: props.busy || !connector.enabled },
    ...(hasCatalogUpdate ? [{ id: 'apply-catalog-update', label: t('applyCatalogUpdate'), disabled: props.busy }] : []),
    ...(apiKey ? [{ id: 'replace-key', label: t('replaceKey'), disabled: props.busy }] : []),
    ...(oauth ? [{ id: 'reauthorize', label: t('reauthorize'), disabled: props.busy }] : []),
    { id: 'remove', label: t('remove'), danger: true, disabled: props.busy },
  ]

  return (
    <article style={styles.row} data-testid={`mine-row-${connector.id}`}>
      <DisclosureRow
        icon={catalogItem
          ? <ConnectorIcon connector={catalogItem} resolveText={resolveText} size={30} />
          : <span style={styles.fallbackIcon} aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>}
        title={name}
        open={props.open}
        expandable
        expandOnRowClick
        onToggle={props.onToggle}
        collapsedContent={(
          <span style={styles.rowSummary}>
            <Status status={connector.status} t={t} />
            {connector.catalogUpdate?.kind === 'changed' && <Tag tone="warning">{t('catalogUpdateAvailable')}</Tag>}
            {connector.catalogUpdate?.kind === 'removed' && <Tag tone="neutral">{t('catalogRemoved')}</Tag>}
            {connector.account && <span style={styles.muted}>{connector.account}</span>}
            {connector.status === 'failed' && connector.enabled && (
              <Button size="sm" variant="outline" disabled={props.busy} onClick={event => {
                event.stopPropagation()
                props.onRemount()
              }}>{t('remount')}</Button>
            )}
          </span>
        )}
        headerAccessory={(
          <span style={styles.rowActions}>
            <Switch
              checked={connector.enabled}
              disabled={props.busy}
              label={name}
              onChange={props.onSetEnabled}
            />
            <Menu
              open={props.menuOpen}
              onClose={() => props.onMenuChange(false)}
              onSelect={id => {
                props.onMenuChange(false)
                if (id === 'probe') props.onProbe()
                if (id === 'remount') props.onRemount()
                if (id === 'apply-catalog-update') props.onApplyCatalogUpdate()
                if (id === 'replace-key') props.onReplaceKey()
                if (id === 'reauthorize') props.onReauthorize()
                if (id === 'remove') props.onRemove()
              }}
              items={menuItems}
              align="end"
              portal
              anchor={(
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`${t('actions')}: ${name}`}
                  disabled={props.busy}
                  onClick={() => props.onMenuChange(!props.menuOpen)}
                >…</Button>
              )}
            />
          </span>
        )}
      >
        <dl style={styles.details}>
          <dt>{t('tools')}</dt>
          <dd>{connector.tools.length > 0 ? connector.tools.map(tool => <code key={tool} style={styles.tool}>{tool}</code>) : t('noTools')}</dd>
          {connector.account && (
            <>
              <dt>{t('account')}</dt>
              <dd>{connector.account}</dd>
            </>
          )}
          <dt>{t('serviceAddress')}</dt>
          <dd><code>{connector.remote.url}</code></dd>
          <dt>{t('lastProbe')}</dt>
          <dd>{connector.lastProbe ? formatTime(connector.lastProbe.checkedAt) : t('neverProbed')}</dd>
          {connector.error !== null && (
            <>
              <dt>{t('lastError')}</dt>
              <dd style={styles.error}>{connector.error}</dd>
            </>
          )}
        </dl>
      </DisclosureRow>
      {connector.errorCode === 'server-name-conflict' && (
        <div role="alert" style={styles.error}>{t('serverNameConflict').replace('{id}', connector.id)}</div>
      )}
    </article>
  )
}

interface CatalogUpdateModalProps {
  t: Translate
  target: CatalogUpdateTarget
  resolveText: (text: LocalizedText) => string
  api: ConnectorHubApi
  onClose: () => void
  onApplyOAuth: () => void
  onApplied: () => Promise<void>
}

function CatalogUpdateModal({
  t, target, resolveText, api, onClose, onApplyOAuth, onApplied,
}: CatalogUpdateModalProps): ReactNode {
  const [key, setKey] = useState('')
  const { connector, catalogItem } = target
  const [keyRequired, setKeyRequired] = useState(catalogItem.auth.type === 'api-key' && connector.auth.type !== 'api-key')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fields = connector.catalogUpdate?.fields ?? []
  const apiKeyAuth = catalogItem.auth.type === 'api-key' ? catalogItem.auth : null

  async function apply(): Promise<void> {
    if (catalogItem.auth.type === 'oauth') {
      onApplyOAuth()
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api.connectApiKey(connector.id, keyRequired ? key : undefined, { applyCatalogUpdate: true })
      await onApplied()
    } catch (cause) {
      setKeyRequired(true)
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={() => { if (!busy) onClose() }}
      title={t('applyCatalogUpdateTitle')}
      description={resolveText(catalogItem.name)}
      closeLabel={t('close')}
      footer={(
        <div style={styles.modalFooter}>
          <Button variant="ghost" disabled={busy} onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" disabled={busy || apiKeyAuth !== null && keyRequired && key.length === 0} onClick={() => { void apply() }}>
            {busy ? t('applyingCatalogUpdate') : t('applyCatalogUpdate')}
          </Button>
        </div>
      )}
    >
      <div style={styles.form}>
        <dl style={styles.details}>
          {fields.map(field => (
            <div key={field} style={styles.updateField}>
              <dt>{catalogFieldLabel(field, t)}</dt>
              <dd>
                {formatCatalogValue(catalogFieldValue(connector, field))}
                {' → '}
                {formatCatalogValue(catalogFieldValue(catalogItem, field))}
              </dd>
            </div>
          ))}
        </dl>
        {keyRequired && apiKeyAuth && (
          <>
            <label htmlFor="connector-hub-update-api-key" style={styles.label}>{resolveText(apiKeyAuth.label)}</label>
            <Input
              id="connector-hub-update-api-key"
              data-modal-autofocus
              type="password"
              value={key}
              disabled={busy}
              autoComplete="off"
              spellCheck={false}
              placeholder={t('keyPlaceholder')}
              onChange={event => setKey(event.target.value)}
            />
            <a href={apiKeyAuth.helpUrl} target="_blank" rel="noreferrer">{t('howToGet')}</a>
          </>
        )}
        {error !== null && <div role="alert" style={styles.error}>{error}</div>}
      </div>
    </Modal>
  )
}

function catalogFieldValue(source: ConnectorView | CatalogConnector, field: string): unknown {
  return field.split('.').reduce<unknown>((value, key) => (
    value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined
  ), source)
}

function formatCatalogValue(value: unknown): string {
  if (value === undefined) return '—'
  if (typeof value === 'string') return value
  return JSON.stringify(value) ?? String(value)
}

function catalogFieldLabel(field: string, t: Translate): string {
  const labels: Record<string, LocaleKey> = {
    'remote.type': 'remoteType',
    'remote.url': 'serviceAddress',
    'auth.type': 'authType',
    'auth.in': 'authLocation',
    'auth.name': 'authParameterName',
    'auth.helpUrl': 'howToGet',
    'auth.scope': 'oauthScope',
    'auth.clientId': 'oauthClientIdentity',
    'auth.clientMetadataUrl': 'oauthClientIdentity',
    'auth.callbackPath': 'oauthCallbackPath',
    'auth.portPolicy': 'oauthPortPolicy',
    'auth.fixedPort': 'oauthFixedPort',
    'auth.authorizationParams': 'oauthAuthorizationParams',
  }
  const key = labels[field]
  return key ? t(key) : field
}

type OAuthPhase = 'idle' | 'starting' | 'waiting' | 'cancelling' | 'failed' | 'success'

interface OAuthModalProps {
  t: Translate
  connector: CatalogConnector
  mode: KeyMode
  resolveText: (text: LocalizedText) => string
  api: ConnectorHubApi
  pollMs: number
  openWindow?: (url: string, target?: string, features?: string) => Window | null
  copyText?: (text: string) => Promise<void>
  applyCatalogUpdate?: boolean
  onClose: () => void
  onAuthorized: () => Promise<string | null>
}

function OAuthModal({
  t, connector, mode, resolveText, api, pollMs, openWindow, copyText, applyCatalogUpdate, onClose, onAuthorized,
}: OAuthModalProps): ReactNode {
  const [phase, setPhase] = useState<OAuthPhase>('idle')
  const [attemptId, setAttemptId] = useState<string | null>(null)
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [account, setAccount] = useState<string | null>(null)
  const popup = useRef<Window | null>(null)
  const authorized = useRef(onAuthorized)
  authorized.current = onAuthorized

  useEffect(() => {
    if (phase !== 'waiting' || attemptId === null) return
    let active = true
    let checking = false
    const check = async () => {
      if (checking) return
      checking = true
      try {
        const result = await api.oauthStatus(attemptId)
        if (!active) return
        if (result.status === 'failed') {
          setError(result.error ?? t('oauthIntro'))
          setPhase('failed')
        } else if (result.status === 'success') {
          const name = await authorized.current()
          if (!active) return
          setAccount(name)
          setError(null)
          setPhase('success')
        } else {
          setError(null)
        }
      } catch (cause) {
        if (active) setError(errorMessage(cause))
      } finally {
        checking = false
      }
    }
    void check()
    const timer = setInterval(() => { void check() }, pollMs)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [api, attemptId, phase, pollMs, t])

  useEffect(() => {
    if (phase !== 'success') return
    const timer = setTimeout(() => {
      popup.current?.close()
      onClose()
    }, OAUTH_SUCCESS_CLOSE_MS)
    return () => clearTimeout(timer)
  }, [onClose, phase])

  async function start(): Promise<void> {
    setError(null)
    setCopied(false)
    setAccount(null)
    setAttemptId(null)
    setAuthorizationUrl(null)
    setPhase('starting')
    try {
      popup.current = openWindow
        ? openWindow('about:blank', '_blank')
        : window.open('about:blank', '_blank')
    } catch {
      popup.current = null
    }
    try {
      const started = applyCatalogUpdate
        ? await api.startOAuth(connector.id, { applyCatalogUpdate: true })
        : await api.startOAuth(connector.id)
      setAttemptId(started.attemptId)
      setAuthorizationUrl(started.authorizationUrl)
      if (popup.current && !popup.current.closed) {
        try { popup.current.location.href = started.authorizationUrl } catch { /* Manual link remains available. */ }
      }
      setPhase('waiting')
    } catch (cause) {
      popup.current?.close()
      popup.current = null
      setError(errorMessage(cause))
      setPhase('failed')
    }
  }

  async function copyLink(): Promise<void> {
    if (!authorizationUrl) return
    try {
      if (copyText) await copyText(authorizationUrl)
      else await navigator.clipboard.writeText(authorizationUrl)
      setCopied(true)
      setError(null)
    } catch (cause) {
      setCopied(false)
      setError(`${t('authorizationCopyFailed')} ${errorMessage(cause)}`)
    }
  }

  async function cancel(): Promise<void> {
    if (attemptId === null) {
      onClose()
      return
    }
    setPhase('cancelling')
    try {
      await api.cancelOAuth(attemptId)
      popup.current?.close()
      onClose()
    } catch (cause) {
      setError(errorMessage(cause))
      setPhase('waiting')
    }
  }

  function close(): void {
    if (phase === 'waiting') void cancel()
    else if (phase !== 'starting' && phase !== 'cancelling') {
      popup.current?.close()
      onClose()
    }
  }

  return (
    <Modal
      open
      onClose={close}
      title={t(mode === 'add' ? 'addOauthTitle' : 'reauthorizeOauthTitle')}
      description={resolveText(connector.name)}
      closeLabel={t('close')}
      footer={(
        <div style={styles.modalFooter}>
          {phase !== 'success' && (
            <Button variant="ghost" disabled={phase === 'starting' || phase === 'cancelling'} onClick={close}>
              {t('cancel')}
            </Button>
          )}
          {(phase === 'idle' || phase === 'failed') && (
            <Button variant="primary" onClick={() => { void start() }}>
              {phase === 'failed' ? t('retry') : t('goAuthorize')}
            </Button>
          )}
          {phase === 'waiting' && (
            <Button variant="primary" onClick={() => { void copyLink() }}>{t('copyAuthorizationLink')}</Button>
          )}
          {phase === 'success' && <Button variant="primary" onClick={close}>{t('close')}</Button>}
        </div>
      )}
    >
      <div style={styles.form}>
        {phase === 'idle' && <p style={styles.muted}>{t('oauthIntro')}</p>}
        {phase === 'starting' && <p style={styles.muted}>{t('startingOauth')}</p>}
        {phase === 'cancelling' && <p style={styles.muted}>{t('cancellingOauth')}</p>}
        {phase === 'waiting' && (
          <>
            <p style={styles.muted}>{t('waitingOauth')}</p>
            {popup.current === null && <p style={styles.hint}>{t('popupBlocked')}</p>}
            {copied && <p role="status" style={styles.muted}>{t('authorizationLinkCopied')}</p>}
            {authorizationUrl && <a href={authorizationUrl} target="_blank" rel="noreferrer">{t('openAuthorizationPage')}</a>}
          </>
        )}
        {phase === 'success' && (
          <div role="status">
            <strong>{t('oauthSucceeded')}</strong>
            {account && <div style={styles.muted}>{t('account')}: {account}</div>}
          </div>
        )}
        {error !== null && <div role="alert" style={styles.error}>{error}</div>}
      </div>
    </Modal>
  )
}

interface ApiKeyModalProps {
  t: Translate
  connector: CatalogConnector
  mode: KeyMode
  resolveText: (text: LocalizedText) => string
  onClose: () => void
  onSave: (key: string) => Promise<void>
}

function ApiKeyModal({ t, connector, mode, resolveText, onClose, onSave }: ApiKeyModalProps): ReactNode {
  const [key, setKey] = useState('')
  const [visible, setVisible] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const auth = connector.auth as ApiKeyAuth

  async function save(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await onSave(key)
      onClose()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={() => { if (!busy) onClose() }}
      title={t(mode === 'add' ? 'addKeyTitle' : 'replaceKeyTitle')}
      description={resolveText(connector.name)}
      closeLabel={t('close')}
      footer={(
        <div style={styles.modalFooter}>
          <Button variant="ghost" disabled={busy} onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" disabled={busy || key.length === 0} onClick={() => { void save() }}>
            {busy ? t('saving') : t('saveConnect')}
          </Button>
        </div>
      )}
    >
      <form onSubmit={event => { event.preventDefault(); if (key && !busy) void save() }} style={styles.form}>
        <label htmlFor="connector-hub-api-key" style={styles.label}>{resolveText(auth.label)}</label>
        <div style={styles.keyInput}>
          <Input
            id="connector-hub-api-key"
            data-modal-autofocus
            type={visible ? 'text' : 'password'}
            value={key}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            placeholder={t('keyPlaceholder')}
            onChange={event => setKey(event.target.value)}
          />
          <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setVisible(value => !value)}>
            {visible ? t('hideKey') : t('showKey')}
          </Button>
        </div>
        <a href={auth.helpUrl} target="_blank" rel="noreferrer">{t('howToGet')}</a>
        {error !== null && <div role="alert" style={styles.error}>{error}</div>}
      </form>
    </Modal>
  )
}

interface RemoveModalProps {
  t: Translate
  connector: CatalogConnector
  resolveText: (text: LocalizedText) => string
  api: ConnectorHubApi
  onClose: () => void
  onRemoved: () => Promise<void>
}

function RemoveModal({ t, connector, resolveText, api, onClose, onRemoved }: RemoveModalProps): ReactNode {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function remove(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await api.remove(connector.id)
      await onRemoved()
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onClose={() => { if (!busy) onClose() }}
      title={`${t('removeTitle')} · ${resolveText(connector.name)}`}
      description={t('removeDescription')}
      closeLabel={t('close')}
      footer={(
        <div style={styles.modalFooter}>
          <Button variant="ghost" disabled={busy} onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" disabled={busy} onClick={() => { void remove() }}>{t('confirmRemove')}</Button>
        </div>
      )}
    >
      {error !== null && <div role="alert" style={styles.error}>{error}</div>}
    </Modal>
  )
}

function ConnectorIcon({ connector, resolveText, size }: {
  connector: CatalogConnector
  resolveText: (text: LocalizedText) => string
  size: number
}): ReactNode {
  return <img src={connector.icon} alt={resolveText(connector.name)} width={size} height={size} style={styles.icon} />
}

function Status({ status, t }: { status: ConnectorStatus, t: Translate }): ReactNode {
  const states: Record<ConnectorStatus, StateDotState> = {
    connected: 'done', connecting: 'ongoing', failed: 'error', 'reauth-required': 'warning', disabled: 'idle',
  }
  const tones: Record<ConnectorStatus, TagTone> = {
    connected: 'success', connecting: 'warning', failed: 'danger', 'reauth-required': 'warning', disabled: 'neutral',
  }
  const keys: Record<ConnectorStatus, LocaleKey> = {
    connected: 'connected', connecting: 'connecting', failed: 'failed', 'reauth-required': 'reauthRequired', disabled: 'disabled',
  }
  return <Tag tone={tones[status]}><StateDot state={states[status]} /> {t(keys[status])}</Tag>
}

function authLabel(type: CatalogConnector['auth']['type'], t: Translate): string {
  return t(type === 'api-key' ? 'apiKey' : type === 'oauth' ? 'oauth' : 'none')
}

function catalogItemFromView(view: ConnectorView): CatalogConnector {
  return {
    id: view.id,
    name: { zh: view.id, en: view.id },
    description: { zh: '', en: '' },
    icon: '',
    homepage: '',
    publisher: '',
    official: false,
    remote: view.remote,
    auth: view.auth,
  }
}

function defaultResolveText(text: LocalizedText): string {
  return typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('zh') ? text.zh : text.en
}

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const styles = {
  page: { padding: 20, display: 'flex', flexDirection: 'column', gap: 16, color: 'var(--dsw-alias-label-primary)' },
  banner: { border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 10, padding: '10px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, color: 'var(--dsw-alias-label-secondary)' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 260px), 1fr))', gap: 16 },
  card: { border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 12, padding: 16, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 },
  cardHead: { display: 'flex', alignItems: 'center', gap: 10 },
  grow: { flex: 1, minWidth: 0 },
  icon: { borderRadius: 10, objectFit: 'cover', flexShrink: 0 },
  description: { margin: 0, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6, minHeight: 44 },
  tags: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  hint: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 },
  list: { display: 'flex', flexDirection: 'column', gap: 10 },
  row: { border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 10, padding: '4px 10px' },
  rowSummary: { display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  rowActions: { display: 'inline-flex', alignItems: 'center', gap: 6 },
  details: { margin: '8px 0 12px', display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', gap: '8px 16px', color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere' },
  updateField: { display: 'contents' },
  tool: { display: 'inline-block', margin: '0 6px 4px 0' },
  empty: { minHeight: 220, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, color: 'var(--dsw-alias-label-secondary)' },
  muted: { color: 'var(--dsw-alias-label-secondary)', margin: 0 },
  error: { color: 'var(--dsw-alias-state-error-primary)', whiteSpace: 'pre-wrap' },
  fallbackIcon: { width: 30, height: 30, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: '1px solid var(--dsw-alias-border-l4)', borderRadius: 8 },
  form: { display: 'flex', flexDirection: 'column', gap: 10 },
  label: { color: 'var(--dsw-alias-label-secondary)', fontSize: 13 },
  keyInput: { display: 'flex', alignItems: 'center', gap: 6 },
  modalFooter: { display: 'flex', justifyContent: 'flex-end', gap: 8 },
} satisfies Record<string, CSSProperties>
