import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { validateCatalog } from '../catalog/scripts/validate.mjs'

const index = readYaml('../catalog/index.yaml')
const connectors = index.connectors.map(id => readYaml(`../catalog/connectors/${id}.yaml`))
const catalog = { ...index, connectors }

function readYaml(path) {
  return parse(readFileSync(new URL(path, import.meta.url), 'utf8'))
}

function changedCatalog(change) {
  const value = structuredClone(catalog)
  change(value)
  return value
}

describe('initial connector catalog', () => {
  it('contains exactly the five configured connectors in display order', () => {
    expect(validateCatalog(catalog)).toEqual([])
    expect(catalog.schemaVersion).toBe(1)
    expect(catalog.revision).toBe('2026-11-03.2')
    expect(catalog.connectors.map(connector => connector.id)).toEqual([
      'notion', 'xmind-cn', 'amap', 'baidu-map', 'tencent-docs',
    ])
  })

  it('preserves the M0 OAuth and current API Key configuration', () => {
    const [notion, xmind, amap, baidu, tencentDocs] = catalog.connectors
    expect(notion.auth).toMatchObject({
      type: 'oauth',
      scope: '',
      clientMetadataUrl: 'https://looori.github.io/dsh-connector-hub/oauth/notion/client.json',
      portPolicy: 'random',
    })
    expect(xmind.auth).toMatchObject({
      type: 'oauth',
      scope: 'openid mcp:connect',
      clientId: 'CIul0o4i8rMwnA',
      portPolicy: 'fixed',
      fixedPort: 43118,
    })
    expect(amap.auth).toMatchObject({ type: 'api-key', in: 'query', name: 'key' })
    expect(baidu.auth).toMatchObject({ type: 'api-key', in: 'query', name: 'ak' })
    expect(tencentDocs).toMatchObject({
      remote: { type: 'streamable-http', url: 'https://docs.qq.com/openapi/mcp' },
      auth: { type: 'api-key', in: 'header', name: 'Authorization' },
    })
  })

  it('allows unknown non-sensitive fields for forward compatibility', () => {
    const value = changedCatalog(value => {
      value.connectors[0].futureField = { enabled: true }
    })
    expect(validateCatalog(value)).toEqual([])
  })
})

describe('catalog validation', () => {
  it('rejects duplicate and invalid connector ids', () => {
    const duplicate = changedCatalog(value => {
      value.connectors[1].id = 'notion'
    })
    const invalid = changedCatalog(value => {
      value.connectors[0].id = 'Notion'
    })
    expect(validateCatalog(duplicate).join('\n')).toContain('duplicate connector id')
    expect(validateCatalog(invalid).join('\n')).toContain('pattern')
  })

  it('requires HTTPS remotes except for explicit loopback test fixtures', () => {
    const external = changedCatalog(value => {
      value.connectors[0].remote.url = 'http://example.com/mcp'
    })
    const loopback = changedCatalog(value => {
      value.connectors[0].remote.url = 'http://127.0.0.1:3988/mcp'
    })
    expect(validateCatalog(external).join('\n')).toContain('must use HTTPS')
    expect(validateCatalog(loopback).join('\n')).toContain('must use HTTPS')
    expect(validateCatalog(loopback, { allowLoopbackHttp: true })).toEqual([])
  })

  it('requires exactly one OAuth client identity', () => {
    const both = changedCatalog(value => {
      value.connectors[0].auth.clientId = 'another-public-client'
    })
    const missing = changedCatalog(value => {
      delete value.connectors[0].auth.clientMetadataUrl
    })
    expect(validateCatalog(both).join('\n')).toContain('exactly one shared client identity')
    expect(validateCatalog(missing).length).toBeGreaterThan(0)
  })

  it('enforces fixed and random port policy invariants', () => {
    const missingPort = changedCatalog(value => {
      delete value.connectors[1].auth.fixedPort
    })
    const unexpectedPort = changedCatalog(value => {
      value.connectors[0].auth.fixedPort = 43118
    })
    expect(validateCatalog(missingPort).join('\n')).toContain('required for fixed port policy')
    expect(validateCatalog(unexpectedPort).join('\n')).toContain('not allowed for random port policy')
  })

  it('rejects oversized icons', () => {
    const value = changedCatalog(value => {
      value.connectors[0].icon = `data:image/svg+xml;base64,${'A'.repeat(9000)}`
    })
    expect(validateCatalog(value).join('\n')).toContain('must not exceed 8 KiB')
  })

  it('rejects secret fields without echoing their values', () => {
    const value = changedCatalog(value => {
      value.connectors[0].auth.client_secret = 'do-not-leak-this-value'
    })
    const errors = validateCatalog(value).join('\n')
    expect(errors).toContain('secret fields are not allowed')
    expect(errors).not.toContain('do-not-leak-this-value')
  })

  it('rejects unsupported authentication types and malformed revisions', () => {
    const auth = changedCatalog(value => {
      value.connectors[0].auth = { type: 'future-auth' }
    })
    const revision = changedCatalog(value => {
      value.revision = 'latest'
    })
    expect(validateCatalog(auth).length).toBeGreaterThan(0)
    expect(validateCatalog(revision).join('\n')).toContain('pattern')
  })
})
