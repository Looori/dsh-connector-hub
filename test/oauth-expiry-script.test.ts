import { describe, expect, it } from 'vitest'
import { expireSerializedOAuthSecret } from '../packages/connector-hub/scripts/expire-oauth.mjs'

describe('OAuth expiry acceptance helper', () => {
  it('changes only expires_at and preserves credentials and account', () => {
    const original = {
      v: 1,
      tokens: {
        access_token: 'access-secret', refresh_token: 'refresh-secret',
        expires_at: 1000, scope: 'openid',
      },
      account: { name: 'Workspace' },
    }
    const result = JSON.parse(expireSerializedOAuthSecret(JSON.stringify(original), 50_000))
    expect(result).toEqual({
      ...original,
      tokens: { ...original.tokens, expires_at: 49_000 },
    })
    expect(JSON.stringify(result)).not.toContain('50000')
  })

  it('rejects API Key and malformed entries without rewriting them', () => {
    expect(() => expireSerializedOAuthSecret('{"v":1,"apiKey":"secret"}')).toThrow('not a valid OAuth credential')
    expect(() => expireSerializedOAuthSecret('not-json')).toThrow()
  })
})
