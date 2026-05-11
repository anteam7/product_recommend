/**
 * SSRF-resistant fetch.
 *
 * 사용자 제공 URL 을 서버에서 fetch 하기 전에:
 *  1. 스킴 검증 (http/https 만)
 *  2. 호스트 allowlist (suffix match)
 *  3. 사설/링크-로컬 IP 차단 (127.x, 10.x, 192.168.x, 169.254.x, 172.16-31.x, 0.x)
 *  4. metadata.google.internal 같은 알려진 위험 호스트 차단
 *  5. 응답 크기 + timeout 제한
 *  6. Redirect 매 hop 재검증 (manual follow)
 *
 * 사용처: 어필리에이트 URL 메타 추출 (Amazon/Rakuten/Yahoo 등).
 * 메모리: affiliate_integration_plan.md (S3).
 */

const PRIVATE_IP_PATTERNS: RegExp[] = [
  /^127\./, // loopback
  /^10\./, // private class A
  /^192\.168\./, // private class C
  /^169\.254\./, // link-local (AWS metadata)
  /^172\.(1[6-9]|2\d|3[01])\./, // private class B
  /^0\./, // null route
  /^::1$/, // IPv6 loopback
  /^fe80:/i, // IPv6 link-local
  /^fc00:/i, // IPv6 unique local
]

const BLOCKED_HOSTS = new Set([
  'localhost',
  '0.0.0.0',
  'metadata.google.internal',
  'metadata.aws.internal',
  'instance-data',
])

export interface SafeFetchOptions {
  /** 허용된 호스트 suffix 목록. 예: ['amazon.com', 'rakuten.co.jp'] */
  allowedHosts: string[]
  /** 추적할 redirect 최대 hop. default 3 */
  maxRedirects?: number
  /** Fetch timeout (ms). default 5000 */
  timeoutMs?: number
  /** 응답 본문 최대 크기 (bytes). default 10MB */
  maxBodyBytes?: number
  /** Fetch options pass-through (headers 등). redirect 는 무시 (manual 강제). */
  init?: Omit<RequestInit, 'redirect' | 'signal'>
}

export class SafeFetchError extends Error {
  constructor(
    public reason:
      | 'invalid_url'
      | 'disallowed_scheme'
      | 'host_not_allowed'
      | 'private_address'
      | 'too_many_redirects'
      | 'body_too_large'
      | 'timeout',
    public details?: Record<string, unknown>,
  ) {
    super(`safeFetchUrl: ${reason}`)
    this.name = 'SafeFetchError'
  }
}

function isPrivateAddress(host: string): boolean {
  const lower = host.toLowerCase()
  if (BLOCKED_HOSTS.has(lower)) return true
  return PRIVATE_IP_PATTERNS.some((re) => re.test(lower))
}

function hostMatchesAllowlist(host: string, allowed: string[]): boolean {
  const lower = host.toLowerCase()
  return allowed.some((a) => {
    const norm = a.toLowerCase().replace(/^\./, '')
    return lower === norm || lower.endsWith('.' + norm)
  })
}

function validateUrl(url: string, allowed: string[]): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new SafeFetchError('invalid_url', { url })
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SafeFetchError('disallowed_scheme', { scheme: parsed.protocol })
  }
  const host = parsed.hostname
  if (isPrivateAddress(host)) {
    throw new SafeFetchError('private_address', { host })
  }
  if (!hostMatchesAllowlist(host, allowed)) {
    throw new SafeFetchError('host_not_allowed', { host })
  }
  return parsed
}

/**
 * Body size limit 체크하면서 응답 읽기.
 */
async function readBodyWithLimit(res: Response, maxBytes: number): Promise<Response> {
  const contentLength = res.headers.get('content-length')
  if (contentLength && parseInt(contentLength, 10) > maxBytes) {
    throw new SafeFetchError('body_too_large', { size: contentLength, max: maxBytes })
  }

  const reader = res.body?.getReader()
  if (!reader) return res

  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      total += value.length
      if (total > maxBytes) {
        await reader.cancel()
        throw new SafeFetchError('body_too_large', { size: total, max: maxBytes })
      }
      chunks.push(value)
    }
  }

  // re-construct response with new body
  const merged = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    merged.set(c, offset)
    offset += c.length
  }
  return new Response(merged, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  })
}

export async function safeFetchUrl(url: string, opts: SafeFetchOptions): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? 3
  const timeoutMs = opts.timeoutMs ?? 5000
  const maxBodyBytes = opts.maxBodyBytes ?? 10 * 1024 * 1024

  let currentUrl = url
  for (let hop = 0; hop <= maxRedirects; hop++) {
    validateUrl(currentUrl, opts.allowedHosts)

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    let res: Response
    try {
      res = await fetch(currentUrl, {
        ...opts.init,
        redirect: 'manual',
        signal: ctrl.signal,
      })
    } catch (e) {
      clearTimeout(timer)
      if ((e as Error).name === 'AbortError') {
        throw new SafeFetchError('timeout', { url: currentUrl, timeoutMs })
      }
      throw e
    }
    clearTimeout(timer)

    // redirect?
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location')
      if (loc) {
        currentUrl = new URL(loc, currentUrl).toString()
        continue
      }
    }

    return readBodyWithLimit(res, maxBodyBytes)
  }
  throw new SafeFetchError('too_many_redirects', { url, max: maxRedirects })
}
