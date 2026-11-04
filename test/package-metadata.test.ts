import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const packageUrl = new URL('../packages/connector-hub/package.json', import.meta.url)
const pkg = JSON.parse(readFileSync(packageUrl, 'utf8'))

describe('connector hub package metadata', () => {
  it('exposes the Host and browser entry points required by DSH', () => {
    expect(pkg.name).toBe('dsh-connector-hub')
    expect(pkg.version).toBe('0.1.0')
    expect(pkg.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/Looori/dsh-connector-hub.git',
      directory: 'packages/connector-hub',
    })
    expect(pkg.exports).toEqual({
      '.': './lib/index.js',
      './client': './lib/client.js',
      './package.json': './package.json',
    })
    expect(pkg.dsh.bundle.patch).toBe('./cordis.patch.yml')
    expect(pkg.dsh.client.platform).toBe('web')
  })

  it('targets the verified rc.5 compatibility range', () => {
    expect(pkg.engines.dsh).toBe('>=0.2.1-rc.5 <0.3.0')
    expect(pkg.devDependencies['@deepseek-ai/dsh']).toBe('0.2.1-rc.5')
    expect(pkg.devDependencies['@deepseek-ai/cordis']).toBe('4.0.5')
  })

  it('keeps DSH runtime modules as optional peers', () => {
    for (const name of ['@deepseek-ai/dsh-home-paths', '@deepseek-ai/dsh-mcp-client']) {
      expect(pkg.peerDependencies[name]).toBe('>=0.2.1-rc.5 <0.3.0')
      expect(pkg.peerDependenciesMeta[name].optional).toBe(true)
    }
    expect(pkg.dependencies['@modelcontextprotocol/client']).toBe('2.2.0')
  })
})
