import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium, type Browser } from 'playwright'
import { expect, it } from 'vitest'
import { run, startDshWeb, waitFor, type DshWebProcess } from './dsh-process'
import { CONNECTOR_ID, TEST_API_KEY, startFixtureServer } from './fixture-server'

const root = fileURLToPath(new URL('../..', import.meta.url))
const packageDir = resolve(root, 'packages/connector-hub')
const dshBin = process.env.DSH_BIN ?? resolve(packageDir, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
const keyringRegister = resolve(root, 'test/e2e/keyring-register.mjs')
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

it('reports a duplicate serverName for an existing connector through real DSH and the browser UI', { timeout: 180_000 }, async () => {
  const temporary = await mkdtemp(resolve(root, '.connector-hub-conflict-e2e-'))
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
    const env = {
      ...process.env,
      DSH_HOME: home,
      NO_COLOR: '1',
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(keyringRegister).href}`.trim(),
      DSH_CONNECTOR_HUB_E2E_KEYCHAIN_JOURNAL: journal,
    }
    web = startDshWeb(process.execPath, [dshBin, '--profile', 'web', '--patch', patch, '--port', '0', '--no-open'], {
      cwd: root,
      env,
    })
    let tokenUrl = await authenticatedUrl(web)
    let cookie = await loginCookie(tokenUrl)
    let request = apiRequest(new URL(tokenUrl).origin, cookie)
    const added = await request('/api/connector-hub/api-key-connect', 'POST', { id: CONNECTOR_ID, key: TEST_API_KEY })
    expect(added.status).toBe(200)
    await web.stop()

    await writeFile(patch, [
      '- insert:',
      '    - id: e2e-duplicate-server-name',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        transport: streamable-http',
      `        serverName: ${CONNECTOR_ID}`,
      `        url: ${fixture.origin}/mcp`,
      '        headers:',
      `          x-api-key: ${TEST_API_KEY}`,
      '        failOnStartupError: true',
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
      env,
    })
    tokenUrl = await authenticatedUrl(web)
    cookie = await loginCookie(tokenUrl)
    request = apiRequest(new URL(tokenUrl).origin, cookie)
    const failed = await waitFor(async () => {
      const response = await request('/api/connector-hub/connectors')
      const connector = response.body[0]
      return connector?.errorCode === 'server-name-conflict' ? connector : undefined
    }, 'classified duplicate serverName error')
    expect(failed.error).toContain(`serverName "${CONNECTOR_ID}" is already in use`)

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
    const row = page.getByTestId(`mine-row-${CONNECTOR_ID}`)
    await row.waitFor()
    await row.getByText(`DSH already has an MCP service named “${CONNECTOR_ID}”, usually from a manual cordis.yml entry. Remove or rename that entry, then select “Remount”.`, { exact: true }).waitFor()
    await row.getByText('Mock API Key', { exact: true }).click()
    await row.getByText(`mcp-client: serverName "${CONNECTOR_ID}" is already in use by another mcp-client instance — pick a unique serverName in cordis.yml`, { exact: true }).waitFor()
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

async function authenticatedUrl(web: DshWebProcess): Promise<string> {
  return waitFor(() => {
    const match = web.logs().match(/http:\/\/(?:127\.0\.0\.1|localhost):\d+\/\?token=[^\s]+/)
    if (web.child.exitCode !== null && web.child.exitCode !== undefined) {
      throw new Error(`DSH web exited early\n${web.safeLogs()}`)
    }
    return match?.[0]
  }, 'authenticated DSH web URL')
}

async function loginCookie(tokenUrl: string): Promise<string> {
  const login = await fetch(tokenUrl, { redirect: 'manual' })
  const cookie = login.headers.get('set-cookie')?.split(';', 1)[0]
  expect(login.status).toBe(303)
  expect(cookie).toBeTruthy()
  return cookie ?? ''
}

function apiRequest(origin: string, cookie: string) {
  return async (path: string, method: 'GET' | 'POST' = 'GET', body?: Record<string, unknown>) => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    return { status: response.status, body: await response.json() as any }
  }
}
