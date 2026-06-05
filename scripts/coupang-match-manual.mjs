/**
 * 수동 등록 상품 → ggsan 도매 카탈로그 매칭 → 매입가/MSP/마진 채우기
 *
 * 수동 등록(source='manual') 또는 매입가 미상(dome_price_krw=0)인 listings를
 * ggsan_products 제목과 bigram 유사도로 매칭해서:
 *   - source_goods_no, dome_price_krw, msp_price_krw
 *   - source_shipping_fee_krw=0, outbound_shipping_fee_krw=3000 (위탁 dropship 1회분)
 *   - source_detail_url (매입처 링크)
 *   - estimated_margin_krw / pct (현재 쿠팡 판매가 기준 실마진)
 * 를 채운다. 쿠팡에는 아무것도 push하지 않음 (DB 내부 데이터만).
 *
 * 사용:
 *   node scripts/coupang-match-manual.mjs              # DRY-RUN (기본)
 *   node scripts/coupang-match-manual.mjs --min=0.5    # 유사도 임계값 (기본 0.5)
 *   node scripts/coupang-match-manual.mjs --apply      # 실제 DB 갱신 (임계값 이상만)
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(
  readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8')
    .split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

const APPLY = process.argv.includes('--apply')
const minArg = process.argv.find((a) => a.startsWith('--min='))
const MIN_SIM = minArg ? parseFloat(minArg.split('=')[1]) : 0.6  // 영양제 제목은 공용 토큰 많아 0.5는 오매칭 위험 → 0.6
const AMBIG_GAP = 0.08  // 1·2위 유사도 차가 이보다 작으면(절대값 0.85 미만일 때) 모호 → 보류

const OUTBOUND_SHIP = 3000   // 위탁 dropship: 배송 1회분만
const FEE_RATE = 0.106, VAT_DIVISOR = 11  // FEE_RATE: 기타 영양제(73137) 10.6%

// ── bigram(자모 무시, 한/영/숫자만) 유사도: pg_trgm와 유사한 근사 ──
const norm = (s) => (s || '').toLowerCase().replace(/[^가-힣a-z0-9]+/g, '')
function bigrams(s) { const t = norm(s); const g = new Set(); for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2)); return g }
function sim(a, b) { const A = bigrams(a), B = bigrams(b); if (!A.size || !B.size) return 0; let c = 0; for (const x of A) if (B.has(x)) c++; return (2 * c) / (A.size + B.size) }

function computeMargin(listPrice, dome) {
  const realCost = dome + OUTBOUND_SHIP
  const fee = Math.round(listPrice * FEE_RATE)
  const vat = Math.round(listPrice / VAT_DIVISOR)
  const margin = listPrice - realCost - fee - vat
  return { realCost, fee, vat, margin, marginPct: listPrice ? +(margin / listPrice * 100).toFixed(2) : 0 }
}

// ── 대상 listings ──
const { data: targets, error: e1 } = await sb
  .from('jimscanner_coupang_listings')
  .select('id, source, source_goods_no, registered_title, brand, list_price_krw, dome_price_krw, status')
  .or('source.eq.manual,dome_price_krw.eq.0')
if (e1) { console.error('listings 조회 실패:', e1.message); process.exit(1) }

// 이미 매칭된 것(source_goods_no 있고 dome>0)은 제외
const todo = targets.filter((r) => !(r.source_goods_no && r.dome_price_krw > 0))
console.log(`=== ${APPLY ? 'APPLY' : 'DRY-RUN'} | 대상 ${todo.length}건 | 임계 sim≥${MIN_SIM} ===\n`)

// ── ggsan 카탈로그 (Supabase 1000행 제한 회피: range 페이징으로 전량 로드) ──
const catalog = []
for (let from = 0; ; from += 1000) {
  const { data: page, error } = await sb
    .from('jimscanner_ggsan_products')
    .select('goods_no, title, brand, price_krw, min_sell_price_krw, detail_url')
    .order('goods_no', { ascending: true })
    .range(from, from + 999)
  if (error) { console.error('카탈로그 조회 실패:', error.message); process.exit(1) }
  catalog.push(...(page ?? []))
  if (!page || page.length < 1000) break
}
console.log(`ggsan 카탈로그 ${catalog.length}건 로드\n`)

let matched = 0, low = 0, applied = 0
for (const r of todo) {
  const ranked = (catalog ?? [])
    .map((p) => ({ p, s: sim(r.registered_title, p.title) }))
    .sort((a, b) => b.s - a.s)
  const best = ranked[0]
  const second = ranked[1]

  if (!best || best.s < MIN_SIM) {
    low++
    console.log(`✗ [${r.status}] ${(r.registered_title || '').slice(0, 48)}`)
    console.log(`   최고 후보 sim ${best ? best.s.toFixed(2) : '-'} | ${best?.p.title?.slice(0, 45) ?? '-'}  → 임계 미달, 스킵`)
    continue
  }
  // 1·2위가 근접하면(절대 유사도가 아주 높지 않은 한) 어느 게 맞는지 모호 → 수동 확인 위해 보류
  if (second && best.s < 0.85 && (best.s - second.s) < AMBIG_GAP) {
    low++
    console.log(`~ [${r.status}] ${(r.registered_title || '').slice(0, 48)}`)
    console.log(`   모호: 1위 ${best.s.toFixed(2)} (${best.p.goods_no}) ≈ 2위 ${second.s.toFixed(2)} (${second.p.goods_no}) → 보류(수동 확인)`)
    continue
  }

  matched++
  const dome = best.p.price_krw ?? 0
  const msp = best.p.min_sell_price_krw ?? 0
  const m = computeMargin(r.list_price_krw ?? 0, dome)
  const warn = (r.list_price_krw ?? 0) < m.realCost ? '  ⚠판매가<원가(손실)' : (m.marginPct < 10 ? '  ⚠마진<10%' : '')
  console.log(`✓ [${r.status}] ${(r.registered_title || '').slice(0, 48)}`)
  console.log(`   → sim ${best.s.toFixed(2)}${second ? ` (2위 ${second.s.toFixed(2)})` : ''} | ${best.p.goods_no} ${best.p.title?.slice(0, 45)}`)
  console.log(`   매입가 ${dome.toLocaleString()} / MSP ${msp.toLocaleString()} / 판매가 ${(r.list_price_krw ?? 0).toLocaleString()} → 실마진 ${m.margin.toLocaleString()}원 (${m.marginPct}%)${warn}`)

  if (APPLY) {
    const { error } = await sb.from('jimscanner_coupang_listings').update({
      source_goods_no: best.p.goods_no,
      dome_price_krw: dome,
      msp_price_krw: msp,
      source_shipping_fee_krw: 0,
      outbound_shipping_fee_krw: OUTBOUND_SHIP,
      source_detail_url: best.p.detail_url ?? null,
      brand: r.brand || best.p.brand || null,
      estimated_margin_krw: m.margin,
      estimated_margin_pct: m.marginPct,
      last_synced_at: new Date().toISOString(),
    }).eq('id', r.id)
    if (error) console.log(`   ✗ update 실패: ${error.message}`)
    else { applied++; console.log('   ✓ DB 갱신 완료') }
  }
  console.log()
}

console.log(`\n=== 결과 === 매칭 ${matched} | 임계미달 ${low} | ${APPLY ? `적용 ${applied}` : 'DRY-RUN (적용 안 함)'}`)
if (!APPLY && matched > 0) console.log('실제 적용: node scripts/coupang-match-manual.mjs --apply')
