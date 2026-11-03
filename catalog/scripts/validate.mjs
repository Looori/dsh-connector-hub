import { readFileSync } from 'node:fs'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'

const connectorSchema = readSchema('connector.schema.json')
const indexSchema = readSchema('index.schema.json')
const ajv = new Ajv({ allErrors: true, strict: true })
addFormats(ajv)
ajv.addSchema(connectorSchema)
ajv.addSchema(indexSchema)
const validateConnectorSchema = ajv.getSchema(connectorSchema.$id)
const validateIndexSchema = ajv.getSchema(indexSchema.$id)

const FORBIDDEN_KEYS = new Set([
  'token',
  'accesstoken',
  'refreshtoken',
  'apikey',
  'secret',
  'clientsecret',
  'password',
  'registrationaccesstoken',
])

/** Validate a single catalog entry without exposing its values in errors. */
export function validateConnector(connector, options = {}) {
  const errors = collectSchemaErrors(validateConnectorSchema, connector, 'connector')
  if (isRecord(connector)) errors.push(...connectorRuleErrors(connector, 'connector', options))
  return unique(errors)
}

/** Validate the merged index, including cross-entry uniqueness. */
export function validateCatalog(catalog, options = {}) {
  const errors = collectSchemaErrors(validateIndexSchema, catalog, 'catalog')
  if (!isRecord(catalog) || !Array.isArray(catalog.connectors)) return unique(errors)

  const ids = new Set()
  catalog.connectors.forEach((connector, index) => {
    const path = `catalog.connectors[${index}]`
    if (!isRecord(connector)) return
    errors.push(...connectorRuleErrors(connector, path, options))
    if (typeof connector.id === 'string') {
      if (ids.has(connector.id)) errors.push(`${path}.id: duplicate connector id`)
      ids.add(connector.id)
    }
  })
  return unique(errors)
}

export function assertValidCatalog(catalog, options = {}) {
  const errors = validateCatalog(catalog, options)
  if (errors.length > 0) throw new Error(`Invalid connector catalog:\n${errors.join('\n')}`)
}

function readSchema(name) {
  return JSON.parse(readFileSync(new URL(`../schema/${name}`, import.meta.url), 'utf8'))
}

function collectSchemaErrors(validate, value, path) {
  if (validate(value)) return []
  return (validate.errors ?? []).map(error => `${path}${error.instancePath}: ${error.message}`)
}

function connectorRuleErrors(connector, path, options) {
  const errors = []
  errors.push(...forbiddenKeyErrors(connector, path))

  if (typeof connector.icon === 'string' && Buffer.byteLength(connector.icon, 'utf8') > 8192) {
    errors.push(`${path}.icon: SVG data URI must not exceed 8 KiB`)
  }

  if (isRecord(connector.remote) && typeof connector.remote.url === 'string') {
    validateRemoteUrl(connector.remote.url, `${path}.remote.url`, options, errors)
  }

  if (isRecord(connector.auth) && connector.auth.type === 'oauth') {
    const auth = connector.auth
    const identities = ['clientId', 'clientMetadataUrl'].filter(key => typeof auth[key] === 'string')
    if (identities.length !== 1) {
      errors.push(`${path}.auth: exactly one shared client identity is required`)
    }
    if (typeof auth.clientMetadataUrl === 'string') {
      validateHttpsUrl(auth.clientMetadataUrl, `${path}.auth.clientMetadataUrl`, errors)
    }
    if (auth.portPolicy === 'fixed' && !Number.isInteger(auth.fixedPort)) {
      errors.push(`${path}.auth.fixedPort: required for fixed port policy`)
    }
    if (auth.portPolicy === 'random' && Object.hasOwn(auth, 'fixedPort')) {
      errors.push(`${path}.auth.fixedPort: not allowed for random port policy`)
    }
  }
  return errors
}

function validateRemoteUrl(value, path, options, errors) {
  let url
  try {
    url = new URL(value)
  } catch {
    errors.push(`${path}: invalid URL`)
    return
  }
  if (url.protocol === 'https:') return
  if (options.allowLoopbackHttp === true && url.protocol === 'http:' && isLoopback(url.hostname)) return
  errors.push(`${path}: remote URL must use HTTPS`)
}

function validateHttpsUrl(value, path, errors) {
  try {
    if (new URL(value).protocol !== 'https:') errors.push(`${path}: must use HTTPS`)
  } catch {
    errors.push(`${path}: invalid URL`)
  }
}

function isLoopback(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
}

function forbiddenKeyErrors(value, path) {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => forbiddenKeyErrors(item, `${path}[${index}]`))
  }
  if (!isRecord(value)) return []

  const errors = []
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[_-]/g, '')
    const childPath = `${path}.${key}`
    if (FORBIDDEN_KEYS.has(normalized)) errors.push(`${childPath}: secret fields are not allowed in the catalog`)
    errors.push(...forbiddenKeyErrors(child, childPath))
  }
  return errors
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function unique(errors) {
  return [...new Set(errors)]
}
