import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium, type Browser } from 'playwright'
import { expect, it } from 'vitest'
import { startOAuthFixtureServer, type OAuthFixtureServer } from '../oauth-fixture-server'
import { run, startDshWeb, waitFor, type DshWebProcess } from './dsh-process'

const root = fileURLToPath(new URL('../..', import.meta.url))
const packageDir = resolve(root, 'packages/connector-hub')
const dshBin = process.env.DSH_BIN ?? resolve(packageDir, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
const keyringRegister = resolve(root, 'test/e2e/keyring-register.mjs')
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const toolName = 'mcp__notion__echo'

it('runs OAuth authorization, refresh, reauthorization and revocation through real DSH and browser UI', { timeout: 180_000 }, async () => {
  const temporary = await mkdtemp(resolve(root, '.connector-hub-oauth-e2e-'))
  const home = resolve(temporary, 'home')
  const journal = resolve(temporary, 'keychain-journal.txt')
  await mkdir(home, { recursive: true })

  let fixture: OAuthFixtureServer | undefined
  let web: DshWebProcess | undefined
  let browser: Browser | undefined
  try {
    fixture = await startOAuthFixtureServer()
    fixture.includeAccount = true
    fixture.pauseAuthorization = true
    await run(process.execPath, ['build.mjs'], {
      cwd: packageDir,
      env: { ...process.env, NO_COLOR: '1' },
      timeout: 30_000,
    })
    await run(process.execPath, [dshBin, 'plugin', '--profile', 'web', 'add', packageDir], {
      cwd: root,
      env: {
        ...process.env,
        DSH_HOME: home,
        NO_COLOR: '1',
        CI: '1',
        npm_config_registry: 'https://registry.npmmirror.com',
      },
      timeout: 120_000,
    })

    const patch = resolve(temporary, 'e2e.patch.yml')
    await writeFile(patch, [
      '- id: connector-hub',
      '  config:',
      `    catalogUrl: ${fixture.catalogUrl}`,
      '- id: ui-settings-models',
      '  config:',
      '    credentialOnboarding: false',
      '',
    ].join('\n'), 'utf8')
    web = startDshWeb(process.execPath, [dshBin, '--profile', 'web', '--patch', patch, '--port', '0', '--no-open'], {
      cwd: root,
      env: {
        ...process.env,
        DSH_HOME: home,
        NO_COLOR: '1',
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(keyringRegister).href}`.trim(),
        DSH_CONNECTOR_HUB_E2E_KEYCHAIN_JOURNAL: journal,
      },
    })

    const tokenUrl = await waitFor(() => {
      const match = web?.logs().match(/http:\/\/(?:127\.0\.0\.1|localhost):\d+\/\?token=[^\s]+/)
      if (web?.child.exitCode !== null && web?.child.exitCode !== undefined) {
        throw new Error(`DSH web exited early\n${web.safeLogs()}`)
      }
      return match?.[0]
    }, 'authenticated DSH web URL')
    const origin = new URL(tokenUrl).origin
    const login = await fetch(tokenUrl, { redirect: 'manual' })
    const cookie = login.headers.get('set-cookie')?.split(';', 1)[0]
    expect(login.status).toBe(303)
    expect(cookie).toBeTruthy()

    const request = async (path: string, method: 'GET' | 'POST' = 'GET', body?: Record<string, unknown>) => {
      const response = await fetch(`${origin}${path}`, {
        method,
        headers: { cookie: cookie ?? '', ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      return { status: response.status, body: await response.json() as any }
    }

    const catalog = await request('/api/connector-hub/catalog')
    expect(catalog.status).toBe(200)
    expect(catalog.body.catalog.connectors).toHaveLength(1)
    expect(catalog.body.catalog.connectors[0].auth.type).toBe('oauth')

    browser = await chromium.launch({
      headless: true,
      ...(existsSync(chromePath) ? { executablePath: chromePath } : {}),
    })
    const context = await browser.newContext({ locale: 'en-US' })
    const page = await context.newPage()
    const pageErrors: string[] = []
    page.on('pageerror', error => pageErrors.push(error.message))
    await page.goto(tokenUrl)
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await page.getByRole('dialog', { name: 'Preview Notice' }).waitFor({ state: 'hidden' })
    await page.getByText('Plugins', { exact: true }).first().click()
    await page.getByRole('tab', { name: 'Connectors', exact: true }).click()
    await page.getByTestId('connector-card-notion').waitFor()

    // Cancel while the provider page is paused: no config or keychain entry may survive.
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await page.getByRole('dialog', { name: 'Connect OAuth account' }).waitFor()
    await page.getByRole('button', { name: 'Authorize', exact: true }).click()
    await page.getByText('Waiting for authorization…', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    expect((await request('/api/connector-hub/connectors')).body).toEqual([])
    expect(fixture.tokenRequests).toHaveLength(0)
    expect(await readIfPresent(journal)).not.toContain('set ')

    // Complete a real browser popup -> loopback callback -> token exchange -> MCP mount flow.
    fixture.pauseAuthorization = false
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await page.getByRole('button', { name: 'Authorize', exact: true }).click()
    await page.getByText('OAuth authorization succeeded. Its tools are now available in every session.', { exact: true }).waitFor()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    await page.getByRole('tab', { name: 'Yours', exact: true }).click()
    const row = page.getByTestId('mine-row-notion')
    await row.waitFor()
    await row.getByText('Connected', { exact: true }).waitFor()
    await row.getByText('E2E Workspace', { exact: true }).first().waitFor()

    const added = await request('/api/connector-hub/connectors')
    expect(added.body).toHaveLength(1)
    expect(added.body[0]).toMatchObject({ id: 'notion', status: 'connected', account: 'E2E Workspace' })
    expect(added.body[0].tools).toContain(toolName)
    expect(fixture.tokenRequests).toHaveLength(1)
    expect(fixture.registrationRequests).toBe(0)
    const originalGeneration = added.body[0].generation
    const originalTools = added.body[0].tools
    const configPath = resolve(home, 'connector-hub/connectors.json')
    expect(await readFile(configPath, 'utf8')).not.toMatch(/access-|refresh-/)
    expect(await readFile(journal, 'utf8')).toContain('set dsh-connector-hub notion')

    fixture.catalog.connectors[0].auth.scope = 'openid mcp:connect catalog-update'
    fixture.catalog.revision = 'oauth-e2e.2'
    const updates = await request('/api/connector-hub/catalog-refresh', 'POST')
    expect(updates.body.updates).toEqual([{ id: 'notion', kind: 'changed', fields: ['auth.scope'] }])
    await page.reload()
    await page.getByText('Plugins', { exact: true }).first().click()
    await page.getByRole('tab', { name: 'Connectors', exact: true }).click()
    await row.waitFor()
    fixture.pauseAuthorization = true
    await page.getByRole('button', { name: 'Actions: Mock OAuth', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Apply update', exact: true }).click()
    const updateDialog = page.getByRole('dialog', { name: 'Apply catalog update' })
    await updateDialog.waitFor()
    await updateDialog.getByText('openid mcp:connect → openid mcp:connect catalog-update', { exact: true }).waitFor()
    await updateDialog.getByRole('button', { name: 'Apply update', exact: true }).click()
    await page.getByRole('dialog', { name: 'Reauthorize OAuth account' }).waitFor()
    await page.getByRole('button', { name: 'Authorize', exact: true }).click()
    await page.getByText('Waiting for authorization…', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    expect(JSON.parse(await readFile(configPath, 'utf8')).connectors.notion).toMatchObject({
      catalogRevision: 'oauth-e2e.1', auth: { scope: 'openid mcp:connect' },
    })
    expect((await request('/api/connector-hub/connectors')).body[0]).toMatchObject({ status: 'connected' })
    expect(fixture.tokenRequests).toHaveLength(1)
    fixture.pauseAuthorization = false

    // A rejected access token causes one refresh and retry without remounting the MCP client.
    fixture.rejectMcpOnce = true
    const refreshed = await request('/api/connector-hub/probe', 'POST', { id: 'notion' })
    expect(refreshed.status).toBe(200)
    expect(refreshed.body.lastProbe).toMatchObject({ ok: true })
    expect(refreshed.body.generation).toBe(originalGeneration)
    expect(refreshed.body.tools).toEqual(originalTools)
    expect(fixture.refreshRequests).toHaveLength(1)
    expect(fixture.refreshRequests[0].get('refresh_token')).toBe('refresh-1')
    expect(fixture.mcpRequests.some(item => item.authorization === 'Bearer access-2')).toBe(true)

    const disabled = await request('/api/connector-hub/set-enabled', 'POST', { id: 'notion', enabled: false })
    expect(disabled.body).toMatchObject({ enabled: false, status: 'disabled', tools: [] })
    const enabled = await request('/api/connector-hub/set-enabled', 'POST', { id: 'notion', enabled: true })
    expect(enabled.body).toMatchObject({ enabled: true, status: 'connected' })
    expect(enabled.body.tools).toEqual(originalTools)

    // invalid_grant retains the credential for replacement, unmounts and blocks remounting.
    fixture.rejectMcp = true
    fixture.rejectRefresh = true
    const rejected = await request('/api/connector-hub/probe', 'POST', { id: 'notion' })
    expect(rejected.status).toBe(200)
    expect(rejected.body.status).toBe('reauth-required')
    expect(rejected.body.tools).toEqual([])
    expect((await request('/api/connector-hub/remount', 'POST', { id: 'notion' })).status).toBe(409)
    expect(await readFile(journal, 'utf8')).not.toContain('delete ')
    await page.getByRole('button', { name: 'Actions: Mock OAuth', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Probe', exact: true }).click()
    await row.getByText('Authorization required', { exact: true }).waitFor()

    // Reauthorize through the same UI, then delete locally and revoke remotely.
    fixture.rejectMcp = false
    fixture.rejectRefresh = false
    await page.getByRole('button', { name: 'Actions: Mock OAuth', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Reauthorize', exact: true }).click()
    await page.getByRole('dialog', { name: 'Reauthorize OAuth account' }).waitFor()
    await page.getByRole('button', { name: 'Authorize', exact: true }).click()
    await page.getByText('OAuth reauthorization succeeded.', { exact: true }).waitFor()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    await row.getByText('Connected', { exact: true }).waitFor()
    expect(fixture.tokenRequests).toHaveLength(2)

    const removed = await request('/api/connector-hub/remove', 'POST', { id: 'notion' })
    expect(removed.body).toEqual({ removed: true })
    expect(fixture.revocationRequests).toBe(1)
    expect((await request('/api/connector-hub/connectors')).body).toEqual([])
    expect(await readFile(configPath, 'utf8')).not.toContain('notion')
    expect(await readFile(journal, 'utf8')).toContain('delete true dsh-connector-hub notion')
    expect(pageErrors).toEqual([])
  } catch (error) {
    if (web) console.error(web.safeLogs())
    throw error
  } finally {
    await browser?.close()
    await web?.stop()
    await fixture?.close()
    await rm(temporary, { recursive: true, force: true })
  }
})

async function readIfPresent(path: string): Promise<string> {
  try { return await readFile(path, 'utf8') } catch { return '' }
}
