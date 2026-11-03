import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse } from 'yaml'
import { assertValidCatalog } from './validate.mjs'

const defaultSourceRoot = fileURLToPath(new URL('../', import.meta.url))
const defaultSnapshotPath = fileURLToPath(new URL('../../packages/connector-hub/catalog/index.json', import.meta.url))

/** Build and validate the catalog entirely in memory before replacing the snapshot. */
export async function buildCatalog(options = {}) {
  const sourceRoot = resolve(options.sourceRoot ?? defaultSourceRoot)
  const snapshotPath = resolve(options.snapshotPath ?? defaultSnapshotPath)
  const index = await readYaml(resolve(sourceRoot, 'index.yaml'))
  if (!Array.isArray(index?.connectors)) throw new Error('catalog/index.yaml must contain a connectors list')

  const connectors = []
  for (const id of index.connectors) {
    if (typeof id !== 'string') throw new Error('Every catalog connector reference must be a string')
    const connector = await readYaml(resolve(sourceRoot, 'connectors', `${id}.yaml`))
    if (connector?.id !== id) throw new Error(`Catalog file ${id}.yaml must contain matching id ${id}`)
    connectors.push(connector)
  }

  const catalog = { ...index, connectors }
  assertValidCatalog(catalog)
  const json = `${JSON.stringify(catalog, null, 2)}\n`
  await atomicWrite(snapshotPath, json)
  return { catalog, json, snapshotPath }
}

async function readYaml(path) {
  return parse(await readFile(path, 'utf8'))
}

async function atomicWrite(path, contents) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, contents, 'utf8')
    await rename(temporary, path)
  } catch (error) {
    await unlink(temporary).catch(() => {})
    throw error
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { catalog, snapshotPath } = await buildCatalog()
    console.log(`Built catalog ${catalog.revision} with ${catalog.connectors.length} connectors: ${catalog.connectors.map(item => item.id).join(', ')}`)
    console.log(`Snapshot: ${snapshotPath}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
