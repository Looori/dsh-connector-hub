#!/usr/bin/env node
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const SERVICE = 'dsh-connector-hub'
const IDS = new Set(['notion', 'xmind-cn'])

/** Change only the display-independent expiry timestamp; never print or replace tokens. */
export function expireSerializedOAuthSecret(serialized, now = Date.now()) {
  const value = JSON.parse(serialized)
  if (!value || value.v !== 1 || !value.tokens || typeof value.tokens.access_token !== 'string') {
    throw new Error('The keychain entry is not a valid OAuth credential')
  }
  value.tokens.expires_at = now - 1000
  return JSON.stringify(value)
}

async function main() {
  const id = process.argv[2]
  if (!IDS.has(id)) {
    console.error('Usage: node packages/connector-hub/scripts/expire-oauth.mjs <notion|xmind-cn>')
    process.exitCode = 1
    return
  }
  const { Entry } = await import('@napi-rs/keyring')
  const entry = new Entry(SERVICE, id)
  const serialized = entry.getPassword()
  if (serialized === null) throw new Error(`No OAuth credential found for ${id}`)
  entry.setPassword(expireSerializedOAuthSecret(serialized))
  console.log(`${id}: access token marked as expired; refresh token and account were not changed.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main()
}
