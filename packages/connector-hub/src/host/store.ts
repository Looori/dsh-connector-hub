import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  ConnectorConfigError,
  emptyConnectorConfig,
  parseConnectorConfig,
  type ConnectorConfig,
} from '../shared/config'

interface FileFingerprint {
  mtimeMs: number
  ctimeMs: number
  size: number
  ino: number
}

interface CacheEntry {
  config: ConnectorConfig
  fingerprint: FileFingerprint | null
}

export interface ReloadResult {
  config: ConnectorConfig
  changed: boolean
}

/** Versioned JSON storage shared by all DSH profiles. */
export class ConnectorStore {
  readonly filePath: string
  private queue: Promise<void> = Promise.resolve()
  private cache: CacheEntry | undefined

  constructor(dshHome: string) {
    this.filePath = resolve(dshHome, 'connector-hub', 'connectors.json')
  }

  /** Read and validate the current file, replacing the last valid snapshot only on success. */
  read(): Promise<ConnectorConfig> {
    return this.enqueue(async () => {
      const entry = await this.readDisk()
      this.cache = entry
      return structuredClone(entry.config)
    })
  }

  /** Return the cached snapshot until file metadata changes, then reload atomically. */
  reloadIfChanged(): Promise<ReloadResult> {
    return this.enqueue(async () => {
      const fingerprint = await fingerprintFile(this.filePath)
      if (this.cache && sameFingerprint(this.cache.fingerprint, fingerprint)) {
        return { config: structuredClone(this.cache.config), changed: false }
      }
      const entry = await this.readDisk()
      this.cache = entry
      return { config: structuredClone(entry.config), changed: true }
    })
  }

  /** Atomically replace the complete configuration. */
  write(config: ConnectorConfig): Promise<ConnectorConfig> {
    const next = structuredClone(parseConnectorConfig(config))
    return this.enqueue(async () => {
      await this.writeDisk(next)
      return structuredClone(next)
    })
  }

  /** Serialize read-modify-write operations within this process. */
  update(mutator: (config: ConnectorConfig) => void | Promise<void>): Promise<ConnectorConfig> {
    return this.enqueue(async () => {
      const current = await this.readDisk()
      const draft = structuredClone(current.config)
      await mutator(draft)
      const next = structuredClone(parseConnectorConfig(draft))
      await this.writeDisk(next)
      return structuredClone(next)
    })
  }

  /** Last valid in-memory state; a later corrupt file never overwrites it. */
  snapshot(): ConnectorConfig | undefined {
    return this.cache ? structuredClone(this.cache.config) : undefined
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  private async readDisk(): Promise<CacheEntry> {
    const before = await fingerprintFile(this.filePath)
    if (before === null) return { config: emptyConnectorConfig(), fingerprint: null }

    let text: string
    try {
      text = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if (isErrorCode(error, 'ENOENT')) {
        return { config: emptyConnectorConfig(), fingerprint: null }
      }
      throw error
    }

    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      throw new ConnectorConfigError('connector config is not valid JSON', 'invalid')
    }
    const config = parseConnectorConfig(value)
    const after = await fingerprintFile(this.filePath)
    if (!sameFingerprint(before, after)) {
      throw new ConnectorConfigError('connector config changed while reading; retry on the next reconciliation', 'invalid')
    }
    return { config, fingerprint: after }
  }

  private async writeDisk(config: ConnectorConfig): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporary, this.filePath)
      const fingerprint = await fingerprintFile(this.filePath)
      if (fingerprint === null) throw new Error('connector config disappeared after atomic rename')
      this.cache = { config: structuredClone(config), fingerprint }
    } catch (error) {
      await unlink(temporary).catch(() => {})
      throw error
    }
  }
}

export function createConnectorStore(dshHome: string): ConnectorStore {
  return new ConnectorStore(dshHome)
}

async function fingerprintFile(path: string): Promise<FileFingerprint | null> {
  try {
    const info = await stat(path)
    return { mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, size: info.size, ino: info.ino }
  } catch (error) {
    if (isErrorCode(error, 'ENOENT')) return null
    throw error
  }
}

function sameFingerprint(left: FileFingerprint | null, right: FileFingerprint | null): boolean {
  if (left === null || right === null) return left === right
  return left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
    && left.size === right.size && left.ino === right.ino
}

function isErrorCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === code
}
