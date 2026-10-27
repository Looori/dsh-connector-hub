/**
 * Connector hub PoC, browser half: a "Connectors" tab on the Plugins page.
 * It shows the test connector's status (polled every 3 s while the tab is
 * open), probes or remounts it, and keeps the earlier runtime and keychain
 * diagnostics.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

const NS = 'connectorHubPoc'
const POLL_MS = 3000

const zh = {
  title: '连接器',
  intro: '连接器市场最小验证：插件在运行时挂载 dsh-mcp-client，连接本地测试 MCP 服务 pocdemo。',
  connector: '测试连接器',
  status: '状态',
  fiber: '插件状态',
  mount: '挂载代次',
  error: '错误',
  globalTools: '全局注册的工具',
  sessionTools: '各会话可见的工具',
  noSessions: '当前没有运行中的会话',
  refresh: '刷新状态',
  probe: '试连',
  remount: '重新挂载',
  diagnostics: '诊断',
  runtime: '读取 Host 状态',
  keychain: '测试钥匙串读写',
  connected: '已连接',
  connecting: '连接中',
  failed: '失败',
  noTools: '已挂载，但没有工具',
}

const en: typeof zh = {
  title: 'Connectors',
  intro: 'Connector hub PoC: the plugin mounts dsh-mcp-client at runtime and connects to the local test MCP server pocdemo.',
  connector: 'Test connector',
  status: 'Status',
  fiber: 'Plugin state',
  mount: 'Mount generation',
  error: 'Error',
  globalTools: 'Globally registered tools',
  sessionTools: 'Tools visible to each session',
  noSessions: 'No live sessions',
  refresh: 'Refresh status',
  probe: 'Probe',
  remount: 'Remount',
  diagnostics: 'Diagnostics',
  runtime: 'Read Host status',
  keychain: 'Test keychain round trip',
  connected: 'Connected',
  connecting: 'Connecting',
  failed: 'Failed',
  noTools: 'Mounted, no tools',
}

type Key = keyof typeof zh

/** The browser context members this PoC touches. */
interface ClientContext {
  effect(execute: () => unknown, label?: string): unknown
  locale: {
    register(ns: string, dicts: Record<string, Record<string, string>>): () => void
    bind(ns: string): (key: Key) => string
  }
  slots: {
    inject(name: string, register: () => unknown): void
    register(spec: Record<string, unknown>, component: (props: TabProps) => ReactNode): () => void
  }
}

interface TabProps {
  t: (key: Key) => string
}

/** `GET api/connector-hub/mcp-status`. */
interface McpStatus {
  connector: { serverName: string, url: string }
  status: string
  fiberState: string
  generation: number
  token: string
  mountedAt: string
  error: string | null
  tools: {
    global: string[] | null
    agents: Array<{ id: string, connectorTools: string[], totalVisible: number }> | null
  }
}

const STATUS_COLORS: Record<string, string> = {
  connected: '#1a7f37',
  connecting: '#9a6700',
  failed: '#cf222e',
  'no-tools': '#9a6700',
}

export const inject = ['slots', 'locale']

/**
 * Add the Connectors tab to the Plugins page.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'connector-hub-poc: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('plugins.tab', () => ctx.slots.register({
    name: 'plugins.tab', id: 'connector-hub-poc', label: () => t('title'), locale: NS,
  }, ConnectorsTab))
}

function ConnectorsTab({ t }: TabProps): ReactNode {
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [result, setResult] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('api/connector-hub/mcp-status')
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      setStatus(await response.json() as McpStatus)
      setStatusError(null)
    } catch (error) {
      setStatusError(String(error))
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => { void refresh() }, POLL_MS)
    return () => { clearInterval(timer) }
  }, [refresh])

  async function call(route: string, method: 'GET' | 'POST'): Promise<void> {
    setBusy(true)
    try {
      const response = await fetch(route, { method })
      const text = await response.text()
      setResult(`${method} ${route} → HTTP ${response.status}\n${pretty(text)}`)
    } catch (error) {
      setResult(`${method} ${route} → ${String(error)}`)
    } finally {
      setBusy(false)
      void refresh()
    }
  }

  const statusLabel = status === null ? '…' : statusText(status.status, t)
  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <p style={{ margin: 0 }}>{t('intro')}</p>

      <section data-testid="connector-hub-poc-card" style={{ border: '1px solid var(--border, rgba(127,127,127,.3))', borderRadius: 8, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <strong>{t('connector')} · {status?.connector.serverName ?? 'pocdemo'}</strong>
          <span data-testid="connector-hub-poc-status" style={{ color: '#fff', background: STATUS_COLORS[status?.status ?? ''] ?? '#6e7781', borderRadius: 10, padding: '1px 8px', fontSize: 12 }}>{statusLabel}</span>
        </div>
        <div style={{ fontSize: 12, opacity: 0.8 }}>{status?.connector.url}</div>
        {status !== null && (
          <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 12px', margin: 0, fontSize: 13 }}>
            <dt>{t('fiber')}</dt><dd style={{ margin: 0 }}>{status.fiberState}</dd>
            <dt>{t('mount')}</dt><dd style={{ margin: 0 }}>{status.generation}（{status.token}）</dd>
            {status.error !== null && (<><dt>{t('error')}</dt><dd style={{ margin: 0, color: '#cf222e' }}>{status.error}</dd></>)}
            <dt>{t('globalTools')}</dt><dd style={{ margin: 0 }}><code>{(status.tools.global ?? []).join(', ') || '—'}</code></dd>
            <dt>{t('sessionTools')}</dt>
            <dd style={{ margin: 0 }}>
              {(status.tools.agents ?? []).length === 0
                ? t('noSessions')
                : (status.tools.agents ?? []).map(agent => (
                    <div key={agent.id}><code>{agent.id.replace(/^session-/, '').slice(0, 8)}</code>：<code>{agent.connectorTools.join(', ') || '—'}</code>（{agent.totalVisible}）</div>
                  ))}
            </dd>
          </dl>
        )}
        {statusError !== null && <div style={{ color: '#cf222e', fontSize: 12 }}>{statusError}</div>}
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="outline" disabled={busy} onClick={() => { void refresh() }}>{t('refresh')}</Button>
          <Button variant="outline" disabled={busy} onClick={() => { void call('api/connector-hub/mcp-probe', 'POST') }}>{t('probe')}</Button>
          <Button variant="primary" disabled={busy} onClick={() => { void call('api/connector-hub/mcp-remount', 'POST') }}>{t('remount')}</Button>
        </div>
      </section>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <strong>{t('diagnostics')}</strong>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button variant="ghost" disabled={busy} onClick={() => { void call('api/connector-hub/status', 'GET') }}>{t('runtime')}</Button>
          <Button variant="ghost" disabled={busy} onClick={() => { void call('api/connector-hub/keychain-test', 'POST') }}>{t('keychain')}</Button>
        </div>
      </section>

      <pre data-testid="connector-hub-poc-result" style={{ whiteSpace: 'pre-wrap', fontSize: 12, margin: 0 }}>{result}</pre>
    </div>
  )
}

function statusText(status: string, t: (key: Key) => string): string {
  switch (status) {
    case 'connected': return t('connected')
    case 'connecting': return t('connecting')
    case 'failed': return t('failed')
    case 'no-tools': return t('noTools')
    default: return status
  }
}

function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    // Not JSON (for example an HTML error page); show it as received.
    return text
  }
}
