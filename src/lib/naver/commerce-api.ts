/**
 * 네이버 커머스 API 서버측 헬퍼 — scripts/lib/naver-api.mjs 의 TS 미러.
 * bcrypt 전자서명 토큰 발급(모듈 캐시) + 호출 helper. 국내 허용 IP에서만 동작 (GW.IP_NOT_ALLOWED 주의).
 * 서버 전용(Next.js API Route) — 클라이언트 import 금지.
 */
import bcrypt from 'bcryptjs'

const NBASE = 'https://api.commerce.naver.com/external'

let _token: string | null = null
let _exp = 0

async function getToken(force = false): Promise<string> {
  if (!force && _token && Date.now() < _exp - 60000) return _token
  const cid = process.env.NAVER_COMMERCE_CLIENT_ID
  const secret = process.env.NAVER_COMMERCE_CLIENT_SECRET
  if (!cid || !secret) throw new Error('NAVER_COMMERCE_CLIENT_ID/SECRET 없음')
  const ts = Date.now() - 2000 // 시계오차 대비 2초 과거
  const sign = Buffer.from(bcrypt.hashSync(`${cid}_${ts}`, secret), 'utf-8').toString('base64')
  const body = new URLSearchParams({
    client_id: cid,
    timestamp: String(ts),
    client_secret_sign: sign,
    grant_type: 'client_credentials',
    type: 'SELF',
  })
  const r = await fetch(`${NBASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  const t = await r.text()
  let j: { access_token?: string; expires_in?: number }
  try { j = JSON.parse(t) } catch { j = {} }
  if (r.status !== 200 || !j.access_token) {
    throw new Error(`네이버 토큰 실패 HTTP ${r.status}: ${t.slice(0, 200)}`)
  }
  _token = j.access_token
  _exp = Date.now() + (j.expires_in ?? 10800) * 1000
  return _token
}

export async function naverApi(
  method: string,
  path: string,
  body?: unknown,
  _retry = true,
): Promise<{ status: number; body: unknown }> {
  const tok = await getToken()
  const r = await fetch(`${NBASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const t = await r.text()
  let j: unknown
  try { j = JSON.parse(t) } catch { j = t }
  if (r.status === 401 && _retry) {
    await getToken(true)
    return naverApi(method, path, body, false)
  }
  return { status: r.status, body: j }
}
