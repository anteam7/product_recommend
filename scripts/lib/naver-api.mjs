/**
 * 네이버 커머스 API 공통 — bcrypt 전자서명 토큰 발급(캐시) + 호출 helper.
 * 국내 IP 만 허용 (등록 IP 에서 실행). type=SELF (내스토어 앱).
 *   import { naverApi, getToken, NBASE, CID } from './lib/naver-api.mjs'
 */
import bcrypt from 'bcryptjs'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(readFileSync(path.join(__dirname, '..', '..', '.env.local'), 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }))

export const CID = env.NAVER_COMMERCE_CLIENT_ID
const SECRET = env.NAVER_COMMERCE_CLIENT_SECRET
export const NBASE = 'https://api.commerce.naver.com/external'

let _token = null, _exp = 0
export async function getToken(force = false) {
  if (!force && _token && Date.now() < _exp - 60000) return _token
  if (!CID || !SECRET) throw new Error('NAVER_COMMERCE_CLIENT_ID/SECRET 없음 (.env.local)')
  const ts = Date.now() - 2000 // 시계오차 대비 2초 과거
  const sign = Buffer.from(bcrypt.hashSync(`${CID}_${ts}`, SECRET), 'utf-8').toString('base64')
  const body = new URLSearchParams({ client_id: CID, timestamp: String(ts), client_secret_sign: sign, grant_type: 'client_credentials', type: 'SELF' })
  const r = await fetch(`${NBASE}/v1/oauth2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() })
  const t = await r.text(); let j; try { j = JSON.parse(t) } catch { j = t }
  if (r.status !== 200 || !j?.access_token) throw new Error(`네이버 토큰 실패 HTTP ${r.status}: ${JSON.stringify(j).slice(0, 200)}`)
  _token = j.access_token; _exp = Date.now() + (j.expires_in || 10800) * 1000
  return _token
}

export async function naverApi(method, p, body, _retry = true) {
  const tok = await getToken()
  const r = await fetch(`${NBASE}${p}`, { method, headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  const t = await r.text(); let j; try { j = JSON.parse(t) } catch { j = t }
  if (r.status === 401 && _retry) { await getToken(true); return naverApi(method, p, body, false) }
  return { status: r.status, body: j }
}

// multipart 이미지 업로드용 (Content-Type 자동)
export async function naverUpload(p, formData) {
  const tok = await getToken()
  const r = await fetch(`${NBASE}${p}`, { method: 'POST', headers: { Authorization: `Bearer ${tok}` }, body: formData })
  const t = await r.text(); let j; try { j = JSON.parse(t) } catch { j = t }
  return { status: r.status, body: j }
}
