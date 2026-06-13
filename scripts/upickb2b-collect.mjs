/**
 * upickb2b (Cafe24 위탁 도매몰) 상품 수집 → jimscanner_upickb2b_products upsert.
 *   node --env-file=.env.local scripts/upickb2b-collect.mjs [--cates=24,25,92] [--limit=N] [--dry]
 *
 * fetch+쿠키 로그인(ggsan-prep-goods.mjs 패턴). 상세 th/td 테이블에서
 * 회원가(매입가)·최저판매가(단품/수량별)·판매가능플랫폼·자체상품코드·이미지 캡처.
 * "모든마켓 판매가능"만 쿠팡 등록 후보(coupang_allowed) — 쿠팡 금지 상품은 수집하되 플래그.
 * content_hash 로 변동(가격·MSP·재고)만 감지해 last_changed_at 갱신.
 *
 * 다음 단계(P2): coupang-register-batch-v2 류가 coupang_allowed=true 를 source='upickb2b' 로 등록.
 */
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/).filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }))
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const BASE = env.UPICKB2B_BASE_URL || 'https://upickb2b.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const DRY = process.argv.includes('--dry')
const CATES = (process.argv.find(a => a.startsWith('--cates='))?.split('=')[1] || '24,25,92').split(',').map(s => s.trim()).filter(Boolean)
const LIMIT = +(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || 0)
const CATE_LABELS = { '24': '건강기능식품', '25': '건강관련식품', '92': '건강식품(환액즙)' }
const sleep = ms => new Promise(s => setTimeout(s, ms))

// ── fetch + 쿠키 (ggsan 패턴) ──
const cookies = new Map()
function setCookies(h) { if (!h) return; for (const part of h.split(/,(?=[^;]+=)/)) { const [kv] = part.split(';'); const eq = kv.indexOf('='); if (eq < 0) continue; const k = kv.slice(0, eq).trim(); const v = kv.slice(eq + 1).trim(); if (k) cookies.set(k, v) } }
const cookieHeader = () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; ')
async function fx(url, init = {}) {
  const res = await fetch(url, { redirect: 'manual', ...init, headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9', Accept: 'text/html,application/xhtml+xml', Cookie: cookieHeader(), ...(init.headers || {}) } })
  setCookies(res.headers.get('set-cookie'))
  return res
}
async function login() {
  await fx(`${BASE}/member/login.html`)
  const body = new URLSearchParams({ member_id: env.UPICKB2B_USER, member_passwd: env.UPICKB2B_PASS, returnUrl: '/' })
  await fx(`${BASE}/exec/front/Member/login/`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: `${BASE}/member/login.html` }, body: body.toString() })
  if (!cookies.has('ECSESSID')) throw new Error('upickb2b login failed (no session)')
}

// ── 파싱 ──
const decodeEnt = s => (s || '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
const stripTags = s => decodeEnt((s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
const won = s => { const m = (s || '').match(/([\d,]{3,})\s*원/); return m ? parseInt(m[1].replace(/,/g, '')) : null }
function parseMsp(s) {
  if (!s) return { single: null, tiered: null }
  const tiered = {}
  for (const m of s.matchAll(/(\d+)\s*개[^\d]{0,6}([\d,]{4,})\s*원/g)) { const n = parseInt(m[1]); const p = parseInt(m[2].replace(/,/g, '')); if (n >= 1 && n <= 99 && p >= 1000 && p <= 3000000) tiered[n] = p }
  const keys = Object.keys(tiered)
  if (keys.length) return { single: tiered[1] ?? Math.min(...Object.values(tiered)), tiered: keys.length > 1 ? tiered : null }
  return { single: won(s), tiered: null }
}
// 최저판매가: 라벨이 "최저판매가" / "오픈마켓 최저판매가" 등으로 다양 → 모든 최저판매가 라벨 스캔, 최댓값(=floor) 채택.
function extractMsp(info) {
  // 오픈마켓 MSP만 사용 ("최저판매가"/"오픈마켓 최저판매가"). 폐쇄몰 최저판매가는 오픈마켓 floor 아님 → 제외.
  const keys = Object.keys(info).filter((k) => /최저\s*판매\s*가/.test(k) && !/폐쇄몰/.test(k))
  let single = null, tiered = null
  for (const k of keys) { const m = parseMsp(info[k]); if (m.single && (single == null || m.single > single)) single = m.single; if (m.tiered && !tiered) tiered = m.tiered }
  return { single, tiered }
}

function infoTable(html) {
  const map = {}
  for (const m of html.matchAll(/<tr[^>]*class="[^"]*xans-record-[^"]*"[^>]*>([\s\S]*?)<\/tr>/g)) {
    const th = stripTags((m[1].match(/<th[^>]*>([\s\S]*?)<\/th>/) || [])[1])
    const td = stripTags((m[1].match(/<td[^>]*>([\s\S]*?)<\/td>/) || [])[1])
    if (th && td && th.length < 30 && !(th in map)) map[th] = td
  }
  return map
}
function parseOptions(html) {
  const opts = []
  for (const sel of html.matchAll(/<select[^>]+(?:id|name)=["'][^"']*option[^"']*["'][\s\S]*?<\/select>/gi)) {
    const names = [...sel[0].matchAll(/<option[^>]*value=["'][^"'*]+["'][^>]*>([^<]+)<\/option>/g)].map(o => o[1].trim()).filter(t => t && !/^(필수|선택|옵션|=+|-{2,}|\.{2,}|\*)/.test(t))
    if (names.length) opts.push(names)
  }
  return opts
}
function deriveEligibility(platforms, policy, title) {
  const plat = platforms || ''
  const blob = `${plat} ${policy || ''} ${title || ''}`
  // 오픈마켓(쿠팡 포함) 판매 불가 신호 — 폐쇄몰/오프라인 전용/오픈마켓 금지 (ggsan extractRule 과 동일 취지)
  const openMarketBlocked = /폐쇄몰/.test(blob) || /오프라인\s*전용/.test(blob) || /오픈\s*마켓[^./]{0,15}(금지|불가|제한|제외)/.test(blob)
  // "쿠팡 아이템위너 매칭 금지"는 판매금지가 아니라 카탈로그 매칭만 금지 → 쿠팡 판매 가능
  const itemWinnerOnly = /아이템\s*위너|아이템위너|위너\s*매칭/.test(blob)
  const coupangBlocked = openMarketBlocked || ((/쿠팡[^./]{0,12}(금지|불가|제외)/.test(blob) || /쿠팡\s*판매\s*금지/.test(blob)) && !itemWinnerOnly)
  const rest = plat.replace(/모든\s*마켓\s*판매\s*가능/, '')
  const allMarkets = /모든\s*마켓\s*판매\s*가능/.test(plat) && !coupangBlocked && !/금지|불가|제외|제한|전용|만\s*가능/.test(rest)
  return { coupang_allowed: !coupangBlocked, all_markets_ok: allMarkets }
}

// 상세설명 이미지: #prdDetail 영역 콘텐츠 이미지(호스트 무관). 상대경로는 og:image 호스트로 해석(외부호스트 상세 대응). 스킨/아이콘/갤러리/카테고리로고 제외.
function detailImages(html, ogImage) {
  const ogHost = ogImage && /^https?:\/\//.test(ogImage) ? ogImage.match(/^https?:\/\/[^/]+/)[0] : BASE
  const start = html.search(/id=["']prdDetail["']/)
  let region = html
  if (start >= 0) {
    region = html.slice(start, start + 300000)
    const end = region.search(/id=["'](?:prdReview|prdQnA|prdInfo|guideArea)["']|<!--\s*\/?(?:상품후기|리뷰)/i)
    if (end > 0) region = region.slice(0, end)
  }
  const raw = [...region.matchAll(/<img[^>]+(?:data-src|src)=["']([^"']+\.(?:jpe?g|png|gif|webp)[^"']*)["']/gi)].map(m => m[1])
  const SKIP = /echosting\.cafe24\.com|\/SkinImg\/|\/design\/|\/skin\/|icon|btn_|ico_|loading|blank|\/web\/product\/|\/web\/upload\/category\//i
  const abs = u => u.startsWith('//') ? 'https:' + u : (u.startsWith('/') ? ogHost + u : u)
  return [...new Set(raw.filter(u => u && !SKIP.test(u)).map(abs))]
}

async function listCategory(cateNo) {
  const items = []; const seen = new Set()
  for (let page = 1; page <= 30; page++) {
    const r = await fx(`${BASE}/category/x/${cateNo}/?page=${page}`)
    if (!r.ok) break
    let html = await r.text()
    // 메인 상품 리스트만 — 페이지네이션 이후(추천/최근 본 상품) 제거
    const cut = html.search(/class="[^"]*ec-base-paginate/)
    if (cut > 0) html = html.slice(0, cut)
    // 상품 블록 단위로 분리해 품절 아이콘(ico_product_soldout / alt="품절") 여부 판정
    const blocks = [...html.matchAll(/id=["']anchorBoxId_(\d+)["']([\s\S]*?)(?=id=["']anchorBoxId_|$)/g)]
    const fresh = []
    for (const b of blocks) {
      if (seen.has(b[1])) continue
      seen.add(b[1])
      fresh.push({ id: b[1], soldout: /ico_product_soldout|alt=["']품절["']/i.test(b[2]) })
    }
    if (!fresh.length) break
    items.push(...fresh)
    await sleep(250)
  }
  return items
}
async function fetchDetail(productNo) {
  const r = await fx(`${BASE}/product/x/${productNo}/category/1/display/1/`)
  if (!r.ok) return null
  const html = await r.text()
  const info = infoTable(html)
  const title = decodeEnt((html.match(/<meta property="og:title" content="([^"]+)"/) || [])[1] || info['상품명'] || '').replace(/\s*-\s*U-PICK B2B\s*$/, '').replace(/\s+/g, ' ').trim() || null
  const thumb = (html.match(/<meta property="og:image" content="([^"]+)"/) || [])[1] || null
  const images = detailImages(html, thumb)
  const member = won(info['회원가'])
  const msp = extractMsp(info)
  const elig = deriveEligibility(info['판매가능플랫폼'], info['판매정책'], title)
  const opts = parseOptions(html)
  return {
    product_no: String(productNo),
    self_code: info['자체상품코드'] || null,
    product_code: info['상품코드'] || null,
    title,
    member_price_krw: member,
    min_sell_price_krw: msp.single,
    tiered_msp: msp.tiered,
    sellable_platforms: info['판매가능플랫폼'] || null,
    sale_policy: info['판매정책'] || null,
    coupang_allowed: elig.coupang_allowed,
    all_markets_ok: elig.all_markets_ok,
    shipping_fee_text: info['배송비'] || null,
    expiry_text: info['소비기한'] || null,
    order_deadline: info['발주마감'] || null,
    image_thumb: thumb,
    images,
    has_option: opts.length > 0,
    options: opts.length ? opts : null,
    status: 'active',
    detail_url: `${BASE}/product/x/${productNo}/category/1/display/1/`,
    raw_info: info,
  }
}
const hashOf = d => crypto.createHash('sha256').update(JSON.stringify([d.member_price_krw, d.min_sell_price_krw, d.sellable_platforms, d.status, d.title, d.image_thumb, (d.images || []).join('|')])).digest('hex').slice(0, 16)

// ── main ──
await login(); console.log(`✓ upickb2b login${DRY ? ' [DRY]' : ''}`)
let total = 0, changed = 0, excluded = 0
for (const cate of CATES) {
  const items = await listCategory(cate)
  const soldoutCount = items.filter(x => x.soldout).length
  let ids = items.filter(x => !x.soldout).map(x => x.id)   // 품절 상품은 수집 제외
  if (LIMIT) ids = ids.slice(0, LIMIT)
  console.log(`\n[cate ${cate} ${CATE_LABELS[cate] || ''}] 판매중 ${ids.length}개 (품절 ${soldoutCount}개 제외)`)
  for (let i = 0; i < ids.length; i++) {
    try {
      const d = await fetchDetail(ids[i])
      if (!d || !d.title) { console.log(`  ✗ ${ids[i]} detail/제목 파싱 실패`); await sleep(200); continue }
      d.cate_no = cate; d.cate_label = CATE_LABELS[cate] || null; d.content_hash = hashOf(d)
      if (!d.coupang_allowed) excluded++
      const flag = !d.coupang_allowed ? '🚫쿠팡금지' : (d.all_markets_ok ? '✅모든마켓' : '🟡일부')
      console.log(`  ${flag} ${d.product_no} ${(d.title || '').slice(0, 26).padEnd(26)} 회원가 ${d.member_price_krw || '-'} / MSP ${d.min_sell_price_krw || '-'}${d.tiered_msp ? '(수량별)' : ''} opt:${d.has_option ? d.options.length : 0} img:${d.images.length}`)
      if (!DRY) {
        const now = new Date().toISOString()
        const { data: ex } = await sb.from('jimscanner_upickb2b_products').select('content_hash').eq('product_no', d.product_no).maybeSingle()
        if (ex && ex.content_hash === d.content_hash) {
          await sb.from('jimscanner_upickb2b_products').update({ last_seen_at: now, status: d.status }).eq('product_no', d.product_no)
        } else {
          await sb.from('jimscanner_upickb2b_products').upsert({ ...d, last_seen_at: now, last_changed_at: now }, { onConflict: 'product_no' })
          changed++
        }
      }
      total++
      await sleep(300)
    } catch (e) { console.log(`  ✗ ${ids[i]} ${e.message}`) }
  }
}
console.log(`\n=== 수집 ${total}건 (변동 ${changed} / 쿠팡금지 ${excluded}건 제외대상) ${DRY ? '[DRY — DB 미기록]' : ''} ===`)
