import type { Catalog, CatalogUpdate } from '../shared/catalog'
import type { ConnectorConfig } from '../shared/config'

export function catalogUpdates(config: ConnectorConfig, catalog: Catalog): CatalogUpdate[] {
  const updates: CatalogUpdate[] = []
  const catalogIds = new Set(catalog.connectors.map(item => item.id))
  for (const item of catalog.connectors) {
    const stored = config.connectors[item.id]
    if (!stored) continue
    const fields: string[] = []
    compareValues(stored.remote, item.remote, 'remote', fields)
    compareValues(stored.auth, item.auth, 'auth', fields)
    if (fields.length > 0) updates.push({ id: item.id, kind: 'changed', fields: fields.sort() })
  }
  for (const id of Object.keys(config.connectors)) {
    if (!catalogIds.has(id)) updates.push({ id, kind: 'removed', fields: [] })
  }
  return updates
}

function compareValues(left: unknown, right: unknown, path: string, fields: string[]): void {
  if (left === undefined || right === undefined) {
    if (left !== right) fields.push(path)
    return
  }
  if (isRecord(left) && isRecord(right)) {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)])
    for (const key of keys) compareValues(left[key], right[key], `${path}.${key}`, fields)
    return
  }
  if (JSON.stringify(left) !== JSON.stringify(right)) fields.push(path)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
