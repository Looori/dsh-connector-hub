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

it('runs device OAuth through real DSH routes and the browser UI', { timeout: 180_000 }, async () => {
  const temporary = await mkdtemp(resolve(root, '.connector-hub-device-e2e-'))
  const home = resolve(temporary, 'home')
  const journal = resolve(temporary, 'keychain-journal.txt')
  await mkdir(home, { recursive: true })

  let fixture: OAuthFixtureServer | undefined
  let web: DshWebProcess | undefined
  let browser: Browser | undefined
  try {
    fixture = await startOAuthFixtureServer({ includeDeviceConnector: true })
    fixture.devicePollRepeatOutcome = 'authorization_pending'
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
    expect(catalog.body.catalog.connectors).toHaveLength(2)
    expect(catalog.body.catalog.connectors[1].auth).toMatchObject({ type: 'oauth', flow: 'device' })

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
    const card = page.getByTestId('connector-card-github')
    await card.waitFor()

    await card.getByRole('button', { name: 'Add', exact: true }).click()
    await page.getByRole('dialog', { name: 'Connect OAuth account' }).waitFor()
    await page.getByRole('button', { name: 'Authorize', exact: true }).click()
    await page.getByText('ABCD-EFGH', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    expect((await request('/api/connector-hub/connectors')).body).toEqual([])
    expect(await readIfPresent(journal)).not.toContain('set ')

    fixture.devicePollRepeatOutcome = undefined
    await card.getByRole('button', { name: 'Add', exact: true }).click()
    await page.getByRole('button', { name: 'Authorize', exact: true }).click()
    await page.getByText('ABCD-EFGH', { exact: true }).waitFor()
    await page.getByText('OAuth authorization succeeded. Its tools are now available in every session.', { exact: true }).waitFor()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    await page.getByRole('tab', { name: 'Yours', exact: true }).click()
    const row = page.getByTestId('mine-row-github')
    await row.waitFor()
    await row.getByText('Connected', { exact: true }).waitFor()

    const added = await request('/api/connector-hub/connectors')
    expect(added.body).toHaveLength(1)
    expect(added.body[0]).toMatchObject({ id: 'github', status: 'connected' })
    expect(added.body[0].tools).toContain('mcp__github__echo')
    expect(fixture.deviceRequests).toHaveLength(2)
    expect(fixture.deviceRequests[1].get('client_id')).toBe('shared-public-client')
    expect(fixture.deviceRequests[1].get('scope')).toBe('offline_access')
    expect(fixture.devicePollRequests.length).toBeGreaterThanOrEqual(1)
    expect(fixture.registrationRequests).toBe(0)
    const originalGeneration = added.body[0].generation
    const configPath = resolve(home, 'connector-hub/connectors.json')
    expect(await readFile(configPath, 'utf8')).not.toMatch(/access-|refresh-/)
    expect(await readFile(journal, 'utf8')).toContain('set dsh-connector-hub github')

    fixture.rejectMcpOnce = true
    const refreshed = await request('/api/connector-hub/probe', 'POST', { id: 'github' })
    expect(refreshed.status).toBe(200)
    expect(refreshed.body.lastProbe).toMatchObject({ ok: true })
    expect(refreshed.body.generation).toBe(originalGeneration)
    expect(fixture.refreshRequests).toHaveLength(1)
    expect(fixture.refreshRequests[0].get('refresh_token')).toBe('refresh-1')

    expect((await request('/api/connector-hub/set-enabled', 'POST', { id: 'github', enabled: false })).body)
      .toMatchObject({ enabled: false, status: 'disabled', tools: [] })
    expect((await request('/api/connector-hub/set-enabled', 'POST', { id: 'github', enabled: true })).body)
      .toMatchObject({ enabled: true, status: 'connected' })
    expect((await request('/api/connector-hub/remove', 'POST', { id: 'github' })).body).toEqual({ removed: true })
    expect((await request('/api/connector-hub/connectors')).body).toEqual([])
    expect(await readFile(configPath, 'utf8')).not.toContain('github')
    expect(await readFile(journal, 'utf8')).toContain('delete true dsh-connector-hub github')
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
