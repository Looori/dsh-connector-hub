// @vitest-environment jsdom

import { createElement } from 'react'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConnectorHub } from './ConnectorHub'
import { zh, type LocaleKey } from './locales'
import type { ConnectorHubApi } from './api'
import type { CatalogConnector, LocalizedText } from '../shared/catalog'
import type { ConnectorView } from '../host/service'

// DSH supplies the real primitives in the browser. Lightweight equivalents keep
// these tests focused on connector state and interaction rather than platform CSS.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ children, icon, variant, size, ...props }: any) => createElement('button', props, children),
  Input: ({ icon, ...props }: any) => createElement('input', props),
  SegmentedTabs: ({ items, value, onChange, label }: any) => createElement('div', { role: 'tablist', 'aria-label': label },
    items.map((item: any) => createElement('button', {
      key: item.value, id: item.id, role: 'tab', 'aria-selected': value === item.value,
      onClick: () => onChange(item.value),
    }, item.label))),
  Modal: ({ open, title, description, children, footer, closeLabel, onClose }: any) => open
    ? createElement('div', { role: 'dialog', 'aria-label': title },
      createElement('button', { onClick: onClose }, closeLabel), description, children, footer)
    : null,
  DisclosureRow: ({ icon, title, open, onToggle, collapsedContent, headerAccessory, children }: any) =>
    createElement('div', null,
      createElement('div', { role: 'button', tabIndex: 0, onClick: onToggle }, icon, title, collapsedContent),
      headerAccessory,
      open ? children : null),
  StateDot: () => createElement('span'),
  Switch: ({ checked, onChange, label, disabled }: any) => createElement('button', {
    role: 'switch', 'aria-label': label, 'aria-checked': checked, disabled,
    onClick: () => onChange(!checked),
  }),
  Tag: ({ children }: any) => createElement('span', null, children),
  Toast: ({ text }: any) => createElement('div', { role: 'status' }, text),
  Menu: ({ open, anchor, items, onSelect }: any) => createElement('div', null, anchor,
    open ? items.map((item: any) => createElement('button', {
      key: item.id, role: 'menuitem', disabled: item.disabled, onClick: () => onSelect(item.id),
    }, item.label)) : null),
}))

afterEach(cleanup)

const amap: CatalogConnector = {
  id: 'amap',
  name: { zh: '高德地图', en: 'Amap' },
  description: { zh: '查询地点、路线和天气。', en: 'Query places, routes, and weather.' },
  icon: 'data:image/svg+xml;base64,AA==',
  homepage: 'https://lbs.amap.com',
  publisher: '高德地图',
  official: true,
  remote: { type: 'streamable-http', url: 'https://mcp.amap.com/mcp' },
  auth: {
    type: 'api-key', in: 'query', name: 'key',
    label: { zh: 'Web 服务 Key', en: 'Web service key' },
    helpUrl: 'https://console.amap.com/dev/key/app',
  },
}

const notion: CatalogConnector = {
  ...amap,
  id: 'notion',
  name: { zh: 'Notion', en: 'Notion' },
  description: { zh: '读取工作区。', en: 'Read a workspace.' },
  publisher: 'Notion',
  auth: {
    type: 'oauth', callbackPath: '/oauth/callback/notion', portPolicy: 'random',
    clientMetadataUrl: 'https://looori.github.io/dsh-connector-hub/oauth/notion/client.json',
  },
}

function view(overrides: Partial<ConnectorView> = {}): ConnectorView {
  return {
    id: 'amap', enabled: true, status: 'connected', phase: 'active', generation: 1,
    mountedAt: '2026-11-03T08:00:00.000Z', tools: ['mcp__amap__maps_geo'], error: null, errorCode: null,
    catalogRevision: 'test.1', addedAt: '2026-11-03T08:00:00.000Z',
    remote: amap.remote, auth: amap.auth, lastProbe: null,
    ...overrides,
  }
}

function oauthView(overrides: Partial<ConnectorView> = {}): ConnectorView {
  return view({
    id: 'notion', remote: notion.remote, auth: notion.auth,
    tools: ['mcp__notion__search'], account: 'Engineering', ...overrides,
  })
}

function apiFixture(connectors: ConnectorView[] = [], items: CatalogConnector[] = [amap, notion]) {
  const catalog = {
    catalog: { schemaVersion: 1 as const, revision: 'test.1', connectors: items },
    source: 'network' as const,
    fetchedAt: '2026-11-03T08:00:00.000Z', stale: false, error: null, updates: [],
  }
  const api: ConnectorHubApi = {
    getCatalog: vi.fn().mockResolvedValue(catalog),
    refreshCatalog: vi.fn().mockResolvedValue(catalog),
    listConnectors: vi.fn().mockResolvedValue(connectors),
    connectApiKey: vi.fn().mockImplementation(async id => view({ id })),
    startOAuth: vi.fn().mockResolvedValue({
      attemptId: '00000000-0000-4000-8000-000000000001',
      authorizationUrl: 'https://example.com/authorize?state=state-1',
    }),
    oauthStatus: vi.fn().mockResolvedValue({
      attemptId: '00000000-0000-4000-8000-000000000001', connectorId: 'notion', status: 'waiting', error: null,
    }),
    cancelOAuth: vi.fn().mockResolvedValue({ cancelled: true }),
    probe: vi.fn().mockImplementation(async id => view({ id })),
    remount: vi.fn().mockImplementation(async id => view({ id })),
    setEnabled: vi.fn().mockImplementation(async (id, enabled) => view({ id, enabled, status: enabled ? 'connected' : 'disabled' })),
    remove: vi.fn().mockResolvedValue({ removed: true }),
  }
  return api
}

function renderHub(api: ConnectorHubApi, options: {
  openWindow?: (url: string) => Window | null
  copyText?: (text: string) => Promise<void>
} = {}) {
  return render(createElement(ConnectorHub, {
    api,
    t: (key: LocaleKey) => zh[key],
    resolveText: (text: LocalizedText) => text.zh,
    pollMs: 1_000_000,
    oauthPollMs: 10,
    ...options,
  }))
}

async function openActions(name = '高德地图') {
  await userEvent.click(await screen.findByRole('button', { name: `操作: ${name}` }))
}

describe('connector hub browser UI', () => {
  it('renders the catalog, starts on Discover when empty, and enables OAuth', async () => {
    const api = apiFixture()
    renderHub(api)

    expect(await screen.findByTestId('connector-card-amap')).toBeTruthy()
    expect(screen.getByRole('tab', { selected: true })).toHaveProperty('textContent', '发现')
    expect(screen.getByText('查询地点、路线和天气。')).toBeTruthy()
    expect(screen.getAllByText('官方服务')).toHaveLength(2)

    const oauthCard = screen.getByTestId('connector-card-notion')
    expect(within(oauthCard).getByRole('button', { name: '添加' })).toHaveProperty('disabled', false)
    expect(within(oauthCard).queryByText('OAuth 授权将在 M3 提供')).toBeNull()
  })

  it('starts on Mine when connectors exist and expands operational details', async () => {
    const initial = view({ error: 'probe failed', lastProbe: {
      ok: false, checkedAt: '2026-11-03T09:00:00.000Z', durationMs: 20,
      tools: [], server: null, error: 'probe failed',
    } })
    const api = apiFixture([initial])
    vi.mocked(api.probe).mockResolvedValue(initial)
    renderHub(api)

    expect(await screen.findByTestId('mine-row-amap')).toBeTruthy()
    expect(screen.getByRole('tab', { selected: true })).toHaveProperty('textContent', '我的')
    await userEvent.click(screen.getByText('高德地图'))
    expect(await screen.findByText('mcp__amap__maps_geo')).toBeTruthy()
    expect(screen.getByText('https://mcp.amap.com/mcp')).toBeTruthy()
    expect(screen.getAllByText('probe failed').length).toBeGreaterThan(0)
    expect(api.probe).toHaveBeenCalledWith('amap')
  })

  it('shows duplicate serverName guidance and keeps the raw error in details', async () => {
    const message = 'mcp-client: serverName "amap" is already in use by another mcp-client instance — pick a unique serverName in cordis.yml'
    const initial = view({
      status: 'failed', phase: 'failed', tools: [], error: message, errorCode: 'server-name-conflict',
    })
    const api = apiFixture([initial])
    vi.mocked(api.probe).mockResolvedValue(initial)
    renderHub(api)

    await screen.findByTestId('mine-row-amap')
    expect(screen.getByRole('alert').textContent).toBe(zh.serverNameConflict.replace('{id}', 'amap'))
    expect(screen.queryByText(message)).toBeNull()
    await userEvent.click(screen.getByText('高德地图'))
    expect(await screen.findByText(message)).toBeTruthy()
  })

  it('adds an API Key connector, closes the modal, refreshes, and shows a toast', async () => {
    const api = apiFixture()
    vi.mocked(api.listConnectors).mockResolvedValueOnce([]).mockResolvedValue([view()])
    renderHub(api)

    const card = await screen.findByTestId('connector-card-amap')
    await userEvent.click(within(card).getByRole('button', { name: '添加' }))
    const input = screen.getByLabelText('Web 服务 Key')
    expect(input).toHaveProperty('type', 'password')
    await userEvent.type(input, 'new-secret')
    await userEvent.click(screen.getByRole('button', { name: '显示 Key' }))
    expect(input).toHaveProperty('type', 'text')
    await userEvent.click(screen.getByRole('button', { name: '保存并连接' }))

    await waitFor(() => expect(api.connectApiKey).toHaveBeenCalledWith('amap', 'new-secret'))
    expect(await screen.findByText('已添加连接器，所有会话现在都可以使用它的工具。')).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
    await userEvent.click(screen.getByRole('tab', { name: '我的' }))
    expect(await screen.findByTestId('mine-row-amap')).toBeTruthy()
  })

  it('keeps a failed API Key modal open and makes no changes on cancel', async () => {
    const api = apiFixture()
    vi.mocked(api.connectApiKey).mockRejectedValue(new Error('INVALID_USER_KEY'))
    renderHub(api)

    const card = await screen.findByTestId('connector-card-amap')
    await userEvent.click(within(card).getByRole('button', { name: '添加' }))
    await userEvent.type(screen.getByLabelText('Web 服务 Key'), 'bad-secret')
    await userEvent.click(screen.getByRole('button', { name: '保存并连接' }))

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'INVALID_USER_KEY')
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByLabelText('Web 服务 Key')).toHaveProperty('value', 'bad-secret')
    await userEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(api.listConnectors).toHaveBeenCalledTimes(1)
  })

  it('replaces an existing API Key from the operation menu', async () => {
    const api = apiFixture([view()])
    renderHub(api)
    await screen.findByTestId('mine-row-amap')
    await openActions()
    await userEvent.click(screen.getByRole('menuitem', { name: '更换 Key' }))
    await userEvent.type(screen.getByLabelText('Web 服务 Key'), 'replacement')
    await userEvent.click(screen.getByRole('button', { name: '保存并连接' }))

    await waitFor(() => expect(api.connectApiKey).toHaveBeenCalledWith('amap', 'replacement'))
    expect(await screen.findByText('API Key 已更换。')).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows a success toast after a successful manual probe', async () => {
    const api = apiFixture([view()])
    vi.mocked(api.probe).mockResolvedValue(view({ lastProbe: {
      ok: true, checkedAt: '2026-11-03T09:00:00.000Z', durationMs: 20,
      tools: ['mcp__amap__maps_geo'], server: null, error: null,
    } }))
    renderHub(api)
    await screen.findByTestId('mine-row-amap')

    await openActions()
    await userEvent.click(screen.getByRole('menuitem', { name: '试连' }))

    expect(await screen.findByText('试连成功。')).toBeTruthy()
    expect(api.probe).toHaveBeenCalledWith('amap')
  })

  it('shows the upstream error instead of a success toast after a failed probe', async () => {
    const api = apiFixture([view()])
    vi.mocked(api.probe).mockResolvedValue(view({ status: 'failed', error: 'Invalid API Key', lastProbe: {
      ok: false, checkedAt: '2026-11-03T09:00:00.000Z', durationMs: 20,
      tools: [], server: null, error: 'Invalid API Key',
    } }))
    renderHub(api)
    await screen.findByTestId('mine-row-amap')

    await openActions()
    await userEvent.click(screen.getByRole('menuitem', { name: '试连' }))

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Invalid API Key')
    expect(screen.queryByText('试连成功。')).toBeNull()
    expect(api.listConnectors).toHaveBeenCalledTimes(2)
  })

  it('disables and enables a connector with lifecycle toasts', async () => {
    const api = apiFixture([view()])
    vi.mocked(api.listConnectors)
      .mockResolvedValueOnce([view()])
      .mockResolvedValueOnce([view({ enabled: false, status: 'disabled' })])
      .mockResolvedValue([view()])
    renderHub(api)
    const toggle = await screen.findByRole('switch', { name: '高德地图' })

    await userEvent.click(toggle)
    await waitFor(() => expect(api.setEnabled).toHaveBeenCalledWith('amap', false))
    expect(await screen.findByText('已停用连接器，所有会话已移除它的工具。')).toBeTruthy()
    await userEvent.click(screen.getByRole('switch', { name: '高德地图' }))
    await waitFor(() => expect(api.setEnabled).toHaveBeenCalledWith('amap', true))
    expect(await screen.findByText('已启用连接器。')).toBeTruthy()
  })

  it('requires deletion confirmation and sends nothing when cancelled', async () => {
    const api = apiFixture([view()])
    vi.mocked(api.listConnectors).mockResolvedValueOnce([view()]).mockResolvedValue([])
    renderHub(api)
    await screen.findByTestId('mine-row-amap')

    await openActions()
    await userEvent.click(screen.getByRole('menuitem', { name: '删除' }))
    expect(screen.getByText('将从所有 profile 删除此连接器及其凭据，所有会话都会立即失去它的工具。此操作无法撤销。')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(api.remove).not.toHaveBeenCalled()

    await openActions()
    await userEvent.click(screen.getByRole('menuitem', { name: '删除' }))
    await userEvent.click(screen.getByRole('button', { name: '确认删除' }))
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith('amap'))
    expect(await screen.findByText('已删除连接器及其凭据。')).toBeTruthy()
    expect(await screen.findByText('还没有添加连接器')).toBeTruthy()
  })

  it('opens a blank window synchronously, completes OAuth and displays the authorized account', async () => {
    const api = apiFixture()
    const order: string[] = []
    let resolveStart!: (value: { attemptId: string, authorizationUrl: string }) => void
    vi.mocked(api.startOAuth).mockImplementation(() => {
      order.push('start')
      return new Promise(resolve => { resolveStart = resolve })
    })
    const popup = {
      closed: false,
      location: { href: 'about:blank' },
      close: vi.fn(() => { Object.assign(popup, { closed: true }) }),
    } as unknown as Window
    const openWindow = vi.fn(() => {
      order.push('open')
      return popup
    })
    vi.mocked(api.oauthStatus).mockResolvedValue({
      attemptId: '00000000-0000-4000-8000-000000000001', connectorId: 'notion', status: 'success', error: null,
    })
    vi.mocked(api.listConnectors).mockResolvedValueOnce([]).mockResolvedValue([oauthView()])
    renderHub(api, { openWindow })

    await userEvent.click(within(await screen.findByTestId('connector-card-notion')).getByRole('button', { name: '添加' }))
    await userEvent.click(screen.getByRole('button', { name: '前往授权' }))
    expect(order).toEqual(['open', 'start'])
    resolveStart({
      attemptId: '00000000-0000-4000-8000-000000000001',
      authorizationUrl: 'https://example.com/authorize?state=state-1',
    })
    await waitFor(() => expect(popup.location.href).toBe('https://example.com/authorize?state=state-1'))
    expect(await screen.findByText('OAuth 授权成功，所有会话现在都可以使用它的工具。')).toBeTruthy()
    expect(await screen.findByText('授权账号: Engineering')).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), { timeout: 2000 })
    await userEvent.click(screen.getByRole('tab', { name: '我的' }))
    expect(within(screen.getByTestId('mine-row-notion')).getAllByText('Engineering').length).toBeGreaterThan(0)
  })

  it('copies an OAuth link when the popup is blocked and cancels the Host attempt', async () => {
    const api = apiFixture()
    const copyText = vi.fn().mockResolvedValue(undefined)
    renderHub(api, { openWindow: () => null, copyText })

    await userEvent.click(within(await screen.findByTestId('connector-card-notion')).getByRole('button', { name: '添加' }))
    await userEvent.click(screen.getByRole('button', { name: '前往授权' }))
    expect(await screen.findByText('等待授权…')).toBeTruthy()
    expect(screen.getByText('新窗口未打开，请复制链接或手动打开授权页。')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '复制链接' }))
    await waitFor(() => expect(copyText).toHaveBeenCalledWith('https://example.com/authorize?state=state-1'))
    expect(await screen.findByText('授权链接已复制。')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => expect(api.cancelOAuth).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows OAuth failures and starts a fresh attempt on retry', async () => {
    const api = apiFixture()
    vi.mocked(api.startOAuth)
      .mockResolvedValueOnce({
        attemptId: '00000000-0000-4000-8000-000000000001',
        authorizationUrl: 'https://example.com/authorize?state=state-1',
      })
      .mockResolvedValueOnce({
        attemptId: '00000000-0000-4000-8000-000000000002',
        authorizationUrl: 'https://example.com/authorize?state=state-2',
      })
    vi.mocked(api.oauthStatus).mockResolvedValueOnce({
      attemptId: '00000000-0000-4000-8000-000000000001', connectorId: 'notion', status: 'failed', error: 'authorization expired',
    }).mockResolvedValue({
      attemptId: '00000000-0000-4000-8000-000000000002', connectorId: 'notion', status: 'waiting', error: null,
    })
    renderHub(api, { openWindow: () => null })

    await userEvent.click(within(await screen.findByTestId('connector-card-notion')).getByRole('button', { name: '添加' }))
    await userEvent.click(screen.getByRole('button', { name: '前往授权' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'authorization expired')
    await userEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(api.startOAuth).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('等待授权…')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => expect(api.cancelOAuth).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000002'))
  })

  it('reauthorizes from Mine and refreshes the displayed account', async () => {
    const initial = oauthView({ status: 'reauth-required', tools: [], account: 'Old workspace' })
    const updated = oauthView({ account: 'New workspace' })
    const api = apiFixture([initial])
    vi.mocked(api.probe).mockResolvedValue(initial)
    vi.mocked(api.listConnectors).mockResolvedValueOnce([initial]).mockResolvedValue([updated])
    vi.mocked(api.oauthStatus).mockResolvedValue({
      attemptId: '00000000-0000-4000-8000-000000000001', connectorId: 'notion', status: 'success', error: null,
    })
    renderHub(api, { openWindow: () => null })
    await screen.findByTestId('mine-row-notion')

    await openActions('Notion')
    const reauthorize = screen.getByRole('menuitem', { name: '重新授权' })
    expect(reauthorize).toHaveProperty('disabled', false)
    await userEvent.click(reauthorize)
    await userEvent.click(screen.getByRole('button', { name: '前往授权' }))
    await waitFor(() => expect(api.startOAuth).toHaveBeenCalledWith('notion'))
    expect(await screen.findByText('OAuth 重新授权成功。')).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), { timeout: 2000 })
    expect(within(screen.getByTestId('mine-row-notion')).getAllByText('New workspace').length).toBeGreaterThan(0)
  })
})
