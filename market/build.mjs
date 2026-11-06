import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assertValidMarketIndex } from './validate.mjs'

const defaultSourceRoot = fileURLToPath(new URL('./', import.meta.url))

/**
 * Build the format-1 plugin-market index from `plugins.json`, `releases.json`, and each
 * plugin's own `package.json`. Everything is validated in memory before the snapshot is replaced.
 */
export async function buildMarketIndex(options = {}) {
  const sourceRoot = resolve(options.sourceRoot ?? defaultSourceRoot)
  const repoRoot = resolve(options.repoRoot ?? resolve(sourceRoot, '..'))
  const snapshotPath = resolve(options.snapshotPath ?? resolve(sourceRoot, 'index.json'))

  const source = JSON.parse(await readFile(resolve(sourceRoot, 'plugins.json'), 'utf8'))
  const releases = JSON.parse(await readFile(resolve(sourceRoot, 'releases.json'), 'utf8'))
  if (!Array.isArray(source?.plugins)) throw new Error('market/plugins.json must contain a plugins list')

  const plugins = []
  for (const entry of source.plugins) {
    const manifestPath = manifestPathFor(entry, repoRoot)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    plugins.push({ ...entry, versions: await versionsFor(entry, manifest, releases) })
  }

  const index = { ...source, plugins }
  assertValidMarketIndex(index, {
    iconDirectory: (icon, fail) => {
      if (!existsSync(resolve(sourceRoot, icon))) fail('file does not exist')
    },
  })

  const json = `${JSON.stringify(index, null, 2)}\n`
  await atomicWrite(snapshotPath, json)
  return { index, json, sourceRoot, snapshotPath }
}

/** Resolve the plugin package's manifest from the entry's displayed repository directory. */
function manifestPathFor(entry, repoRoot) {
  const directory = entry?.repository?.directory
  if (typeof entry?.name !== 'string' || entry.name === '') throw new Error('Every market plugin needs a name')
  if (typeof directory !== 'string' || directory === '') {
    throw new Error(`Market plugin ${entry.name} needs repository.directory to locate its package.json`)
  }
  return resolve(repoRoot, directory, 'package.json')
}

async function versionsFor(entry, manifest, releases) {
  const name = entry.name
  if (manifest.name !== name) throw new Error(`Package at repository.directory declares ${manifest.name}, expected ${name}`)
  if (manifest.dsh?.bundle?.patch === undefined) throw new Error(`Package ${name} does not declare dsh.bundle`)
  if (typeof manifest.engines?.dsh !== 'string') throw new Error(`Package ${name} does not declare engines.dsh`)

  const published = releases?.[name]
  if (!isRecord(published) || Object.keys(published).length === 0) {
    throw new Error(`market/releases.json has no published versions for ${name}`)
  }

  const current = published[manifest.version]
  if (!isRecord(current)) {
    throw new Error(`market/releases.json has no entry for ${name}@${manifest.version}; record its npm publish time before building`)
  }
  if (current.engines !== manifest.engines.dsh) {
    throw new Error(`market/releases.json engine range for ${name}@${manifest.version} must equal the package engines.dsh`)
  }

  return Object.entries(published)
    .map(([version, release]) => {
      if (!isRecord(release)) throw new Error(`market/releases.json entry for ${name}@${version} must be an object`)
      if (release.engines !== manifest.engines.dsh) {
        throw new Error(`market/releases.json engine range for ${name}@${version} does not match the package engines.dsh`)
      }
      return {
        version,
        publishTimestamp: release.publishTimestamp,
        source: { type: 'npm' },
        engines: { dsh: release.engines },
      }
    })
    .sort((left, right) => right.publishTimestamp - left.publishTimestamp || left.version.localeCompare(right.version))
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

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await buildMarketIndex()
    for (const plugin of result.index.plugins) {
      const versions = plugin.versions.map(version => version.version).join(', ')
      console.log(`Built market entry ${plugin.name}: ${versions}`)
    }
    console.log(`Snapshot: ${result.snapshotPath}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
