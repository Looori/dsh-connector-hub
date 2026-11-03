import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { OAuthClientMetadataSchema } from '@modelcontextprotocol/core'
import { validateClientMetadataUrl } from '@modelcontextprotocol/client'

const path = new URL('./notion-client.json', import.meta.url)
const document = JSON.parse(await readFile(path, 'utf8'))
validateClientMetadataUrl(document.client_id)
assert.equal(document.client_id, 'https://looori.github.io/dsh-connector-hub/oauth/notion/client.json')
assert.equal(document.token_endpoint_auth_method, 'none')
assert.equal(document.application_type, 'native')
assert.ok(document.client_name)
assert.ok(!('client_secret' in document))
assert.ok(!('registration_access_token' in document))
for (const value of document.redirect_uris) {
  const url = new URL(value)
  assert.equal(url.protocol, 'http:')
  assert.equal(url.hostname, '127.0.0.1')
  assert.equal(url.pathname, '/oauth/callback/notion')
}
OAuthClientMetadataSchema.parse(document)
console.log(JSON.stringify({
  ok: true,
  clientIdMatchesDocumentUrl: true,
  publicClient: true,
  redirectCount: document.redirect_uris.length,
  secretsPresent: false,
}, null, 2))
