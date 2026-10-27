/**
 * Connector hub PoC, browser half: a "Connectors" tab on the Plugins page that
 * calls the Host half's two routes and prints their JSON answers.
 */
import { useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

const NS = 'connectorHubPoc'

const zh = {
  title: '连接器',
  intro: '连接器市场最小验证：调用插件的 Host 接口，并在系统钥匙串中写入、读取、删除一条测试记录。',
  status: '读取 Host 状态',
  keychain: '测试钥匙串读写',
}

const en: typeof zh = {
  title: 'Connectors',
  intro: 'Connector hub PoC: call the plugin Host routes, then write, read, and delete one test entry in the OS keychain.',
  status: 'Read Host status',
  keychain: 'Test keychain round trip',
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
  const [result, setResult] = useState('')
  const [busy, setBusy] = useState(false)
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
    }
  }
  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p>{t('intro')}</p>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button variant="outline" disabled={busy} onClick={() => { void call('api/connector-hub/status', 'GET') }}>{t('status')}</Button>
        <Button variant="primary" disabled={busy} onClick={() => { void call('api/connector-hub/keychain-test', 'POST') }}>{t('keychain')}</Button>
      </div>
      <pre data-testid="connector-hub-poc-result" style={{ whiteSpace: 'pre-wrap', fontSize: 12, margin: 0 }}>{result}</pre>
    </div>
  )
}

function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    // Not JSON (for example an HTML error page); show it as received.
    return text
  }
}
