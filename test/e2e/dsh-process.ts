import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

export interface DshWebProcess {
  child: ChildProcess
  logs(): string
  safeLogs(): string
  stop(): Promise<void>
}

export function run(command: string, args: string[], options: {
  cwd: string
  env: NodeJS.ProcessEnv
  timeout?: number
}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      ...options,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${command} ${args.join(' ')} failed: ${error.message}\n${stdout}\n${stderr}`))
      else resolve(stdout)
    })
  })
}

export function startDshWeb(command: string, args: string[], options: {
  cwd: string
  env: NodeJS.ProcessEnv
}): DshWebProcess {
  let output = ''
  const child = spawn(command, args, {
    ...options,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', chunk => { output += chunk.toString() })
  child.stderr?.on('data', chunk => { output += chunk.toString() })
  return {
    child,
    logs: () => output,
    safeLogs: () => output.replace(/([?&]token=)[^\s&]+/g, '$1<redacted>'),
    stop: () => stopProcess(child),
  }
}

export async function waitFor<T>(predicate: () => T | Promise<T>, description: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await delay(150)
  }
  throw new Error(`Timed out waiting for ${description}`)
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
  if (child.pid === undefined) return
  try { process.kill(-child.pid, 'SIGTERM') } catch { return }
  await Promise.race([exited, delay(5_000)])
  if (child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, 'SIGKILL') } catch { /* already exited */ }
    await exited
  }
}
