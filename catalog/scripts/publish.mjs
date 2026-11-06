import { randomUUID } from 'node:crypto'
import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildCatalog } from './build.mjs'

const defaultSiteRoot = fileURLToPath(new URL('../../../looori.github.io/', import.meta.url))
const channels = new Set(['v1', 'v2'])

/** Build and copy the catalog into a site checkout. Never commits or pushes. */
export async function publishCatalog(options = {}) {
  const channel = options.channel ?? 'v2'
  if (!channels.has(channel)) throw new Error(`Unsupported catalog channel: ${channel}`)
  const build = await buildCatalog(options)
  const siteRoot = resolve(options.siteRoot ?? defaultSiteRoot)
  const gitPath = resolve(siteRoot, '.git')
  if (!(await stat(gitPath).catch(() => null))) {
    throw new Error(`Site checkout is missing .git: ${siteRoot}`)
  }

  const outputPath = resolve(siteRoot, `dsh-connector-hub/catalog/${channel}/index.json`)
  await atomicWrite(outputPath, build.json)
  return {
    outputPath,
    revision: build.catalog.revision,
    ids: build.catalog.connectors.map(connector => connector.id),
    snapshotPath: build.snapshotPath,
  }
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
    const targetFlag = process.argv.indexOf('--target')
    const channelFlag = process.argv.indexOf('--channel')
    const siteRoot = targetFlag === -1 ? undefined : process.argv[targetFlag + 1]
    const channel = channelFlag === -1 ? undefined : process.argv[channelFlag + 1]
    if (targetFlag !== -1 && !siteRoot) throw new Error('--target requires a site checkout path')
    if (channelFlag !== -1 && !channel) throw new Error('--channel requires v1 or v2')
    const result = await publishCatalog({ siteRoot, channel })
    console.log(`Prepared catalog ${result.revision} with connectors: ${result.ids.join(', ')}`)
    console.log(`Site file: ${result.outputPath}`)
    console.log('No git commit or push was performed.')
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
