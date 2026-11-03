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
    mountedAt: '2026-11-03T08:00:00.000Z', tools: ['mcp__amap__maps_geo'], error: null,
    catalogRevision: 'test.1', addedAt: '2026-11-03T08:00:00.000Z',
    remote: amap.remote, auth: amap.auth, lastProbe: null,
    ...overrides,
  }
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
    probe: vi.fn().mockImplementation(async id => view({ id })),
    remount: vi.fn().mockImplementation(async id => view({ id })),
    setEnabled: vi.fn().mockImplementation(async (id, enabled) => view({ id, enabled, status: enabled ? 'connected' : 'disabled' })),
    remove: vi.fn().mockResolvedValue({ removed: true }),
  }
  return api
}

function renderHub(api: ConnectorHubApi) {
  return render(createElement(ConnectorHub, {
    api,
    t: (key: LocaleKey) => zh[key],
    resolveText: (text: LocalizedText) => text.zh,
    pollMs: 1_000_000,
  }))
}

async function openActions(name = '高德地图') {
  await userEvent.click(await screen.findByRole('button', { name: `操作: ${name}` }))
}

describe('connector hub browser UI', () => {
  it('renders the catalog, starts on Discover when empty, and disables OAuth', async () => {
    const api = apiFixture()
    renderHub(api)

    expect(await screen.findByTestId('connector-card-amap')).toBeTruthy()
    expect(screen.getByRole('tab', { selected: true })).toHaveProperty('textContent', '发现')
    expect(screen.getByText('查询地点、路线和天气。')).toBeTruthy()
    expect(screen.getAllByText('官方服务')).toHaveLength(2)

    const oauthCard = screen.getByTestId('connector-card-notion')
    expect(within(oauthCard).getByRole('button', { name: '添加' })).toHaveProperty('disabled', true)
    expect(within(oauthCard).getByText('OAuth 授权将在 M3 提供')).toBeTruthy()
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
})
