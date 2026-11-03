import { appendFileSync } from 'node:fs'

const values = new Map()

/** Process-local keyring replacement. The audit journal never contains passwords. */
export class Entry {
  constructor(service, account) {
    this.service = service
    this.account = account
    this.key = `${service}\0${account}`
  }

  setPassword(password) {
    values.set(this.key, password)
    this.audit('set')
  }

  getPassword() {
    return values.get(this.key) ?? null
  }

  deleteCredential() {
    const deleted = values.delete(this.key)
    this.audit(`delete ${deleted}`)
    return deleted
  }

  audit(operation) {
    const path = process.env.DSH_CONNECTOR_HUB_E2E_KEYCHAIN_JOURNAL
    if (path) appendFileSync(path, `${operation} ${this.service} ${this.account}\n`, 'utf8')
  }
}
