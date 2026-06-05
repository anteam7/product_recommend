/**
 * ggsan 상세설명(contents) 보정 — prep이 /data/editor/goods/ 의 "진짜 긴 상세설명"을 놓치고
 * /goods/{no}/image/detail/ 의 짧은 제품사진 2장만 contents에 넣은 상품(thin)을 교정한다.
 *
 *   원인: extractDetail 이 godomall-storage 호스트 + /goods/{no}/ 경로만 수집 →
 *         별도 CDN(cdn-saas-web-*.cdn-nhncommerce.com)의 /data/editor/ 상세 이미지를 통째로 누락.
 *   쿠팡은 editor 원본 URL을 그대로 IMAGE_NO_SPACE content로 받아 호스팅한다(슬라이스 불필요).
 *
 * 흐름: ggsan 로그인 → goods_view 재스크랩 → editor 상세 URL 추출 →
 *       쿠팡 GET → (이미 editor면 skip) → contents 교체 → PUT → 8s → 승인요청.
 *
 *   node scripts/coupang-fix-detail-contents.mjs --spids=A,B            # 특정 (dry)
 *   node scripts/coupang-fix-detail-contents.mjs --spids=A,B --apply
 *   node scripts/coupang-fix-detail-contents.mjs --all                  # 전체 thin (dry)
 *   node scripts/coupang-fix-detail-contents.mjs --all --apply
 */
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }))
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const { COUPANG_ACCESS_KEY: AK, COUPANG_SECRET_KEY: SK, COUPANG_API_HOST: HOST } = env
const BASE = env.GGSAN_BASE_URL || 'https://www.ggsan.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const APPLY = process.argv.includes('--apply')
const ALL = process.argv.includes('--all')
const SPIDS = (process.argv.find((a) => a.startsWith('--spids='))?.split('=')[1] || '').split(',').map((s) => s.trim()).filter(Boolean)
const sleep = (ms) => new Promise((s) => setTimeout(s, ms))

// ── ggsan 로그인 (prep과 동일) ──
const cookies = new Map()
function setCookies(h) { if (!h) return; for (const part of h.split(/,(?=[^;]+=)/)) { const [kv] = part.split(';'); const [k, v] = kv.trim().split('='); if (k && v !== undefined) cookies.set(k, v) } }
const cookieHeader = () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; ')
async function ggsanFetch(url, init = {}) { const res = await fetch(url, { redirect: 'manual', ...init, headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9', Cookie: cookieHeader(), ...(init.headers || {}) } }); setCookies(res.headers.get('set-cookie')); return res }
async function ggsanLogin() {
  await ggsanFetch(`${BASE}/member/login.php`)
  const r = await ggsanFetch(`${BASE}/member/login_ps.php`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: `${BASE}/member/login.php` }, body: new URLSearchParams({ loginId: env.GGSAN_USER, loginPwd: env.GGSAN_PASS, saveId: 'y', returnUrl: `${BASE}/main/index.php` }).toString() })
  if (!/parent\.location\.href='https:\/\/www\.ggsan\.com\/main\/index\.php'/.test(await r.text())) throw new Error('ggsan login failed')
}

// 진짜 상세설명 = /data/editor/goods/ 의 이미지 (등장 순서 보존, 호스트 무관)
function editorImages(html) {
  const seen = new Set()
  return [...html.matchAll(/https?:\/\/[^\s"'\\)<>]+\.(?:jpe?g|png|gif|webp)/gi)]
    .map((m) => m[0].replace(/[\\)>"']+$/, ''))
    .filter((u) => /\/editor\/goods\//i.test(u) && !seen.has(u) && seen.add(u))
}
const contentUrls = (items) => { const out = []; for (const it of (items || [])) for (const c of (it.contents || [])) for (const cd of (c.contentDetails || [])) if (cd.content) out.push(cd.content); return out }

function sign(m, p) { const dt = new Date().toISOString().substring(2, 19).replace(/[-:]/g, '') + 'Z'; return { dt, sig: crypto.createHmac('sha256', SK).update(dt + m + p).digest('hex') } }
async function api(m, p, b) { const { dt, sig } = sign(m, p); const r = await fetch(`${HOST}${p}`, { method: m, headers: { Authorization: `CEA algorithm=HmacSHA256, access-key=${AK}, signed-date=${dt}, signature=${sig}`, 'Content-Type': 'application/json;charset=UTF-8' }, body: b ? JSON.stringify(b) : undefined }); const t = await r.text(); try { return { s: r.status, b: JSON.parse(t) } } catch { return { s: r.status, b: t } } }

// ── 대상 선정 ──
let targets
if (SPIDS.length) {
  const { data } = await sb.from('jimscanner_coupang_listings').select('id,seller_product_id,source_goods_no,status,request_payload').in('seller_product_id', SPIDS)
  targets = data || []
} else if (ALL) {
  const { data } = await sb.from('jimscanner_coupang_listings').select('id,seller_product_id,source_goods_no,status,request_payload').eq('source', 'ggsan').not('seller_product_id', 'is', null)
  targets = (data || []).filter((r) => !contentUrls(r.request_payload?.items).some((u) => /\/editor\//i.test(u)))
} else { console.error('--spids=A,B 또는 --all 필요'); process.exit(1) }

await ggsanLogin()
console.log(`✓ ggsan login | 대상 ${targets.length}건 | ${APPLY ? 'APPLY' : 'DRY-RUN'}\n`)
let fixed = 0, skip = 0, fail = 0
const editorCache = new Map()
for (const t of targets) {
  const tag = `${t.source_goods_no} [${t.status}] spid=${t.seller_product_id}`
  try {
    let eds = editorCache.get(t.source_goods_no)
    if (!eds) { const html = await (await ggsanFetch(`${BASE}/goods/goods_view.php?goodsNo=${t.source_goods_no}`)).text(); eds = editorImages(html); editorCache.set(t.source_goods_no, eds); await sleep(250) }
    if (!eds.length) { console.log(`  -    ${tag} | editor 상세 없음 → skip (기존 /detail/ 유지)`); skip++; continue }
    const d = (await api('GET', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${t.seller_product_id}`)).b?.data
    if (!d) { console.log(`  ✗    ${tag} | GET 실패`); fail++; continue }
    if (contentUrls(d.items).some((u) => /\/editor\//i.test(u))) { console.log(`  -    ${tag} | 이미 editor 상세 → skip`); skip++; continue }
    if (!APPLY) { console.log(`  [dry] ${tag} | editor ${eds.length}장으로 contents 교체 예정`); fixed++; continue }
    const newContents = eds.map((u) => ({ contentsType: 'IMAGE_NO_SPACE', contentDetails: [{ content: u, detailType: 'IMAGE' }] }))
    for (const it of d.items) it.contents = JSON.parse(JSON.stringify(newContents))
    const put = await api('PUT', '/v2/providers/seller_api/apis/api/v1/marketplace/seller-products', d)
    if (put.b?.code !== 'SUCCESS') { console.log(`  ✗    ${tag} | PUT: ${JSON.stringify(put.b).slice(0, 110)}`); fail++; continue }
    await sleep(8000)
    let ap = await api('PUT', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${t.seller_product_id}/approvals`, {})
    if (ap.b?.code !== 'SUCCESS') { await sleep(6000); ap = await api('PUT', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${t.seller_product_id}/approvals`, {}) }
    // DB request_payload.contents 갱신 — 재실행 시 --all 필터(editor 포함분 제외)가 걸러내 중복 재승인 방지
    try { const rp = JSON.parse(JSON.stringify(t.request_payload || {})); for (const it of (rp.items || [])) it.contents = JSON.parse(JSON.stringify(newContents)); if (rp.items) await sb.from('jimscanner_coupang_listings').update({ request_payload: rp }).eq('id', t.id) } catch { /* 캐시 갱신 실패는 무해 */ }
    console.log(`  ✓    ${tag} | 상세 ${eds.length}장 교체 + 재승인(${ap.b?.code})`)
    fixed++
    await sleep(500)
  } catch (e) { console.log(`  ✗    ${tag} | ${e.message}`); fail++ }
}
console.log(`\n=== ${APPLY ? '완료' : 'DRY-RUN (--apply 로 실행)'}: 교정 ${fixed} / skip ${skip} / 실패 ${fail} ===`)
process.exit(0)
