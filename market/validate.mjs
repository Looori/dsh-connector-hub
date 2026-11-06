const MAX_INLINE_ICON_BYTES = 32 * 1024
const MAX_PUBLISH_TIMESTAMP = 100_000_000_000
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/
const INLINE_ICON = /^data:(image\/(?:svg\+xml|png|jpeg|webp));base64,(.+)$/
const HEX_COMMIT = /^[0-9a-f]{40}$/

/**
 * Validate a plugin-market index (format 1) against the rules this repository publishes.
 * The shape follows DSH 0.2.1-rc.5; see docs/decisions.md for why the check is local.
 */
export function validateMarketIndex(index, options = {}) {
  const errors = []
  if (!isRecord(index)) return ['index: must be an object']
  if (index.format !== 1) errors.push('index.format: must be 1')
  localized(index.title, 'index.title', errors, { required: true })
  if (index.description !== undefined) localized(index.description, 'index.description', errors)

  const declarations = metadataDeclarations(index.metadata, errors)
  if (!Array.isArray(index.plugins)) {
    errors.push('index.plugins: must be an array')
    return unique(errors)
  }
  if (index.plugins.length === 0) errors.push('index.plugins: must not be empty')

  const names = new Set()
  index.plugins.forEach((plugin, position) => {
    const path = `index.plugins[${position}]`
    if (!isRecord(plugin)) {
      errors.push(`${path}: must be an object`)
      return
    }
    pluginErrors(plugin, path, errors, declarations, options)
    if (typeof plugin.name === 'string') {
      if (names.has(plugin.name)) errors.push(`${path}.name: duplicate plugin name`)
      names.add(plugin.name)
    }
  })
  return unique(errors)
}

/** Throw with every problem found, so a bad index never replaces the previous snapshot. */
export function assertValidMarketIndex(index, options = {}) {
  const errors = validateMarketIndex(index, options)
  if (errors.length > 0) throw new Error(`Invalid plugin-market index:\n${errors.join('\n')}`)
}

function pluginErrors(plugin, path, errors, declarations, options) {
  if (typeof plugin.name !== 'string' || !PACKAGE_NAME.test(plugin.name)) {
    errors.push(`${path}.name: must be an npm package name`)
  }
  if (plugin.title !== undefined) localized(plugin.title, `${path}.title`, errors)
  if (plugin.description !== undefined) localized(plugin.description, `${path}.description`, errors)
  if (plugin.author !== undefined && (typeof plugin.author !== 'string' || plugin.author.trim() === '')) {
    errors.push(`${path}.author: must be a non-empty string`)
  }
  if (plugin.homepage !== undefined) httpUrl(plugin.homepage, `${path}.homepage`, errors)
  repositoryErrors(plugin.repository, `${path}.repository`, errors)
  iconErrors(plugin.icon, `${path}.icon`, errors, options)

  const metadata = plugin.metadata
  if (metadata !== undefined) {
    if (!isRecord(metadata)) {
      errors.push(`${path}.metadata: must be an object`)
    } else {
      if (metadata.category !== undefined && !declarations.categories.has(metadata.category)) {
        errors.push(`${path}.metadata.category: must reference a declared category`)
      }
      if (metadata.labels !== undefined) {
        if (!Array.isArray(metadata.labels)) {
          errors.push(`${path}.metadata.labels: must be an array`)
        } else {
          const seen = new Set()
          metadata.labels.forEach(label => {
            if (!declarations.labels.has(label)) errors.push(`${path}.metadata.labels: unknown label ${JSON.stringify(label)}`)
            if (seen.has(label)) errors.push(`${path}.metadata.labels: duplicate label ${JSON.stringify(label)}`)
            seen.add(label)
          })
        }
      }
      if (metadata.keywords !== undefined && (!Array.isArray(metadata.keywords) || metadata.keywords.some(word => typeof word !== 'string'))) {
        errors.push(`${path}.metadata.keywords: must be an array of strings`)
      }
      if (metadata.sortKeys !== undefined) {
        if (!isRecord(metadata.sortKeys)) {
          errors.push(`${path}.metadata.sortKeys: must be an object`)
        } else {
          for (const [key, value] of Object.entries(metadata.sortKeys)) {
            if (!declarations.sortKeys.has(key)) errors.push(`${path}.metadata.sortKeys: unknown sort key ${JSON.stringify(key)}`)
            if (typeof value !== 'number' || !Number.isFinite(value)) errors.push(`${path}.metadata.sortKeys.${key}: must be a finite number`)
          }
        }
      }
    }
  }

  if (!Array.isArray(plugin.versions) || plugin.versions.length === 0) {
    errors.push(`${path}.versions: must be a non-empty array`)
    return
  }
  const versions = new Set()
  plugin.versions.forEach((version, position) => {
    const at = `${path}.versions[${position}]`
    if (!isRecord(version)) {
      errors.push(`${at}: must be an object`)
      return
    }
    if (typeof version.version !== 'string' || !SEMVER.test(version.version)) {
      errors.push(`${at}.version: must be an exact semantic version`)
    } else {
      if (versions.has(version.version)) errors.push(`${at}.version: duplicate version`)
      versions.add(version.version)
    }
    if (!Number.isInteger(version.publishTimestamp) || version.publishTimestamp < 0 || version.publishTimestamp >= MAX_PUBLISH_TIMESTAMP) {
      errors.push(`${at}.publishTimestamp: must be an integer number of Unix seconds in [0, 10^11)`)
    }
    sourceErrors(version.source, `${at}.source`, errors)
    if (!isRecord(version.engines) || typeof version.engines.dsh !== 'string' || version.engines.dsh.trim() === '') {
      errors.push(`${at}.engines.dsh: must be a non-empty SemVer range`)
    }
  })
}

function metadataDeclarations(metadata, errors) {
  const declarations = { categories: new Set(), labels: new Set(), sortKeys: new Set() }
  if (metadata === undefined) return declarations
  if (!isRecord(metadata)) {
    errors.push('index.metadata: must be an object')
    return declarations
  }
  declareMap(metadata.categories, 'index.metadata.categories', declarations.categories, errors)
  declareMap(metadata.labels, 'index.metadata.labels', declarations.labels, errors)
  if (metadata.sortKeys !== undefined) {
    if (!isRecord(metadata.sortKeys)) {
      errors.push('index.metadata.sortKeys: must be an object')
    } else {
      for (const [id, declaration] of Object.entries(metadata.sortKeys)) {
        if (!isRecord(declaration)) {
          errors.push(`index.metadata.sortKeys.${id}: must be an object`)
          continue
        }
        localized(declaration.title, `index.metadata.sortKeys.${id}.title`, errors, { required: true })
        if (declaration.order !== 'asc' && declaration.order !== 'desc') {
          errors.push(`index.metadata.sortKeys.${id}.order: must be "asc" or "desc"`)
        }
        declarations.sortKeys.add(id)
      }
    }
  }
  return declarations
}

function declareMap(map, path, ids, errors) {
  if (map === undefined) return
  if (!isRecord(map)) {
    errors.push(`${path}: must be an object`)
    return
  }
  for (const [id, declaration] of Object.entries(map)) {
    if (id.trim() === '') errors.push(`${path}: ids must not be empty`)
    if (!isRecord(declaration)) {
      errors.push(`${path}.${id}: must be an object`)
      continue
    }
    localized(declaration.title, `${path}.${id}.title`, errors, { required: true })
    ids.add(id)
  }
}

function localized(value, path, errors, options = {}) {
  if (value === undefined) {
    if (options.required) errors.push(`${path}: is required`)
    return
  }
  if (typeof value === 'string') {
    if (value.trim() === '') errors.push(`${path}: must not be blank`)
    return
  }
  if (!isRecord(value)) {
    errors.push(`${path}: must be a string or a localized object`)
    return
  }
  if (typeof value.en !== 'string' || value.en.trim() === '') errors.push(`${path}.en: is required`)
  for (const [language, text] of Object.entries(value)) {
    if (!/^[a-z]{2,8}(-[a-z0-9]{1,8})*$/.test(language)) errors.push(`${path}: invalid language id ${JSON.stringify(language)}`)
    if (typeof text !== 'string' || text.trim() === '') errors.push(`${path}.${language}: must be a non-blank string`)
  }
}

function repositoryErrors(repository, path, errors) {
  if (repository === undefined) return
  if (!isRecord(repository)) {
    errors.push(`${path}: must be an object`)
    return
  }
  httpUrl(repository.url, `${path}.url`, errors, { allowFragment: false })
  if (repository.directory !== undefined && (typeof repository.directory !== 'string' || !relativePath(repository.directory))) {
    errors.push(`${path}.directory: must be a relative directory inside the repository`)
  }
}

function iconErrors(icon, path, errors, options) {
  if (icon === undefined) return
  if (typeof icon !== 'string' || icon.trim() === '') {
    errors.push(`${path}: must be a non-empty string`)
    return
  }
  const inline = INLINE_ICON.exec(icon)
  if (inline) {
    const bytes = Buffer.from(inline[2], 'base64')
    if (bytes.byteLength > MAX_INLINE_ICON_BYTES) errors.push(`${path}: inline icon must not exceed 32 KiB of decoded bytes`)
    return
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(icon)) {
    httpUrl(icon, path, errors)
    return
  }
  if (!relativePath(icon)) {
    errors.push(`${path}: must be a data: URL, an http(s) URL, or a relative path without ".."`)
    return
  }
  if (options.iconDirectory) {
    options.iconDirectory(icon, error => errors.push(`${path}: ${error}`))
  }
}

function sourceErrors(source, path, errors) {
  if (!isRecord(source)) {
    errors.push(`${path}: must be an object`)
    return
  }
  if (source.type === 'npm') {
    if (source.registry !== undefined) httpUrl(source.registry, `${path}.registry`, errors, { allowFragment: false })
    return
  }
  if (source.type === 'git') {
    if (typeof source.url !== 'string' || !/^https:\/\//.test(source.url) || source.url.includes('@')) {
      errors.push(`${path}.url: must be a canonical https URL without credentials`)
    }
    if (typeof source.commit !== 'string' || !HEX_COMMIT.test(source.commit)) errors.push(`${path}.commit: must be a 40-character lowercase commit SHA`)
    if (source.path !== undefined && (typeof source.path !== 'string' || !relativePath(source.path))) {
      errors.push(`${path}.path: must be a relative directory`)
    }
    return
  }
  errors.push(`${path}.type: must be "npm" or "git"`)
}

function httpUrl(value, path, errors, options = {}) {
  if (typeof value !== 'string') {
    errors.push(`${path}: must be an absolute http(s) URL`)
    return
  }
  let url
  try {
    url = new URL(value)
  } catch {
    errors.push(`${path}: must be an absolute http(s) URL`)
    return
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') errors.push(`${path}: must use http: or https:`)
  if (url.username !== '' || url.password !== '') errors.push(`${path}: must not contain credentials`)
  if (url.hash !== '' && options.allowFragment === false) errors.push(`${path}: must not contain a fragment`)
}

function relativePath(value) {
  if (value.startsWith('/') || value.includes('\\')) return false
  return value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unique(values) {
  return [...new Set(values)]
}
