import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium, type Browser } from 'playwright'
import { expect, it } from 'vitest'
import { run, startDshWeb, waitFor, type DshWebProcess } from './dsh-process'
import { CONNECTOR_ID, TEST_API_KEY, startFixtureServer } from './fixture-server'

const root = fileURLToPath(new URL('../..', import.meta.url))
const packageDir = resolve(root, 'packages/connector-hub')
const dshBin = resolve(packageDir, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
const keyringRegister = resolve(root, 'test/e2e/keyring-register.mjs')
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const toolName = `mcp__${CONNECTOR_ID}__echo`

it('runs the API Key lifecycle through real DSH routes and the browser UI', { timeout: 180_000 }, async () => {
  const temporary = await mkdtemp(resolve(root, '.connector-hub-e2e-'))
  const home = resolve(temporary, 'home')
  const journal = resolve(temporary, 'keychain-journal.txt')
  await mkdir(home, { recursive: true })

  let fixture: Awaited<ReturnType<typeof startFixtureServer>> | undefined
  let web: DshWebProcess | undefined
  let browser: Browser | undefined
  try {
    fixture = await startFixtureServer()
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

    expect((await fetch(`${origin}/api/connector-hub/catalog`)).status).toBe(401)
    const catalog = await request('/api/connector-hub/catalog')
    expect(catalog.status).toBe(200)
    expect(catalog.body).toMatchObject({ source: 'network', stale: false })
    expect(catalog.body.catalog.connectors).toHaveLength(1)
    expect(catalog.body.catalog.connectors[0].id).toBe(CONNECTOR_ID)

    const rejected = await request('/api/connector-hub/api-key-connect', 'POST', { id: CONNECTOR_ID, key: 'wrong-key' })
    expect(rejected.status).toBe(400)
    expect((await request('/api/connector-hub/connectors')).body).toEqual([])
    expect(await readIfPresent(journal)).not.toContain('set ')

    const added = await request('/api/connector-hub/api-key-connect', 'POST', { id: CONNECTOR_ID, key: TEST_API_KEY })
    expect(added.status).toBe(200)
    expect(added.body).toMatchObject({ id: CONNECTOR_ID, status: 'connected', enabled: true })
    expect(added.body.tools).toContain(toolName)

    const configPath = resolve(home, 'connector-hub/connectors.json')
    const storedConfig = await readFile(configPath, 'utf8')
    expect(storedConfig).toContain(CONNECTOR_ID)
    expect(storedConfig).not.toContain(TEST_API_KEY)
    expect(await readFile(journal, 'utf8')).toContain(`set dsh-connector-hub ${CONNECTOR_ID}`)

    const probed = await request('/api/connector-hub/probe', 'POST', { id: CONNECTOR_ID })
    expect(probed.status).toBe(200)
    expect(probed.body.lastProbe).toMatchObject({ ok: true })
    expect(probed.body.lastProbe.tools).toContain(toolName)

    const remounted = await request('/api/connector-hub/remount', 'POST', { id: CONNECTOR_ID })
    expect(remounted.status).toBe(200)
    expect(remounted.body.generation).toBeGreaterThan(added.body.generation)
    expect(remounted.body.tools).toEqual(added.body.tools)

    const disabled = await request('/api/connector-hub/set-enabled', 'POST', { id: CONNECTOR_ID, enabled: false })
    expect(disabled.body).toMatchObject({ enabled: false, status: 'disabled', tools: [] })
    const enabled = await request('/api/connector-hub/set-enabled', 'POST', { id: CONNECTOR_ID, enabled: true })
    expect(enabled.body).toMatchObject({ enabled: true, status: 'connected' })
    expect(enabled.body.tools).toContain(toolName)

    expect((await request('/api/connector-hub/remove', 'POST', { id: CONNECTOR_ID })).body).toEqual({ removed: true })
    expect((await request('/api/connector-hub/connectors')).body).toEqual([])
    expect(await readFile(configPath, 'utf8')).not.toContain(TEST_API_KEY)
    expect(await readFile(journal, 'utf8')).toContain(`delete true dsh-connector-hub ${CONNECTOR_ID}`)

    browser = await chromium.launch({
      headless: true,
      ...(existsSync(chromePath) ? { executablePath: chromePath } : {}),
    })
    const context = await browser.newContext({ locale: 'en-US' })
    const page = await context.newPage()
    const pageErrors: string[] = []
    page.on('pageerror', error => pageErrors.push(error.message))
    let connectRequests = 0
    page.on('request', request => {
      if (request.url().includes('/api/connector-hub/api-key-connect')) connectRequests++
    })

    await page.goto(tokenUrl)
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await page.getByRole('dialog', { name: 'Preview Notice' }).waitFor({ state: 'hidden' })
    await page.getByText('Plugins', { exact: true }).first().click()
    await page.getByRole('tab', { name: 'Connectors', exact: true }).click()
    await page.getByRole('tab', { name: 'Discover', exact: true }).waitFor()
    await page.getByTestId(`connector-card-${CONNECTOR_ID}`).waitFor()

    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await page.getByRole('dialog', { name: 'Add connector' }).waitFor()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    expect(connectRequests).toBe(0)
    expect((await request('/api/connector-hub/connectors')).body).toEqual([])

    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await page.getByLabel('Test Key', { exact: true }).fill(TEST_API_KEY)
    const addResponse = page.waitForResponse(response =>
      response.url().includes('/api/connector-hub/api-key-connect') && response.request().method() === 'POST')
    await page.getByRole('button', { name: 'Save and connect', exact: true }).click()
    expect((await addResponse).status()).toBe(200)
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    await page.getByRole('tab', { name: 'Mine', exact: true }).click()
    const row = page.getByTestId(`mine-row-${CONNECTOR_ID}`)
    await row.waitFor()
    await row.getByText('Connected', { exact: true }).waitFor()

    const disableResponse = page.waitForResponse(response => response.url().includes('/api/connector-hub/set-enabled'))
    await page.getByRole('switch', { name: 'Mock API Key', exact: true }).click()
    expect((await disableResponse).status()).toBe(200)
    await page.getByText('Connector disabled. Its tools were removed from every session.', { exact: true }).waitFor()
    await row.getByText('Disabled', { exact: true }).waitFor()

    const enableResponse = page.waitForResponse(response => response.url().includes('/api/connector-hub/set-enabled'))
    await page.getByRole('switch', { name: 'Mock API Key', exact: true }).click()
    expect((await enableResponse).status()).toBe(200)
    await row.getByText('Connected', { exact: true }).waitFor()

    await page.getByRole('button', { name: 'Actions: Mock API Key', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Remove', exact: true }).click()
    await page.getByRole('dialog', { name: 'Remove connector · Mock API Key' }).waitFor()
    const removeResponse = page.waitForResponse(response => response.url().includes('/api/connector-hub/remove'))
    await page.getByRole('button', { name: 'Remove connector', exact: true }).click()
    expect((await removeResponse).status()).toBe(200)
    await page.getByText('No connectors added yet', { exact: true }).waitFor()
    expect((await request('/api/connector-hub/connectors')).body).toEqual([])
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
