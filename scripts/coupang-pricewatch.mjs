/**
 * 내 쿠팡 상품 아이템위너/시세 모니터링 + MSP 준수 리프라이스 + 광고후보 분류.
 * 스토어프론트 직접 접근 금지: 스카우트 확장(collect_list, 페이싱)이 사람처럼 검색·수집.
 * 여기선 명령 큐잉 + 결과 비교/분류 + (판매중용) vendor-item 가격변경만.
 *
 *   node scripts/coupang-pricewatch.mjs --collect [--all] [--limit 50]
 *       → 워치리스트(품절 제외)를 scout collect_list 로 큐잉. 이미 모니터/진행중인 spid 는 건너뜀(배치 자동 전진).
 *   node scripts/coupang-pricewatch.mjs --compare <sessionId> [--force]
 *       → 수집 시세 vs 내 판매가 비교 → 분류(WIN/REPRICE/STRUCTURAL/MSP_HOLE/UNKNOWN) → 누적 upsert 발행 + 광고후보 적재.
 *   node scripts/coupang-pricewatch.mjs --reprice [--apply] [--min-match 5] [--max-drop 0.45]
 *       → price_verdict=REPRICE 미반영분을 MSP 하한 지키며 vendor-item prices API 로 가격조정. 기본 DRY-RUN.
 *
 * 워치리스트 = 최근 60일 판매상품(기본) 또는 판매중 전체(--all). 품절(stock_status='sold_out')은 항상 제외.
 * 하한 = msp_price_krw(최저판매가). MSP 없는(0/null) 상품은 리프라이스 제외(MSP_HOLE) + 백필 대상.
 */
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(__dirname, '..')
const env = Object.fromEntries(
  readFileSync(path.join(REPO, '.env.local'), 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const { COUPANG_ACCESS_KEY: ACCESS_KEY, COUPANG_SECRET_KEY: SECRET_KEY, COUPANG_API_HOST: HOST } = env
const args = process.argv.slice(2)
const has = (k) => args.includes(`--${k}`)
const val = (k, d) => { const i = args.indexOf(`--${k}`); return i > -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d }
const LIMIT = parseInt(val('limit', '50')) || 50

// ── 가격/마진 상수 (coupang_pricing_model 동기화) ──
const SHIP = 3000, DEFAULT_FEE = 0.106, VAT_DIVISOR = 11
const r100 = (n) => Math.round(n / 100) * 100
const feeRateOf = (myPrice, estFee) => {
  if (estFee > 0 && myPrice > 0) { const r = estFee / myPrice; if (r >= 0.05 && r <= 0.16) return r }
  return DEFAULT_FEE
}
const marginAt = (price, cost, feeRate) => price - ((cost || 0) + SHIP) - Math.round(price * feeRate) - Math.round(price / VAT_DIVISOR)

// ── Coupang API (HMAC) — 리프라이스용 ──
function sign(method, urlPath, query = '') {
  const dt = new Date().toISOString().substring(2, 19).replace(/[-:]/g, '') + 'Z'
  return { dt, sig: crypto.createHmac('sha256', SECRET_KEY).update(dt + method + urlPath + (query || '')).digest('hex') }
}
async function api(method, urlPath, query = '') {
  const { dt, sig } = sign(method, urlPath, query)
  const res = await fetch(`${HOST}${urlPath}${query ? '?' + query : ''}`, {
    method,
    headers: { Authorization: `CEA algorithm=HmacSHA256, access-key=${ACCESS_KEY}, signed-date=${dt}, signature=${sig}`, 'Content-Type': 'application/json;charset=UTF-8' },
  })
  const t = await res.text()
  try { return { status: res.status, body: JSON.parse(t) } } catch { return { status: res.status, body: t } }
}
const apiSuccess = (r) => r.status === 200 && (r.body?.code === 'SUCCESS' || r.body?.code === 200 || r.body?.code === '200')

// 상품명 → 검색 키워드(노이즈 제거, 브랜드+핵심 유지)
function toKeyword(name) {
  return String(name || '')
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/정품|프리미엄|본사정품|당일발송|무료배송|증정|사은품/g, ' ')
    .replace(/,/g, ' ').replace(/\s*x\s*/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 40)
}
// 제목 유사도(토큰 자카드)
const norm = (s) => (s || '').replace(/[^0-9a-z가-힣]+/gi, ' ').toLowerCase().trim()
function sim(a, b) {
  const ta = new Set(norm(a).split(/\s+/).filter((x) => x.length >= 2)), tb = new Set(norm(b).split(/\s+/).filter((x) => x.length >= 2))
  if (!ta.size || !tb.size) return 0
  let i = 0; for (const t of ta) if (tb.has(t)) i++
  return i / Math.min(ta.size, tb.size)
}
const median = (arr) => { const a = arr.filter((n) => n > 0).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null }

// ── 분류: 시세 vs 내 판매가 (하한=MSP 준수) ──
function classify({ my, cost, msp, market_low, market_median, match_count, sold_count, view_count, est_fee }) {
  const feeRate = feeRateOf(my, est_fee)
  let verdict = 'UNKNOWN', reprice_target = null, margin_at_target = null
  if (market_low != null) {
    if (my <= market_low * 1.03) verdict = 'WIN'
    else if (!msp) verdict = 'MSP_HOLE'          // 하한 없음 → 안전 리프라이스 불가
    else if (msp > market_low) verdict = 'STRUCTURAL' // MSP 하한도 시세보다 비쌈 → 못 이김
    else {
      let t = Math.floor(market_low / 100) * 100  // 시세최저 100원 내림(살짝 언더컷)
      if (t < msp) t = Math.ceil(msp / 100) * 100 // MSP 아래 금지
      if (t > market_low) t = market_low          // 그래도 시세 초과면 시세에 맞춤(최선)
      const m = marginAt(t, cost, feeRate)
      if (m > 0) { verdict = 'REPRICE'; reprice_target = t; margin_at_target = m } // 흑자로 위너 가능
      else { verdict = 'STRUCTURAL'; margin_at_target = m }                        // 시세로 내려도 적자 → 구조적
    }
  }
  // 광고후보: 가격경쟁 가능(WIN/REPRICE) + 마진 여유 + 수요 신호
  const compPrice = verdict === 'WIN' ? my : (verdict === 'REPRICE' ? reprice_target : null)
  let ad_candidate = false, ad_score = null, ad_reason = null
  if (compPrice != null) {
    const m = marginAt(compPrice, cost, feeRate), mpct = m / compPrice
    const demand = (sold_count || 0) >= 1 || (view_count || 0) >= 50 || (match_count || 0) >= 8
    if (m >= 3000 && mpct >= 0.12 && demand) {
      ad_candidate = true
      const marginScore = Math.min(mpct / 0.30, 1)
      const demandScore = Math.min(((sold_count || 0) * 10 + (view_count || 0)) / 300, 1)
      const priceScore = verdict === 'WIN' ? 1 : 0.6
      ad_score = +(marginScore * 0.4 + demandScore * 0.35 + priceScore * 0.25).toFixed(3)
      ad_reason = `마진 ${Math.round(mpct * 100)}%(${m.toLocaleString()}원)${verdict === 'REPRICE' ? ' 리프라이스후' : ''} · 조회 ${view_count || 0}·판매 ${sold_count || 0}·경쟁매칭 ${match_count} → 노출↑ 여지`
    }
  }
  return { verdict, reprice_target, margin_at_target, ad_candidate, ad_score, ad_reason }
}

// ── 워치리스트 로드 (품절 제외, 이미 모니터/진행중 spid 건너뜀) ──
async function loadWatchlist() {
  let sellerIds = null
  if (!has('all')) {
    const { data: ords, error: oe } = await sb.from('jimscanner_coupang_orders')
      .select('seller_product_id').gte('ordered_at', new Date(Date.now() - 60 * 864e5).toISOString())
    if (oe) { console.error('주문 조회 오류:', oe.message); process.exit(1) }
    sellerIds = [...new Set((ords ?? []).map((o) => o.seller_product_id).filter(Boolean))]
    if (!sellerIds.length) { console.log('최근 60일 판매 상품 없음 — --all 로 판매중 전체 모니터 가능'); return [] }
  }
  let q = sb.from('jimscanner_coupang_listings')
    .select('seller_product_id, registered_title, list_price_krw, dome_price_krw, msp_price_krw, estimated_fee_krw, sold_count, view_count, stock_status, displayable')
    .eq('displayable', true).neq('stock_status', 'sold_out')   // 품절 제외
  if (sellerIds) q = q.in('seller_product_id', sellerIds)
  const { data, error: le } = await q
  if (le) { console.error('리스팅 조회 오류:', le.message); process.exit(1) }
  const rows = (data ?? []).filter((r) => r.registered_title && r.list_price_krw > 0)
  // dedup by seller_product_id
  const best = {}
  for (const r of rows) if (!best[r.seller_product_id]) best[r.seller_product_id] = r
  let list = Object.values(best)

  // 이미 모니터(pricewatch 발행됨) or 진행중(scout 명령 미완료) spid 는 제외 → 배치 자동 전진
  const { data: pw } = await sb.from('jimscanner_coupang_pricewatch').select('seller_product_id')
  const { data: active } = await sb.from('jimscanner_scout_commands')
    .select('payload').eq('command_type', 'collect_list').in('status', ['queued', 'sent', 'running'])
  const skip = new Set()
  for (const r of pw ?? []) if (r.seller_product_id != null) skip.add(String(r.seller_product_id))
  for (const c of active ?? []) { const s = c.payload?._pw?.spid; if (s != null) skip.add(String(s)) }
  list = list.filter((r) => !skip.has(String(r.seller_product_id)))

  // 우선순위: 최근판매(sold_count) → 노출(view_count) → 고가
  list.sort((a, b) => (b.sold_count || 0) - (a.sold_count || 0) || (b.view_count || 0) - (a.view_count || 0) || (b.list_price_krw || 0) - (a.list_price_krw || 0))
  return { list: list.slice(0, LIMIT), remaining: Math.max(0, list.length - LIMIT) }
}

// ── COLLECT: scout collect_list 명령 큐잉 ──
async function collect() {
  const res = await loadWatchlist()
  const wl = Array.isArray(res) ? res : res.list
  const remaining = Array.isArray(res) ? 0 : res.remaining
  if (!wl.length) { console.log('워치리스트 없음(모두 모니터 완료 또는 진행중)'); return }
  const { data: sess, error: se } = await sb.from('jimscanner_scout_sessions')
    .insert({ title: `가격모니터 ${new Date().toISOString().slice(0, 10)} (${wl.length}건)` }).select('id').single()
  if (se || !sess?.id) { console.error('세션 생성 오류:', se?.message || 'no id'); process.exit(1) }
  const sid = sess.id
  const now = new Date().toISOString()
  const cmds = wl.map((w) => ({
    session_id: sid, command_type: 'collect_list',
    payload: { keyword: toKeyword(w.registered_title), maxPages: 1, maxItems: 40, _pw: {
      spid: w.seller_product_id, name: w.registered_title, my_price: w.list_price_krw, my_cost: w.dome_price_krw,
      msp: w.msp_price_krw || 0, est_fee: w.estimated_fee_krw || 0, sold_count: w.sold_count || 0, view_count: w.view_count || 0,
    } },
    status: 'queued', brain_notified_at: now,   // 두뇌 개입 차단(순수 수집)
  }))
  const { error } = await sb.from('jimscanner_scout_commands').insert(cmds)
  if (error) { console.error('명령 등록 오류:', error.message); process.exit(1) }
  console.log(`가격모니터 큐잉: ${cmds.length}개 상품 · 세션 ${sid} · 미모니터 잔여 ${remaining}개`)
  console.log('확장이 페이싱대로 수집합니다(상품당 40~75초). 완료 후:')
  console.log(`  node scripts/coupang-pricewatch.mjs --compare ${sid}`)
}

// ── COMPARE: 수집 시세 vs 내 판매가 → 분류 → 누적 upsert ──
async function compare(sid) {
  if (!sid) { console.error('세션 id 필요: --compare <sessionId>'); process.exit(1) }
  const { data: cmds, error: ce } = await sb.from('jimscanner_scout_commands')
    .select('id, payload, status').eq('session_id', sid).eq('command_type', 'collect_list')
  if (ce) { console.error('명령 조회 오류:', ce.message); process.exit(1) }
  if (!cmds?.length) { console.log('해당 세션 명령 없음'); return }
  const pending = cmds.filter((c) => !['done', 'failed', 'cancelled'].includes(c.status)).length
  if (pending) console.log(`ℹ 수집 미완료 ${pending}/${cmds.length}개 — 완료분만 누적 반영(누적 upsert라 안전, 나머지는 다음 --compare 에서 채워짐)`)

  const batch = new Date().toISOString().slice(0, 16)
  const rows = [], adRows = []
  for (const c of cmds) {
    const pw = c.payload?._pw; if (!pw) continue
    if (c.status !== 'done') continue
    const { data: items, error: ie } = await sb.from('jimscanner_scout_products')
      .select('name, price').eq('command_id', c.id)
    if (ie) { console.error('수집결과 조회 오류:', ie.message); process.exit(1) }
    const matches = (items ?? []).map((it) => ({ ...it, s: sim(pw.name, it.name) })).filter((it) => it.s >= 0.4 && it.price > 0)
    let market_low = null, market_median = null, best = null
    if (matches.length) {
      const prices = matches.map((m) => m.price)
      market_low = Math.min(...prices)
      market_median = median(prices)
      best = matches.reduce((a, b) => (b.price < a.price ? b : a))
    }
    const my = pw.my_price, msp = pw.msp || 0
    let status = 'UNKNOWN', gap = null
    if (market_low != null) {
      gap = my - market_low
      status = my <= market_low * 1.03 ? 'WIN' : (market_median && my <= market_median * 1.05 ? 'PAR' : 'LOSE')
    }
    const cls = classify({ my, cost: pw.my_cost, msp, market_low, market_median, match_count: matches.length, sold_count: pw.sold_count, view_count: pw.view_count, est_fee: pw.est_fee })
    rows.push({
      seller_product_id: String(pw.spid), name: pw.name, keyword: c.payload?.keyword,
      my_price: my, my_cost: pw.my_cost || null, msp_price_krw: msp || null,
      market_low, market_median, match_count: matches.length, best_match_title: best?.name?.slice(0, 60) || null,
      gap, status, cost_over_market: pw.my_cost && market_low ? pw.my_cost > market_low : null,
      price_verdict: cls.verdict, reprice_target: cls.reprice_target, margin_at_target: cls.margin_at_target,
      ad_candidate: cls.ad_candidate, ad_score: cls.ad_score, ad_reason: cls.ad_reason,
      sold_count: pw.sold_count || 0, view_count: pw.view_count || 0,
      checked_at: new Date().toISOString(), batch,
    })
    if (cls.ad_candidate) {
      const feeRate = feeRateOf(my, pw.est_fee)
      const compPrice = cls.verdict === 'WIN' ? my : cls.reprice_target
      const m = marginAt(compPrice, pw.my_cost, feeRate)
      adRows.push({
        seller_product_id: String(pw.spid), name: pw.name, my_price: my, market_low,
        reprice_target: cls.reprice_target, margin_at_price: m, margin_pct: +(m / compPrice * 100).toFixed(1),
        view_count: pw.view_count || 0, sold_count: pw.sold_count || 0, match_count: matches.length,
        ad_score: cls.ad_score, ad_reason: cls.ad_reason, updated_at: new Date().toISOString(),
      })
    }
  }
  if (!rows.length) { console.log('비교할 완료 결과 없음 — 기존 스냅샷 보존, 종료'); return }
  // 누적 upsert(spid 기준) — repriced_at·ad_status 등 미포함 컬럼은 보존됨
  const { error } = await sb.from('jimscanner_coupang_pricewatch').upsert(rows, { onConflict: 'seller_product_id' })
  if (error) { console.error('발행 오류:', error.message); process.exit(1) }
  if (adRows.length) {
    // 광고후보 적재 — ad_status/note 는 미포함이라 사용자 설정 보존(신규는 default 'candidate')
    const { error: ae } = await sb.from('jimscanner_coupang_ad_products').upsert(adRows, { onConflict: 'seller_product_id' })
    if (ae) console.error('광고후보 적재 경고:', ae.message)
  }
  const cnt = (v) => rows.filter((r) => r.price_verdict === v).length
  console.log(`가격모니터 발행(누적): ${rows.length}건 반영`)
  console.log(`  WIN ${cnt('WIN')} / REPRICE ${cnt('REPRICE')} / STRUCTURAL ${cnt('STRUCTURAL')} / MSP_HOLE ${cnt('MSP_HOLE')} / UNKNOWN ${cnt('UNKNOWN')}`)
  console.log(`  광고후보 ${adRows.length}건 적재`)
}

// ── REPRICE: MSP 준수 가격조정(vendor-item prices API) ──
async function reprice() {
  const APPLY = has('apply')
  const MIN_MATCH = parseInt(val('min-match', '5')) || 5
  const MAX_DROP = parseFloat(val('max-drop', '0.45')) || 0.45
  const { data: cand, error } = await sb.from('jimscanner_coupang_pricewatch')
    .select('seller_product_id, name, my_price, msp_price_krw, market_low, reprice_target, margin_at_target, match_count, reprice_approved_at')
    .eq('price_verdict', 'REPRICE').is('repriced_at', null)
  if (error) { console.error('대상 조회 오류:', error.message); process.exit(1) }
  if (!cand?.length) { console.log('리프라이스 대상 없음(REPRICE 미반영분 0)'); return }
  console.log(`=== ${APPLY ? 'APPLY' : 'DRY-RUN'} | REPRICE 대상 ${cand.length}건 | 최소매칭 ${MIN_MATCH} · 최대인하 ${Math.round(MAX_DROP * 100)}% ===\n`)
  let ok = 0, fail = 0, review = 0
  for (const r of cand) {
    const my = r.my_price, target = r.reprice_target, msp = r.msp_price_krw || 0
    const dropPct = my > 0 ? (my - target) / my : 0
    const approved = !!r.reprice_approved_at
    const tag = `${r.seller_product_id} ${(r.name || '').slice(0, 22).padEnd(22)} ${String(my).padStart(6)}→${String(target).padStart(6)} (인하 ${Math.round(dropPct * 100)}%, 시세 ${r.market_low}, MSP ${msp}, 매칭 ${r.match_count}, 마진 ${r.margin_at_target})${approved ? '' : ' [미승인]'}`
    // 승인 게이트 — 관리자가 /admin/reprice 에서 승인한 건만 실제 적용
    if (APPLY && !approved) { console.log(`  ⏸ ${tag} — 미승인, 건너뜀`); review++; continue }
    // 안전 게이트
    if (!target || target >= my) { console.log(`  = ${tag} (내릴 것 없음)`); continue }
    if (!msp || target < msp) { console.log(`  ⛔ ${tag} — MSP 위반/누락, 건너뜀`); review++; continue }
    if ((r.match_count || 0) < MIN_MATCH) { console.log(`  ⚠ ${tag} — 매칭<${MIN_MATCH}(팩 오매칭 위험), 수동검토`); review++; continue }
    if (dropPct > MAX_DROP) { console.log(`  ⚠ ${tag} — 인하폭 과대(>${Math.round(MAX_DROP * 100)}%), 수동검토`); review++; continue }
    if ((r.margin_at_target ?? -1) < 0) { console.log(`  ⛔ ${tag} — 목표가 마진 음수, 건너뜀`); review++; continue }
    if (!APPLY) { console.log(`  [dry] ${tag}`); continue }
    try {
      // 판매중 상품은 vendor-item 가격변경(리스팅 강등 없음) — vendorItemId 는 GET 로 조회
      const d = await api('GET', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${r.seller_product_id}`)
      const items = d.body?.data?.items
      if (!items?.length) { console.log(`  ✗ ${tag} — GET 실패`); fail++; continue }
      if (items.length > 1) { console.log(`  ⚠ ${tag} — 옵션 ${items.length}개(단가 상이 가능), 수동검토`); review++; continue }
      const vid = items[0].vendorItemId
      if (!vid) { console.log(`  ✗ ${tag} — vendorItemId 없음`); fail++; continue }
      const rp = await api('PUT', `/v2/providers/seller_api/apis/api/v1/marketplace/vendor-items/${vid}/prices/${target}`, 'forceSalePriceAddUp=true')
      if (!apiSuccess(rp)) { console.log(`  ✗ ${tag} | ${JSON.stringify(rp.body).slice(0, 140)}`); fail++; continue }
      // DB 동기화 (listings + pricewatch)
      const feeRate = DEFAULT_FEE
      const patch = { list_price_krw: target, estimated_fee_krw: Math.round(target * feeRate), last_synced_at: new Date().toISOString() }
      await sb.from('jimscanner_coupang_listings').update(patch).eq('seller_product_id', r.seller_product_id)
      await sb.from('jimscanner_coupang_pricewatch').update({
        my_price: target, status: 'WIN', gap: r.market_low != null ? target - r.market_low : null,
        price_verdict: 'WIN', repriced_at: new Date().toISOString(),
      }).eq('seller_product_id', r.seller_product_id)
      console.log(`  ✓ ${tag}`); ok++
      await new Promise((s) => setTimeout(s, 400))
    } catch (e) { console.log(`  ✗ ${tag} ERROR ${e.message}`); fail++ }
  }
  console.log(`\n=== ${APPLY ? `성공 ${ok} / 실패 ${fail} / 검토필요 ${review}` : `DRY-RUN — 검토필요 ${review}건 제외 후 --apply 로 반영`} ===`)
}

// ── RECLASSIFY: 저장된 시세 + 최신 listings(MSP/조회/판매)로 재분류 (재수집 없이) ──
async function reclassify() {
  const { data: pw, error } = await sb.from('jimscanner_coupang_pricewatch')
    .select('seller_product_id, name, market_low, market_median, match_count')
  if (error) { console.error('pricewatch 조회 오류:', error.message); process.exit(1) }
  if (!pw?.length) { console.log('재분류할 행 없음'); return }
  const spids = pw.map((r) => r.seller_product_id)
  const { data: L, error: le } = await sb.from('jimscanner_coupang_listings')
    .select('seller_product_id, list_price_krw, dome_price_krw, msp_price_krw, estimated_fee_krw, sold_count, view_count')
    .in('seller_product_id', spids)
  if (le) { console.error('listings 조회 오류:', le.message); process.exit(1) }
  const byId = {}
  for (const l of L ?? []) byId[String(l.seller_product_id)] = l
  let n = 0, ad = 0
  for (const r of pw) {
    const l = byId[String(r.seller_product_id)]; if (!l) continue
    const my = l.list_price_krw, msp = l.msp_price_krw || 0
    const cls = classify({ my, cost: l.dome_price_krw, msp, market_low: r.market_low, market_median: r.market_median, match_count: r.match_count, sold_count: l.sold_count, view_count: l.view_count, est_fee: l.estimated_fee_krw })
    let status = 'UNKNOWN', gap = null
    if (r.market_low != null) { gap = my - r.market_low; status = my <= r.market_low * 1.03 ? 'WIN' : (r.market_median && my <= r.market_median * 1.05 ? 'PAR' : 'LOSE') }
    await sb.from('jimscanner_coupang_pricewatch').update({
      my_price: my, my_cost: l.dome_price_krw, msp_price_krw: msp || null,
      gap, status, cost_over_market: l.dome_price_krw && r.market_low ? l.dome_price_krw > r.market_low : null,
      price_verdict: cls.verdict, reprice_target: cls.reprice_target, margin_at_target: cls.margin_at_target,
      ad_candidate: cls.ad_candidate, ad_score: cls.ad_score, ad_reason: cls.ad_reason,
      sold_count: l.sold_count || 0, view_count: l.view_count || 0,
    }).eq('seller_product_id', r.seller_product_id)
    n++
    if (cls.ad_candidate) {
      const feeRate = feeRateOf(my, l.estimated_fee_krw)
      const compPrice = cls.verdict === 'WIN' ? my : cls.reprice_target
      const m = marginAt(compPrice, l.dome_price_krw, feeRate)
      await sb.from('jimscanner_coupang_ad_products').upsert({
        seller_product_id: String(r.seller_product_id), name: r.name, my_price: my, market_low: r.market_low,
        reprice_target: cls.reprice_target, margin_at_price: m, margin_pct: +(m / compPrice * 100).toFixed(1),
        view_count: l.view_count || 0, sold_count: l.sold_count || 0, match_count: r.match_count,
        ad_score: cls.ad_score, ad_reason: cls.ad_reason, updated_at: new Date().toISOString(),
      }, { onConflict: 'seller_product_id' })
      ad++
    }
  }
  const { data: after } = await sb.from('jimscanner_coupang_pricewatch').select('price_verdict')
  const cnt = (v) => (after ?? []).filter((x) => x.price_verdict === v).length
  console.log(`재분류 ${n}건 · 광고후보 ${ad}건`)
  console.log(`  WIN ${cnt('WIN')} / REPRICE ${cnt('REPRICE')} / STRUCTURAL ${cnt('STRUCTURAL')} / MSP_HOLE ${cnt('MSP_HOLE')} / UNKNOWN ${cnt('UNKNOWN')}`)
}

if (has('collect')) await collect()
else if (has('compare')) await compare(val('compare'))
else if (has('reprice')) await reprice()
else if (has('reclassify')) await reclassify()
else console.log('사용: --collect [--all] [--limit N]  |  --compare <sessionId> [--force]  |  --reprice [--apply]  |  --reclassify')
