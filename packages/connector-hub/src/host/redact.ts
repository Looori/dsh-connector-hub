const SENSITIVE_QUERY_KEYS = new Set([
  'key', 'ak', 'token', 'accesstoken', 'refreshtoken', 'apikey', 'secret', 'clientsecret', 'code',
])

/** Redact credentials while preserving a useful, non-sensitive upstream location. */
export function redactUrl(input: string | URL): string {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return 'REDACTED_INVALID_URL'
  }

  if (url.username) url.username = 'REDACTED'
  if (url.password) url.password = 'REDACTED'
  for (const key of [...new Set(url.searchParams.keys())]) {
    if (SENSITIVE_QUERY_KEYS.has(normalizeKey(key))) url.searchParams.set(key, 'REDACTED')
  }
  url.hash = ''
  return url.toString()
}

/** Remove common credential shapes from errors before they reach logs or status responses. */
export function redactSensitiveText(input: string): string {
  return input
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer REDACTED')
    .replace(/([?&](?:key|ak|token|access_token|refresh_token|api_key|apikey|secret|client_secret|code)=)[^\s&#]+/gi, '$1REDACTED')
    .replace(/("(?:access_token|refresh_token|token|apiKey|api_key|client_secret|password)"\s*:\s*")[^"]*(")/gi, '$1REDACTED$2')
    .replace(/\bmcp_token=[^\s,&;"]+/gi, 'mcp_token=REDACTED')
    .replace(/(\btoken\s*:\s*)[A-Za-z0-9._~+/=-]+/gi, '$1REDACTED')
}

export function safeErrorMessage(error: unknown, maxLength = 300): string {
  const raw = errorWithCause(error)
  const safe = redactSensitiveText(raw) || 'Unknown error'
  return safe.length > maxLength ? `${safe.slice(0, maxLength)}…` : safe
}

function errorWithCause(error: unknown, depth = 0): string {
  let message = error instanceof Error ? error.message : String(error)
  if (error && typeof error === 'object') {
    const hasStatusText = 'statusText' in error && typeof error.statusText === 'string'
    const status = hasStatusText && 'status' in error && typeof error.status === 'number' ? error.status : undefined
    const statusText = hasStatusText ? error.statusText : ''
    if (status !== undefined && !message.includes(`HTTP ${status}`)) {
      message = `${message} (HTTP ${status}${statusText ? ` ${statusText}` : ''})`
    }
  }
  if (depth >= 3 || !(error instanceof Error) || error.cause === undefined) return message
  const cause = errorWithCause(error.cause, depth + 1)
  return cause && cause !== message ? `${message}: ${cause}` : message
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '')
}
