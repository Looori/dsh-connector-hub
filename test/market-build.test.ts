import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { buildMarketIndex } from '../market/build.mjs'
import { publishMarketIndex } from '../market/publish.mjs'
import { validateMarketIndex } from '../market/validate.mjs'

const sourceRoot = fileURLToPath(new URL('../market/', import.meta.url))
const snapshotPath = fileURLToPath(new URL('../market/index.json', import.meta.url))
const temporaryPaths = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('plugin market build', () => {
  it('builds a deterministic, valid snapshot that matches the checked-in file', async () => {
    const first = await buildMarketIndex()
    const second = await buildMarketIndex()
    expect(second.json).toBe(first.json)
    expect(await readFile(snapshotPath, 'utf8')).toBe(first.json)
    expect(validateMarketIndex(first.index)).toEqual([])
    expect(first.json.endsWith('\n')).toBe(true)
  })

  it('lists all recorded releases newest first', async () => {
    const { index } = await buildMarketIndex()
    const manifest = JSON.parse(await readFile(fileURLToPath(new URL('../packages/connector-hub/package.json', import.meta.url)), 'utf8'))
    const releases = JSON.parse(await readFile(resolve(sourceRoot, 'releases.json'), 'utf8'))
    const plugin = index.plugins[0]
    expect(plugin.name).toBe(manifest.name)
    expect(plugin.versions).toEqual(Object.entries(releases[manifest.name])
      .map(([version, release]) => ({
        version,
        publishTimestamp: release.publishTimestamp,
        source: { type: 'npm' },
        engines: { dsh: manifest.engines.dsh },
      }))
      .sort((left, right) => right.publishTimestamp - left.publishTimestamp || left.version.localeCompare(right.version)))
  })

  it('refuses to build when the current version has no recorded release', async () => {
    const fixture = await makeFixture()
    await writeFile(fixture.releases, JSON.stringify({ 'dsh-connector-hub': { '0.1.0': { publishTimestamp: 1, engines: '>=0.2.1-rc.5 <0.3.0' } } }), 'utf8')
    await expect(buildMarketIndex(fixture.options)).rejects.toThrow('has no entry for dsh-connector-hub@0.2.0')
  })

  it('refuses a release whose engine range drifted from the package', async () => {
    const fixture = await makeFixture()
    await writeFile(fixture.releases, JSON.stringify({ 'dsh-connector-hub': { '0.2.0': { publishTimestamp: 1, engines: '>=0.2.0 <0.3.0' } } }), 'utf8')
    await expect(buildMarketIndex(fixture.options)).rejects.toThrow('must equal the package engines.dsh')
  })

  it('rejects an icon that is missing from the market directory', async () => {
    const fixture = await makeFixture()
    await rm(resolve(fixture.options.repoRoot, 'market/icons/connector-hub.svg'))
    await expect(buildMarketIndex(fixture.options)).rejects.toThrow('file does not exist')
  })
})

describe('plugin market publishing', () => {
  it('writes the index and its icons into a site checkout without touching other files', async () => {
    const fixture = await makeFixture()
    const site = await temporaryDirectory('connector-hub-site-')
    await mkdir(resolve(site, '.git'))
    await mkdir(resolve(site, 'dsh-connector-hub/plugin'), { recursive: true })
    await writeFile(resolve(site, 'dsh-connector-hub/plugin/keep.txt'), 'keep\n', 'utf8')

    const result = await publishMarketIndex({ ...fixture.options, siteRoot: site })

    const releases = JSON.parse(await readFile(fixture.releases, 'utf8'))
    const versions = Object.entries(releases['dsh-connector-hub'])
      .sort(([, left], [, right]) => right.publishTimestamp - left.publishTimestamp)
      .map(([version]) => version)
    expect(result.plugins).toEqual([{ name: 'dsh-connector-hub', versions }])
    const published = await readFile(resolve(site, 'dsh-connector-hub/plugin/index.json'), 'utf8')
    expect(published).toBe(await readFile(resolve(fixture.options.sourceRoot, 'index.json'), 'utf8'))
    expect(await readFile(resolve(site, 'dsh-connector-hub/plugin/icons/connector-hub.svg'), 'utf8')).toContain('<svg')
    expect(await readFile(resolve(site, 'dsh-connector-hub/plugin/keep.txt'), 'utf8')).toBe('keep\n')
  })

  it('refuses a site path that is not a checkout', async () => {
    const fixture = await makeFixture()
    const site = await temporaryDirectory('connector-hub-site-')
    await expect(publishMarketIndex({ ...fixture.options, siteRoot: site })).rejects.toThrow('Site checkout is missing .git')
  })
})

async function makeFixture() {
  const root = await temporaryDirectory('connector-hub-market-')
  const packageRoot = resolve(root, 'packages/connector-hub')
  await mkdir(packageRoot, { recursive: true })
  await writeFile(resolve(packageRoot, 'package.json'), JSON.stringify({
    name: 'dsh-connector-hub',
    version: '0.2.0',
    engines: { dsh: '>=0.2.1-rc.5 <0.3.0' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }), 'utf8')

  const market = resolve(root, 'market')
  await mkdir(resolve(market, 'icons'), { recursive: true })
  await writeFile(resolve(market, 'icons/connector-hub.svg'), await readFile(resolve(sourceRoot, 'icons/connector-hub.svg'), 'utf8'), 'utf8')
  await writeFile(resolve(market, 'plugins.json'), await readFile(resolve(sourceRoot, 'plugins.json'), 'utf8'), 'utf8')
  const releases = resolve(market, 'releases.json')
  await writeFile(releases, await readFile(resolve(sourceRoot, 'releases.json'), 'utf8'), 'utf8')

  return {
    releases,
    options: { sourceRoot: market, repoRoot: root, snapshotPath: resolve(market, 'index.json') },
  }
}

async function temporaryDirectory(prefix) {
  const path = await mkdtemp(join(tmpdir(), prefix))
  temporaryPaths.push(path)
  return path
}
