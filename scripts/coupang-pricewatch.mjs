/**
 * 내 쿠팡 상품 아이템위너/시세 모니터링 — 스카우트 확장(collect_list, 페이싱)으로 안전하게.
 * 스토어프론트 직접 접근 금지: 확장이 사람처럼 검색·페이싱. 여기선 명령 큐잉 + 결과 비교만.
 *
 *   node scripts/coupang-pricewatch.mjs --collect [--all] [--limit 30]
 *       → 최근 판매 상품(또는 --all=전 노출상품) 워치리스트를 scout collect_list 로 큐잉. 세션id 출력.
 *   node scripts/coupang-pricewatch.mjs --compare <sessionId>
 *       → 수집된 시세 vs 내 판매가 비교 → jimscanner_coupang_pricewatch 발행.
 *
 * 워치리스트 = 최근 60일 판매된 상품(기본) 또는 노출중 전체(--all). 내 판매가·원가는 listings 에서.
 */
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
const args = process.argv.slice(2)
const has = (k) => args.includes(`--${k}`)
const val = (k, d) => { const i = args.indexOf(`--${k}`); return i > -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d }
const LIMIT = parseInt(val('limit', '30')) || 30

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

// ── 워치리스트 로드 ──
async function loadWatchlist() {
  let sellerIds = null
  if (!has('all')) {
    // 최근 60일 판매된 상품만
    const { data: ords, error: oe } = await sb.from('jimscanner_coupang_orders')
      .select('seller_product_id, product_name').gte('ordered_at', new Date(Date.now() - 60 * 864e5).toISOString())
    if (oe) { console.error('주문 조회 오류:', oe.message); process.exit(1) }
    sellerIds = [...new Set((ords ?? []).map((o) => o.seller_product_id).filter(Boolean))]
    if (!sellerIds.length) { console.log('최근 60일 판매 상품 없음 — --all 로 전 노출상품 모니터 가능'); return [] }
  }
  let q = sb.from('jimscanner_coupang_listings')
    .select('seller_product_id, registered_title, list_price_krw, dome_price_krw, displayable')
    .eq('displayable', true)
  if (sellerIds) q = q.in('seller_product_id', sellerIds)
  const { data, error: le } = await q
  if (le) { console.error('리스팅 조회 오류:', le.message); process.exit(1) }
  const rows = (data ?? []).filter((r) => r.registered_title && r.list_price_krw > 0)
  // dedup by seller_product_id
  const best = {}
  for (const r of rows) if (!best[r.seller_product_id]) best[r.seller_product_id] = r
  return Object.values(best).slice(0, LIMIT)
}

// ── COLLECT: scout collect_list 명령 큐잉 ──
async function collect() {
  const wl = await loadWatchlist()
  if (!wl.length) { console.log('워치리스트 없음'); return }
  const { data: sess, error: se } = await sb.from('jimscanner_scout_sessions')
    .insert({ title: `가격모니터 ${new Date().toISOString().slice(0, 10)}` }).select('id').single()
  if (se || !sess?.id) { console.error('세션 생성 오류:', se?.message || 'no id'); process.exit(1) }
  const sid = sess.id
  const now = new Date().toISOString()
  const cmds = wl.map((w) => ({
    session_id: sid, command_type: 'collect_list',
    payload: { keyword: toKeyword(w.registered_title), maxPages: 1, maxItems: 40, _pw: { spid: w.seller_product_id, name: w.registered_title, my_price: w.list_price_krw, my_cost: w.dome_price_krw } },
    status: 'queued', brain_notified_at: now,   // 두뇌 개입 차단(순수 수집)
  }))
  const { error } = await sb.from('jimscanner_scout_commands').insert(cmds)
  if (error) { console.error('명령 등록 오류:', error.message); process.exit(1) }
  console.log(`가격모니터 큐잉: ${cmds.length}개 상품 · 세션 ${sid}`)
  console.log('확장이 페이싱대로 수집합니다(상품당 40~75초). 완료 후:')
  console.log(`  node scripts/coupang-pricewatch.mjs --compare ${sid}`)
}

// ── COMPARE: 수집 시세 vs 내 판매가 → pricewatch ──
async function compare(sid) {
  if (!sid) { console.error('세션 id 필요: --compare <sessionId>'); process.exit(1) }
  const { data: cmds, error: ce } = await sb.from('jimscanner_scout_commands')
    .select('id, payload, status').eq('session_id', sid).eq('command_type', 'collect_list')
  if (ce) { console.error('명령 조회 오류:', ce.message); process.exit(1) }
  if (!cmds?.length) { console.log('해당 세션 명령 없음'); return }
  const pending = cmds.filter((c) => !['done', 'failed', 'cancelled'].includes(c.status)).length
  if (pending && !has('force')) {
    console.log(`⚠ 아직 수집 중인 명령 ${pending}/${cmds.length}개 — 완료 후 다시 실행하세요(부분 스냅샷 방지). 강제 진행: --force`)
    return
  }
  const batch = new Date().toISOString().slice(0, 16)
  const rows = []
  for (const c of cmds) {
    const pw = c.payload?._pw; if (!pw) continue
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
    const my = pw.my_price
    let status = 'UNKNOWN', gap = null
    if (market_low != null) {
      gap = my - market_low
      status = my <= market_low * 1.03 ? 'WIN' : (market_median && my <= market_median * 1.05 ? 'PAR' : 'LOSE')
    }
    rows.push({
      seller_product_id: pw.spid, name: pw.name, keyword: c.payload?.keyword,
      my_price: my, my_cost: pw.my_cost || null,
      market_low, market_median, match_count: matches.length, best_match_title: best?.name?.slice(0, 60) || null,
      gap, status, cost_over_market: pw.my_cost && market_low ? pw.my_cost > market_low : null,
      batch,
    })
  }
  if (!rows.length) { console.log('비교할 결과 없음 — 기존 스냅샷 보존, 종료'); return }
  // insert 먼저(새 batch) → 성공 시에만 이전 batch 삭제(insert 실패해도 기존 스냅샷 유지)
  const { error } = await sb.from('jimscanner_coupang_pricewatch').insert(rows)
  if (error) { console.error('발행 오류(기존 스냅샷 유지):', error.message); process.exit(1) }
  const { error: de } = await sb.from('jimscanner_coupang_pricewatch').delete().neq('batch', batch)
  if (de) console.error('이전 스냅샷 정리 경고(신규는 발행됨):', de.message)
  const win = rows.filter((r) => r.status === 'WIN').length, lose = rows.filter((r) => r.status === 'LOSE').length
  const structural = rows.filter((r) => r.cost_over_market).length
  console.log(`가격모니터 발행: ${rows.length}건 → WIN ${win} / PAR ${rows.filter((r) => r.status === 'PAR').length} / LOSE ${lose} / 미매칭 ${rows.filter((r) => r.status === 'UNKNOWN').length}`)
  console.log(`구조적 적자(원가>시세최저): ${structural}건`)
}

if (has('collect')) await collect()
else if (has('compare')) await compare(val('compare'))
else console.log('사용: --collect [--all] [--limit N]  |  --compare <sessionId>')
