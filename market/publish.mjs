import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildMarketIndex } from './build.mjs'

const defaultSiteRoot = fileURLToPath(new URL('../../looori.github.io/', import.meta.url))

/** Build the index and copy it with its icons into a site checkout. Never commits or pushes. */
export async function publishMarketIndex(options = {}) {
  const build = await buildMarketIndex(options)
  const siteRoot = resolve(options.siteRoot ?? defaultSiteRoot)
  if (!(await stat(resolve(siteRoot, '.git')).catch(() => null))) {
    throw new Error(`Site checkout is missing .git: ${siteRoot}`)
  }

  const outputDir = resolve(siteRoot, 'dsh-connector-hub/plugin')
  const outputPath = resolve(outputDir, 'index.json')
  await atomicWrite(outputPath, build.json)
  await copyIcons(resolve(build.sourceRoot, 'icons'), resolve(outputDir, 'icons'))

  return {
    outputPath,
    snapshotPath: build.snapshotPath,
    plugins: build.index.plugins.map(plugin => ({
      name: plugin.name,
      versions: plugin.versions.map(version => version.version),
    })),
  }
}

async function copyIcons(sourceDir, targetDir) {
  const entries = await readdir(sourceDir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const target = resolve(targetDir, entry.name)
    await mkdir(dirname(target), { recursive: true })
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
    try {
      await copyFile(resolve(sourceDir, entry.name), temporary)
      await rename(temporary, target)
    } catch (error) {
      await unlink(temporary).catch(() => {})
      throw error
    }
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
    const siteRoot = targetFlag === -1 ? undefined : process.argv[targetFlag + 1]
    if (targetFlag !== -1 && !siteRoot) throw new Error('--target requires a site checkout path')
    const result = await publishMarketIndex({ siteRoot })
    for (const plugin of result.plugins) console.log(`Prepared ${plugin.name}: ${plugin.versions.join(', ')}`)
    console.log(`Site file: ${result.outputPath}`)
    console.log('No git commit or push was performed.')
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
