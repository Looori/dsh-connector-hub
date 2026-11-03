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
    .replace(/("(?:access_token|refresh_token|apiKey|api_key|client_secret|password)"\s*:\s*")[^"]*(")/gi, '$1REDACTED$2')
}

export function safeErrorMessage(error: unknown, maxLength = 300): string {
  const raw = error instanceof Error ? error.message : String(error)
  const safe = redactSensitiveText(raw) || 'Unknown error'
  return safe.length > maxLength ? `${safe.slice(0, maxLength)}…` : safe
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '')
}
