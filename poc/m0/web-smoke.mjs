import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const root = new URL('../', import.meta.url).pathname
const dsh = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
const children = []
let logs = { mcp: '', web: '' }

function run(name, command, args) {
  const child = spawn(command, args, {
    cwd: root,
    detached: true,
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  const collect = chunk => { logs[name] += chunk.toString() }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  return child
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  try { process.kill(-child.pid, 'SIGTERM') } catch { return }
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    delay(3000),
  ])
}

async function waitFor(predicate, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await delay(200)
  }
  throw new Error(`Timed out waiting for ${description}`)
}

async function request(origin, cookie, path, method = 'GET') {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: cookie ? { cookie } : {},
  })
  const text = await response.text()
  let body
  try { body = JSON.parse(text) } catch { body = text }
  return { status: response.status, body }
}

function assert(value, message) {
  if (!value) throw new Error(message)
}

try {
  run('mcp', process.execPath, ['test-server/server.mjs'])
  await waitFor(() => logs.mcp.includes('listening on'), 'MCP server')

  run('web', dsh, ['web', '--port', '0', '--no-open'])
  const tokenUrl = await waitFor(() => {
    const match = logs.web.match(/http:\/\/(?:127\.0\.0\.1|localhost):\d+\/\?token=[^\s]+/)
    return match?.[0]
  }, 'authenticated web URL')
  const login = await fetch(tokenUrl, { redirect: 'manual' })
  const setCookie = login.headers.get('set-cookie')
  assert(setCookie, `Login did not set a cookie (HTTP ${login.status})`)
  const cookie = setCookie.split(';', 1)[0]
  const origin = new URL(tokenUrl).origin

  const unauthenticated = await request(origin, null, '/api/connector-hub/status')
  const status = await request(origin, cookie, '/api/connector-hub/status')
  const keychain = await request(origin, cookie, '/api/connector-hub/keychain-test', 'POST')
  const initial = await request(origin, cookie, '/api/connector-hub/mcp-status')
  const probe = await request(origin, cookie, '/api/connector-hub/mcp-probe', 'POST')
  const remount = await request(origin, cookie, '/api/connector-hub/mcp-remount', 'POST')

  assert(unauthenticated.status === 401, `Unauthenticated route returned ${unauthenticated.status}`)
  assert(status.status === 200 && status.body.node, 'Runtime status failed')
  assert(keychain.status === 200 && keychain.body.ok === true, 'Keychain round trip failed')
  assert(initial.status === 200 && initial.body.status === 'connected', 'MCP did not connect')
  assert(initial.body.tools?.global?.includes('mcp__pocdemo__echo'), 'echo tool missing')
  assert(initial.body.tools?.global?.includes('mcp__pocdemo__whoami'), 'whoami tool missing')
  assert(probe.status === 200 && probe.body.ok === true, 'MCP probe failed')
  assert(remount.status === 200 && remount.body.sameNames === true, 'Tool names changed after remount')
  assert(remount.body.afterDispose?.length === 0, 'Tools remained after dispose')

  console.log(JSON.stringify({
    ok: true,
    dsh: '0.2.1-rc.5',
    checks: {
      unauthenticated: unauthenticated.status,
      runtime: { node: status.body.node, electron: status.body.electron, runAsNode: status.body.runAsNode },
      keychain: keychain.body.ok,
      initial: { status: initial.body.status, tools: initial.body.tools.global },
      probe: probe.body,
      remount: {
        sameNames: remount.body.sameNames,
        afterDispose: remount.body.afterDispose,
        after: remount.body.after,
        generation: remount.body.status.generation,
      },
    },
  }, null, 2))
} catch (error) {
  const sanitized = logs.web.replace(/([?&]token=)[^\s&]+/g, '$1<redacted>')
  console.error(JSON.stringify({ ok: false, error: String(error), webLog: sanitized, mcpLog: logs.mcp }, null, 2))
  process.exitCode = 1
} finally {
  for (const child of children.reverse()) await stop(child)
}
