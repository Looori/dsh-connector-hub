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

type Page = 'mine' | 'discover'
type KeyMode = 'add' | 'replace'

interface KeyTarget {
  connector: CatalogConnector
  mode: KeyMode
}

export interface ConnectorHubProps {
  t: Translate
  api?: ConnectorHubApi
  resolveText?: (text: LocalizedText) => string
  pollMs?: number
}

/** The two-page connector UI. Credentials are passed to Host and never retained by this component. */
export function ConnectorHub({
  t,
  api: providedApi,
  resolveText = defaultResolveText,
  pollMs = DEFAULT_POLL_MS,
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
  const [keyTarget, setKeyTarget] = useState<KeyTarget | null>(null)
  const [removeTarget, setRemoveTarget] = useState<CatalogConnector | null>(null)
  const [toast, setToast] = useState<{ id: number, text: string } | null>(null)
  const toastSequence = useRef(0)

  const showToast = useCallback((text: string) => {
    setToast({ id: ++toastSequence.current, text })
  }, [])

  const refresh = useCallback(async (probeOnOpen = false) => {
    try {
      const [nextCatalog, nextConnectors] = await Promise.all([api.getCatalog(), api.listConnectors()])
      setCatalog(nextCatalog)
      setConnectors(nextConnectors)
      setPage(current => current ?? (nextConnectors.length > 0 ? 'mine' : 'discover'))
      setLoadError(null)
      setLoading(false)

      if (probeOnOpen) {
        const probes = await Promise.all(nextConnectors.filter(item => item.enabled).map(async item => {
          try { return await api.probe(item.id) } catch { return null }
        }))
        const byId = new Map(probes.filter(item => item !== null).map(item => [item.id, item]))
        setConnectors(current => current?.map(item => byId.get(item.id) ?? item) ?? current)
      }
    } catch (error) {
      setLoadError(errorMessage(error))
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    void refresh(true)
    const timer = setInterval(() => { void refresh() }, pollMs)
    return () => clearInterval(timer)
  }, [pollMs, refresh])

  async function runAction(id: string, action: () => Promise<unknown>, success?: LocaleKey): Promise<void> {
    setBusyId(id)
    setActionError(null)
    try {
      await action()
      if (success) showToast(t(success))
      await refresh()
    } catch (error) {
      setActionError(errorMessage(error))
    } finally {
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

  function toggleExpanded(id: string): void {
    setExpanded(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const currentPage = page ?? 'discover'
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
      {catalog !== null && catalog.updates.length > 0 && <div style={styles.banner}>{t('catalogUpdates')}</div>}
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
            onAdd={connector => setKeyTarget({ connector, mode: 'add' })}
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
                    onProbe={() => { void runAction(connector.id, () => api.probe(connector.id)) }}
                    onRemount={() => { void runAction(connector.id, () => api.remount(connector.id)) }}
                    onSetEnabled={enabled => { void runAction(
                      connector.id,
                      () => api.setEnabled(connector.id, enabled),
                      enabled ? 'enabledToast' : 'disabledToast',
                    ) }}
                    onReplaceKey={() => setKeyTarget({ connector: catalogItem ?? catalogItemFromView(connector), mode: 'replace' })}
                    onRemove={() => setRemoveTarget(catalogItem ?? catalogItemFromView(connector))}
                  />
                )
              })}
            </div>
          )}
        </section>
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
        const oauth = connector.auth.type === 'oauth'
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
                disabled={isAdded || connector.auth.type !== 'api-key'}
                title={oauth ? t('oauthM3') : undefined}
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
            {oauth && !isAdded && <div style={styles.hint}>{t('oauthM3')}</div>}
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
  onReplaceKey: () => void
  onRemove: () => void
}

function MineRow(props: MineRowProps): ReactNode {
  const { t, connector, catalogItem, resolveText } = props
  const name = catalogItem ? resolveText(catalogItem.name) : connector.id
  const apiKey = connector.auth.type === 'api-key'
  const oauth = connector.auth.type === 'oauth'
  const menuItems = [
    { id: 'probe', label: t('probe'), disabled: props.busy || !connector.enabled },
    { id: 'remount', label: t('remount'), disabled: props.busy || !connector.enabled },
    ...(apiKey ? [{ id: 'replace-key', label: t('replaceKey'), disabled: props.busy }] : []),
    ...(oauth ? [{ id: 'reauthorize', label: t('reauthorize'), disabled: true }] : []),
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
                if (id === 'replace-key') props.onReplaceKey()
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
    </article>
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
