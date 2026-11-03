import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { buildCatalog } from '../catalog/scripts/build.mjs'
import { publishCatalog } from '../catalog/scripts/publish.mjs'
import { validateCatalog } from '../catalog/scripts/validate.mjs'

const sourceRoot = fileURLToPath(new URL('../catalog/', import.meta.url))
const snapshotPath = fileURLToPath(new URL('../packages/connector-hub/catalog/index.json', import.meta.url))
const temporaryPaths = []

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('catalog build', () => {
  it('builds a deterministic, valid five-entry package snapshot', async () => {
    const first = await buildCatalog()
    const second = await buildCatalog()
    expect(second.json).toBe(first.json)
    expect(await readFile(snapshotPath, 'utf8')).toBe(first.json)
    expect(validateCatalog(first.catalog)).toEqual([])
    expect(first.catalog.connectors.map(connector => connector.id)).toEqual([
      'notion', 'xmind-cn', 'amap', 'baidu-map', 'tencent-docs',
    ])
    expect(first.json.endsWith('\n')).toBe(true)
  })

  it('does not replace the previous snapshot when a source is invalid', async () => {
    const fixture = await makeFixture()
    const invalidPath = resolve(fixture.source, 'connectors/notion.yaml')
    const invalid = await readFile(invalidPath, 'utf8')
    await writeFile(invalidPath, invalid.replace('official: true', 'official: "yes"'), 'utf8')
    await writeFile(fixture.snapshot, 'previous-valid-snapshot\n', 'utf8')

    await expect(buildCatalog({ sourceRoot: fixture.source, snapshotPath: fixture.snapshot })).rejects.toThrow('Invalid connector catalog')
    expect(await readFile(fixture.snapshot, 'utf8')).toBe('previous-valid-snapshot\n')
  })

  it('rejects a connector file whose id does not match its reference', async () => {
    const fixture = await makeFixture()
    const notionPath = resolve(fixture.source, 'connectors/notion.yaml')
    const notion = await readFile(notionPath, 'utf8')
    await writeFile(notionPath, notion.replace('id: notion', 'id: different-id'), 'utf8')

    await expect(buildCatalog({ sourceRoot: fixture.source, snapshotPath: fixture.snapshot })).rejects.toThrow('must contain matching id')
  })
})

describe('catalog publishing', () => {
  it('writes only the versioned JSON into a site checkout', async () => {
    const fixture = await makeFixture()
    const site = await temporaryDirectory('connector-hub-site-')
    await mkdir(resolve(site, '.git'))

    const result = await publishCatalog({
      siteRoot: site,
      sourceRoot: fixture.source,
      snapshotPath: fixture.snapshot,
    })
    const published = JSON.parse(await readFile(result.outputPath, 'utf8'))
    expect(validateCatalog(published)).toEqual([])
    expect(result.outputPath).toBe(resolve(site, 'dsh-connector-hub/catalog/v1/index.json'))
    expect(result.revision).toBe('2026-11-03.2')
    expect(result.ids).toEqual(['notion', 'xmind-cn', 'amap', 'baidu-map', 'tencent-docs'])
  })

  it('refuses to write when the target is not a site checkout', async () => {
    const fixture = await makeFixture()
    const site = await temporaryDirectory('connector-hub-not-git-')
    await expect(publishCatalog({
      siteRoot: site,
      sourceRoot: fixture.source,
      snapshotPath: fixture.snapshot,
    })).rejects.toThrow('missing .git')
  })
})

async function makeFixture() {
  const root = await temporaryDirectory('connector-hub-catalog-')
  const source = resolve(root, 'catalog')
  await mkdir(resolve(source, 'connectors'), { recursive: true })
  await writeFile(resolve(source, 'index.yaml'), await readFile(resolve(sourceRoot, 'index.yaml'), 'utf8'))
  for (const id of ['notion', 'xmind-cn', 'amap', 'baidu-map', 'tencent-docs']) {
    await writeFile(
      resolve(source, `connectors/${id}.yaml`),
      await readFile(resolve(sourceRoot, `connectors/${id}.yaml`), 'utf8'),
    )
  }
  return { source, snapshot: resolve(root, 'snapshot.json') }
}

async function temporaryDirectory(prefix) {
  const path = await mkdtemp(join(tmpdir(), prefix))
  temporaryPaths.push(path)
  return path
}
