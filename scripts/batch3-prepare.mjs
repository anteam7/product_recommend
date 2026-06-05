/**
 * 3차 신규 등록 준비:
 *   1) 후보 23건 추출 (마진 50%+, 식품, listings 미등록)
 *   2) ggsan 디테일 fetch → raw_payload 업데이트 (이미지, og:title, 브랜드)
 *   3) 쿠팡 카테고리 추천 API → raw_payload.coupang_predicted_category
 */
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(
  readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      let v = l.slice(i + 1).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      return [l.slice(0, i).trim(), v]
    }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

const BASE = env.GGSAN_BASE_URL || 'https://www.ggsan.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

// ─── ggsan ───
const cookies = new Map()
function setCookies(h) {
  if (!h) return
  for (const part of h.split(/,(?=[^;]+=)/)) {
    const [kv] = part.split(';')
    const [k, v] = kv.trim().split('=')
    if (k && v !== undefined) cookies.set(k, v)
  }
}
const cookieHeader = () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; ')
async function ggsanFetch(url, init = {}) {
  const res = await fetch(url, {
    redirect: 'manual', ...init,
    headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9', Cookie: cookieHeader(), ...(init.headers || {}) },
  })
  setCookies(res.headers.get('set-cookie'))
  return res
}
async function ggsanLogin() {
  await ggsanFetch(`${BASE}/member/login.php`)
  await ggsanFetch(`${BASE}/member/login_ps.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: `${BASE}/member/login.php` },
    body: new URLSearchParams({ loginId: env.GGSAN_USER, loginPwd: env.GGSAN_PASS, saveId: 'y', returnUrl: `${BASE}/main/index.php` }).toString(),
  })
}

function extractDetail(html) {
  const out = {}
  out.title_real = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/)?.[1] ?? null
  out.image_thumb = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/)?.[1] ?? null
  const goodsNo = html.match(/var\s+(?:goodsNo)\s*=\s*['"]?(\d+)/)?.[1]
  // 모든 이미지(호스트 무관) — 진짜 상세설명은 별도 CDN의 /data/editor/ 에 있음
  const allUrls = [...new Set([...html.matchAll(/https?:\/\/[^\s"'\\)<>]+\.(?:jpe?g|png|gif|webp)/gi)].map((m) => m[0].replace(/[\\)>"']+$/, '')))]
  const allImgs = allUrls.filter((u) => /godomall-storage\.cdn-nhncommerce\.com/.test(u))
  const productImgs = goodsNo ? allImgs.filter((u) => u.includes(`/goods/${goodsNo}/`)) : allImgs
  out.images_main = [...new Set(productImgs.filter((u) => /\/(big|magnify)\//.test(u) && !/thumb/.test(u)))]
  out.images_detail = [...new Set(productImgs.filter((u) => /\/detail\//.test(u) && !/thumb/.test(u)))]
  // 진짜 상세설명(긴 이미지) = editor/goods/ . /editor/goods/ 로 두 CDN 패턴 모두 매칭(godomall /editor/goods/{no}/ + cdn-saas-web /data/editor/goods/, 후자가 전자를 부분문자열로 포함). 등장순서 보존.
  out.images_content = allUrls.filter((u) => /\/editor\/goods\//i.test(u))
  out.has_option = /<select[^>]+name=["']optionSno?["']/i.test(html)
  out.imported_origin = /직수입|수입/.test(out.title_real ?? '')
  out.brand_candidate = out.title_real ? out.title_real.split(/\s+/)[0] : null
  out.collected_at = new Date().toISOString()
  return out
}

function extractBrand(title) {
  if (!title) return null
  let t = title.trim()
  const paren = t.match(/^\(([^)]{2,15})\)\s*/)
  if (paren) return paren[1].trim()
  t = t.replace(/^(미국\s*직수입|캐나다\s*직수입|일본\s*직수입|독일\s*직수입|호주\s*직수입|미국직수입|수입)\s+/, '')
  return t.split(/\s+/)[0]
}

// ─── 쿠팡 카테고리 추천 ───
function sign(method, urlPath) {
  const dt = new Date().toISOString().substring(2, 19).replace(/[-:]/g, '') + 'Z'
  return { datetime: dt, signature: crypto.createHmac('sha256', env.COUPANG_SECRET_KEY).update(dt + method + urlPath).digest('hex') }
}
async function predictCategory(productName) {
  const urlPath = '/v2/providers/openapi/apis/api/v1/categorization/predict'
  const { datetime, signature } = sign('POST', urlPath)
  const res = await fetch(`${env.COUPANG_API_HOST}${urlPath}`, {
    method: 'POST',
    headers: {
      Authorization: `CEA algorithm=HmacSHA256, access-key=${env.COUPANG_ACCESS_KEY}, signed-date=${datetime}, signature=${signature}`,
      'Content-Type': 'application/json;charset=UTF-8',
    },
    body: JSON.stringify({ productName }),
  })
  const t = await res.text()
  try { return JSON.parse(t) } catch { return null }
}

// ─── 후보 추출 ───
const { data: rows } = await sb
  .from('jimscanner_ggsan_products')
  .select('goods_no, title, cate_cd, cate_label, brand, price_krw, min_sell_price_krw, list_price_krw, detail_url, raw_payload')
  .gte('min_sell_price_krw', 30000)
  .gte('price_krw', 10000)
  .eq('is_imminent', false)
  .neq('title', 'SOLD OUT')
  .not('min_sell_price_krw', 'is', null)
  .not('cate_cd', 'in', '("015","019","020","022","021")')  // 비식품 + 카테고리21(화장품 의심)
  .order('min_sell_price_krw', { ascending: false })
  .limit(500)

// listings에 이미 있는 것 제외
const { data: existing } = await sb.from('jimscanner_coupang_listings').select('source_goods_no')
const excluded = new Set((existing ?? []).map((r) => r.source_goods_no))

const MIN_MARGIN = parseFloat(process.env.MIN_MARGIN ?? '0.4')
const MAX_MARGIN = parseFloat(process.env.MAX_MARGIN ?? '0.5')
const MAX_N = parseInt(process.env.MAX_N ?? '70')
const filtered = rows.filter((r) => {
  const margin = (r.min_sell_price_krw - r.price_krw) / r.min_sell_price_krw
  return margin >= MIN_MARGIN && margin < MAX_MARGIN && !excluded.has(r.goods_no)
}).slice(0, MAX_N)

console.log(`후보 ${filtered.length}건 처리 시작\n`)

await ggsanLogin()
console.log('✓ ggsan login\n')

for (let i = 0; i < filtered.length; i++) {
  const r = filtered[i]
  const idx = `[${i + 1}/${filtered.length}]`
  try {
    // 1. 디테일 페이지
    const detailRes = await ggsanFetch(`${BASE}/goods/goods_view.php?goodsNo=${r.goods_no}`)
    if (!detailRes.ok) { console.log(`${idx} ${r.goods_no} HTTP ${detailRes.status}`); continue }
    const html = await detailRes.text()
    const detail = extractDetail(html)
    const realTitle = detail.title_real || r.title
    const brand = extractBrand(realTitle)

    // 2. 카테고리 추천
    await new Promise((s) => setTimeout(s, 200))
    const catResp = await predictCategory(realTitle)
    const catData = catResp?.data
    const newPayload = {
      ...(r.raw_payload || {}),
      ...detail,
      coupang_predicted_category: catData
        ? { id: catData.predictedCategoryId, name: catData.predictedCategoryName, type: catData.autoCategorizationPredictionResultType, predicted_at: new Date().toISOString() }
        : null,
    }

    // 3. DB update
    const update = { raw_payload: newPayload, brand }
    if (realTitle && realTitle !== 'SOLD OUT' && realTitle.length > 5) update.title = realTitle
    await sb.from('jimscanner_ggsan_products').update(update).eq('goods_no', r.goods_no)

    console.log(`${idx} ✓ ${r.goods_no} ${realTitle.slice(0, 40).padEnd(40)} | brand=${brand} | cat=${catData?.predictedCategoryId} (${catData?.predictedCategoryName}) | img main=${detail.images_main.length}/detail=${detail.images_detail.length}`)
    await new Promise((s) => setTimeout(s, 200))
  } catch (e) {
    console.log(`${idx} ✗ ${r.goods_no} ERROR: ${e.message}`)
  }
}

console.log('\n=== 완료 — 후보 ID 저장 ===')
console.log(filtered.map((r) => r.goods_no).join(','))
