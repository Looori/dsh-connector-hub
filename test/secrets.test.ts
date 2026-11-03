import { describe, expect, it } from 'vitest'
import {
  decodeSecret,
  encodeSecret,
  KEYCHAIN_SERVICE,
  KeychainSecretStore,
  MemorySecretStore,
  SecretFormatError,
} from '../packages/connector-hub/src/host/secrets'
import {
  redactSensitiveText,
  redactUrl,
  safeErrorMessage,
} from '../packages/connector-hub/src/host/redact'

const oauth = {
  v: 1,
  tokens: {
    access_token: 'access-value',
    refresh_token: 'refresh-value',
    expires_at: 1_800_000_000_000,
    scope: 'openid mcp:connect',
  },
  account: { name: 'Test User', workspace: 'Example' },
}
const apiKey = { v: 1, apiKey: 'api-key-value' }

describe('credential codec', () => {
  it('round-trips OAuth and API Key credentials', () => {
    expect(decodeSecret(encodeSecret(oauth))).toEqual(oauth)
    expect(decodeSecret(encodeSecret(apiKey))).toEqual(apiKey)
  })

  it('drops unknown fields when normalizing stored data', () => {
    const decoded = decodeSecret(JSON.stringify({
      ...oauth,
      unexpected: 'discard-me',
      tokens: { ...oauth.tokens, token_type: 'Bearer' },
    }))
    expect(decoded).toEqual(oauth)
  })

  it('rejects malformed JSON, unknown versions and missing fields', () => {
    expect(() => decodeSecret('{broken')).toThrowError(SecretFormatError)
    expect(() => decodeSecret(JSON.stringify({ ...apiKey, v: 2 }))).toThrowError(
      expect.objectContaining({ code: 'unsupported-version' }),
    )
    expect(() => decodeSecret(JSON.stringify({ v: 1, apiKey: '' }))).toThrow('non-empty apiKey')
    expect(() => decodeSecret(JSON.stringify({ v: 1, tokens: { access_token: 'x' } }))).toThrow('expires_at')
  })
})

describe('MemorySecretStore', () => {
  it('supports isolated read, overwrite, delete and missing-entry behavior', async () => {
    const store = new MemorySecretStore()
    expect(await store.read('notion')).toBeNull()
    await store.write('notion', oauth)
    await store.write('amap', apiKey)
    expect(await store.read('notion')).toEqual(oauth)
    expect(await store.read('amap')).toEqual(apiKey)

    await store.write('notion', { ...oauth, tokens: { ...oauth.tokens, access_token: 'replacement' } })
    expect((await store.read('notion')).tokens.access_token).toBe('replacement')
    expect(await store.delete('notion')).toBe(true)
    expect(await store.delete('notion')).toBe(false)
    expect(await store.read('notion')).toBeNull()
    expect(await store.read('amap')).toEqual(apiKey)
  })

  it('rejects invalid connector ids for every operation', async () => {
    const store = new MemorySecretStore()
    await expect(store.read('../notion')).rejects.toThrow('Invalid connector id')
    await expect(store.write('../notion', apiKey)).rejects.toThrow('Invalid connector id')
    await expect(store.delete('../notion')).rejects.toThrow('Invalid connector id')
  })
})

describe('KeychainSecretStore', () => {
  it('uses the fixed service and connector id as account', async () => {
    const entries = new Map()
    const calls = []
    const store = new KeychainSecretStore((service, account) => {
      calls.push({ service, account })
      const key = `${service}/${account}`
      if (!entries.has(key)) {
        entries.set(key, {
          value: null,
          setPassword(password) { this.value = password },
          getPassword() { return this.value },
          deleteCredential() {
            const existed = this.value !== null
            this.value = null
            return existed
          },
        })
      }
      return entries.get(key)
    })

    await store.write('notion', oauth)
    expect(await store.read('notion')).toEqual(oauth)
    expect(await store.delete('notion')).toBe(true)
    expect(await store.read('notion')).toBeNull()
    expect(calls.every(call => call.service === KEYCHAIN_SERVICE && call.account === 'notion')).toBe(true)
  })

  it('maps only NoEntry errors to missing credentials', async () => {
    const missing = new KeychainSecretStore(() => ({
      setPassword() {},
      getPassword() { throw new Error('NoEntry') },
      deleteCredential() { throw new Error('No entry found') },
    }))
    expect(await missing.read('notion')).toBeNull()
    expect(await missing.delete('notion')).toBe(false)

    const locked = new KeychainSecretStore(() => ({
      setPassword() {},
      getPassword() { throw new Error('Keychain is locked') },
      deleteCredential() { throw new Error('Keychain is locked') },
    }))
    await expect(locked.read('notion')).rejects.toThrow('Keychain is locked')
    await expect(locked.delete('notion')).rejects.toThrow('Keychain is locked')
  })
})

describe('sensitive data redaction', () => {
  it('redacts sensitive URL credentials and preserves non-sensitive location data', () => {
    const result = redactUrl('https://user:password@mcp.example.com/mcp?key=secret&org=1&access_token=token&ak=another#token=fragment')
    expect(result).toContain('https://REDACTED:REDACTED@mcp.example.com/mcp?')
    expect(result).toContain('org=1')
    expect(result).toContain('key=REDACTED')
    expect(result).toContain('access_token=REDACTED')
    expect(result).toContain('ak=REDACTED')
    expect(result).not.toContain('password')
    expect(result).not.toContain('secret')
    expect(result).not.toContain('token=token')
    expect(result).not.toContain('fragment')
  })

  it('does not return malformed input that may contain a credential', () => {
    expect(redactUrl('not a URL?key=secret')).toBe('REDACTED_INVALID_URL')
  })

  it('redacts bearer tokens, query parameters and JSON token fields in errors', () => {
    const message = 'fetch https://example.com/mcp?key=query-secret failed: Bearer bearer-secret {"access_token":"json-secret"}'
    const result = safeErrorMessage(new Error(message))
    expect(result).toContain('key=REDACTED')
    expect(result).toContain('Bearer REDACTED')
    expect(result).toContain('"access_token":"REDACTED"')
    expect(result).not.toContain('query-secret')
    expect(result).not.toContain('bearer-secret')
    expect(result).not.toContain('json-secret')
  })

  it('bounds safe error summaries and leaves ordinary errors readable', () => {
    expect(safeErrorMessage(new Error('Connection refused'))).toBe('Connection refused')
    expect(safeErrorMessage('x'.repeat(400), 100)).toHaveLength(101)
    expect(redactSensitiveText('ordinary message')).toBe('ordinary message')
  })
})
