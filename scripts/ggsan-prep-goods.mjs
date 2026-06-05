/**
 * 지정 goods_no ggsan 제품 등록준비: 상세 스크래핑(이미지) + 쿠팡 카테고리 예측 → raw_payload 저장.
 * 이후 coupang-register-batch-v2.mjs 가 이 제품들을 등록.
 *   node scripts/ggsan-prep-goods.mjs --goods=1000000935,1000001014
 * (batch3-prepare.mjs 의 prep 로직을 특정 goods_no 타겟으로 재사용)
 */
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/).filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }))
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const BASE = env.GGSAN_BASE_URL || 'https://www.ggsan.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const GOODS = (process.argv.find(a => a.startsWith('--goods='))?.split('=')[1] || '').split(',').map(s => s.trim()).filter(Boolean)
if (!GOODS.length) { console.error('--goods=no1,no2 필수'); process.exit(1) }

const cookies = new Map()
function setCookies(h) { if (!h) return; for (const part of h.split(/,(?=[^;]+=)/)) { const [kv] = part.split(';'); const [k, v] = kv.trim().split('='); if (k && v !== undefined) cookies.set(k, v) } }
const cookieHeader = () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; ')
async function ggsanFetch(url, init = {}) { const res = await fetch(url, { redirect: 'manual', ...init, headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9', Cookie: cookieHeader(), ...(init.headers || {}) } }); setCookies(res.headers.get('set-cookie')); return res }
async function ggsanLogin() {
  await ggsanFetch(`${BASE}/member/login.php`)
  const r = await ggsanFetch(`${BASE}/member/login_ps.php`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: `${BASE}/member/login.php` }, body: new URLSearchParams({ loginId: env.GGSAN_USER, loginPwd: env.GGSAN_PASS, saveId: 'y', returnUrl: `${BASE}/main/index.php` }).toString() })
  const html = await r.text()
  if (!/parent\.location\.href='https:\/\/www\.ggsan\.com\/main\/index\.php'/.test(html)) throw new Error('ggsan login failed')
}
function extractDetail(html) {
  const out = {}
  out.title_real = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/)?.[1] ?? null
  out.image_thumb = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/)?.[1] ?? null
  const goodsNo = html.match(/var\s+(?:goodsNo)\s*=\s*['"]?(\d+)/)?.[1]
  // 모든 이미지 URL(호스트 무관) — 진짜 상세설명은 별도 CDN(cdn-saas-web-*.cdn-nhncommerce.com)의 /data/editor/ 에 있음
  const allUrls = [...new Set([...html.matchAll(/https?:\/\/[^\s"'\\)<>]+\.(?:jpe?g|png|gif|webp)/gi)].map((m) => m[0].replace(/[\\)>"']+$/, '')))]
  const allImgs = allUrls.filter((u) => /godomall-storage\.cdn-nhncommerce\.com/.test(u))
  const productImgs = goodsNo ? allImgs.filter((u) => u.includes(`/goods/${goodsNo}/`)) : allImgs
  out.images_main = [...new Set(productImgs.filter((u) => /\/(big|magnify)\//.test(u) && !/thumb/.test(u)))]
  out.images_detail = [...new Set(productImgs.filter((u) => /\/detail\//.test(u) && !/thumb/.test(u)))]
  // 진짜 상세설명(긴 이미지) = /data/editor/goods/ . prep이 과거 godomall-storage+/goods/{no}/ 만 봐서 통째로 누락 → 짧은 제품사진만 등록되던 버그. 등장순서 보존.
  // /editor/goods/ 로 두 CDN 패턴 모두 매칭: godomall-storage/.../editor/goods/{no}/ 와 cdn-saas-web/.../data/editor/goods/ (후자가 전자의 부분문자열 포함). 과거 /data/editor/ 만 봐서 godomall editor 상세 누락되던 버그.
  out.images_content = allUrls.filter((u) => /\/editor\/goods\//i.test(u))
  out.has_option = /<select[^>]+name=["']optionSno?["']/i.test(html)
  out.collected_at = new Date().toISOString()
  return out
}
function extractBrand(title) { if (!title) return null; let t = title.trim(); const p = t.match(/^\(([^)]{2,15})\)\s*/); if (p) return p[1].trim(); t = t.replace(/^(미국|캐나다|일본|독일|호주)\s*직수입\s+/, '').replace(/^수입\s+/, ''); return t.split(/\s+/)[0] }

// 상세 텍스트에서 실제 판매 규정 추출: 판매가격절대준수 최저가 + 폐쇄몰/오픈마켓 제약
function extractRule(html) {
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&[a-z]+;/g, ' ').replace(/\s+/g, ' ')
  // 폐쇄몰/오픈마켓 금지 = 오픈마켓(쿠팡) 부적합
  const closedMall = /폐쇄몰/.test(text) || /오픈\s*마켓[^.]{0,15}(금지|불가|제한)/.test(text)
  // 실제 최저가: "N원 이상 판매 부탁" 또는 "절대준수 ... N원" (무료배송 200,000 같은 건 앵커로 배제)
  const cands = []
  for (const re of [/([\d,]{4,})\s*원\s*이상\s*판매\s*부탁/g, /절대\s*준수[^0-9]{0,15}(?:1개\s*)?([\d,]{4,})\s*원/g, /폐쇄몰[^0-9]{0,10}([\d,]{4,})\s*원\s*이상/g]) {
    let m; while ((m = re.exec(text))) { const n = parseInt(m[1].replace(/,/g, '')); if (n >= 1000 && n <= 1000000) cands.push(n) }
  }
  const textMin = cands.length ? Math.max(...cands) : null
  // 수량별(묶음) 절대준수 MSP — 단품 상세에 "N개 묶음 X원" 적힌 경우(예: 4150 "1개 12,400 / 2개 묶음 23,810 / 3개 묶음 34,970"). 절대준수 구간 내에서만 파싱.
  const tiered = {}
  const seg = text.match(/(?:절대\s*준수|판매가격\s*절대준수)[^]{0,160}/)
  if (seg) { for (const mm of seg[0].matchAll(/(\d+)\s*개\s*(?:묶음)?\s*([\d,]{4,})\s*원/g)) { const n = parseInt(mm[1]); const p = parseInt(mm[2].replace(/,/g, '')); if (n >= 1 && n <= 12 && p >= 1000 && p <= 2000000) tiered[n] = p } }
  return { closed_mall: closedMall, text_min_price: textMin, tiered_msp: Object.keys(tiered).length > 1 ? tiered : null }
}
function sign(method, urlPath) { const dt = new Date().toISOString().substring(2, 19).replace(/[-:]/g, '') + 'Z'; return { dt, sig: crypto.createHmac('sha256', env.COUPANG_SECRET_KEY).update(dt + method + urlPath).digest('hex') } }
async function predictCategory(productName) {
  const p = '/v2/providers/openapi/apis/api/v1/categorization/predict'
  const { dt, sig } = sign('POST', p)
  const res = await fetch(`${env.COUPANG_API_HOST}${p}`, { method: 'POST', headers: { Authorization: `CEA algorithm=HmacSHA256, access-key=${env.COUPANG_ACCESS_KEY}, signed-date=${dt}, signature=${sig}`, 'Content-Type': 'application/json;charset=UTF-8' }, body: JSON.stringify({ productName }) })
  try { return JSON.parse(await res.text()) } catch { return null }
}

const { data: rows } = await sb.from('jimscanner_ggsan_products').select('goods_no, title, price_krw, min_sell_price_krw, detail_url, raw_payload').in('goods_no', GOODS)
console.log(`prep 대상 ${rows.length}건`)
await ggsanLogin(); console.log('✓ ggsan login\n')
for (let i = 0; i < rows.length; i++) {
  const r = rows[i]
  try {
    const dr = await ggsanFetch(`${BASE}/goods/goods_view.php?goodsNo=${r.goods_no}`)
    if (!dr.ok) { console.log(`[${i + 1}] ${r.goods_no} HTTP ${dr.status}`); continue }
    const html = await dr.text()
    const detail = extractDetail(html)
    const rule = extractRule(html)
    const realTitle = detail.title_real || r.title
    const brand = extractBrand(realTitle)
    // 폐쇄몰/오픈마켓 제한 = 쿠팡 등록 제외 (카테고리 미설정 → register가 안 잡음)
    if (rule.closed_mall) {
      await sb.from('jimscanner_ggsan_products').update({ raw_payload: { ...(r.raw_payload || {}), ...detail, sales_rule: rule, coupang_predicted_category: null }, brand }).eq('goods_no', r.goods_no)
      console.log(`[${i + 1}] 🚫 ${r.goods_no} ${realTitle.slice(0, 34).padEnd(34)} | 폐쇄몰/오픈마켓 제한 → 등록 제외 (텍스트 최저가 ${rule.text_min_price || '?'})`)
      await new Promise(s => setTimeout(s, 250)); continue
    }
    await new Promise(s => setTimeout(s, 250))
    const cat = (await predictCategory(realTitle))?.data
    const payload = { ...(r.raw_payload || {}), ...detail, sales_rule: rule, tiered_msp: rule.tiered_msp || (r.raw_payload || {}).tiered_msp || null, coupang_predicted_category: cat ? { id: cat.predictedCategoryId, name: cat.predictedCategoryName, type: cat.autoCategorizationPredictionResultType, predicted_at: new Date().toISOString() } : null }
    const upd = { raw_payload: payload, brand }
    if (realTitle && realTitle.length > 5 && realTitle !== 'SOLD OUT') upd.title = realTitle
    // 실제 최저가(텍스트)가 구조화 MSP보다 높으면 그것을 MSP로 채택 → 최저가 위반 방지
    const newMin = Math.max(r.min_sell_price_krw || 0, rule.text_min_price || 0)
    if (newMin > 0) upd.min_sell_price_krw = newMin
    await sb.from('jimscanner_ggsan_products').update(upd).eq('goods_no', r.goods_no)
    console.log(`[${i + 1}] ✓ ${r.goods_no} ${realTitle.slice(0, 32).padEnd(32)} | MSP ${newMin || '-'}${rule.text_min_price ? ` (텍스트 ${rule.text_min_price})` : ''} | cat=${cat?.predictedCategoryId}(${cat?.predictedCategoryName}) | img ${detail.images_main.length}/${detail.images_detail.length}`)
    await new Promise(s => setTimeout(s, 250))
  } catch (e) { console.log(`[${i + 1}] ✗ ${r.goods_no} ${e.message}`) }
}
console.log('\n=== prep 완료 — 다음: node scripts/coupang-register-batch-v2.mjs ===')
