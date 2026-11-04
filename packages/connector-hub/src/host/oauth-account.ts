export interface OAuthAccount extends Record<string, unknown> {
  name: string
}

/** Extract display-only account information from an OAuth token response. */
export function extractOAuthAccount(value: unknown): OAuthAccount | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.id_token === 'string') {
    const name = jwtName(value.id_token)
    if (name) return { name }
  }
  const candidates = [
    value.workspace_name,
    isRecord(value.workspace) ? value.workspace.name : undefined,
    isRecord(value.user) ? value.user.name : undefined,
    isRecord(value.owner) && isRecord(value.owner.user) ? value.owner.user.name : undefined,
    value.name,
  ]
  const name = candidates.find(candidate => typeof candidate === 'string' && candidate.trim().length > 0)
  return typeof name === 'string' ? { name } : undefined
}

export function maskAccountName(name: string): string {
  if (!/^\+?\d{7,15}$/.test(name)) return name
  return `${name.slice(0, 3)}****${name.slice(-4)}`
}

function jwtName(token: string): string | undefined {
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return isRecord(payload) && typeof payload.name === 'string' && payload.name.trim() ? payload.name : undefined
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
