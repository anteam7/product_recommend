/**
 * 스카우트 수집 데이터 분석 — "판매자 적고 수요 있는 상품" 가설 검증.
 * 두뇌(Claude)가 직접 실행하는 도구. 원본: jimscanner_scout_products / jimscanner_scout_reviews.
 *
 *   node scripts/scout-analyze.mjs --command <명령id>     # 특정 수집 명령 건
 *   node scripts/scout-analyze.mjs --session <세션id>     # 세션 전체 수집분
 *   node scripts/scout-analyze.mjs --keyword "캠핑 의자"   # 키워드 최근 수집분
 *
 * 지표: 셀러 수·HHI(경쟁 밀도) / 리뷰 합·중앙값(수요량) / 최근 30일 리뷰 비율(수요 최근성 —
 *       저수요 vs 저경쟁 구분 핵심) / 로켓 점유율(직접 경쟁 난이도) / 트림 중앙값 가격.
 * 출력: data/scout/reports/<ts>-<slug>.md + 콘솔 요약(두뇌가 채팅으로 전달).
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
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

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : null }
const median = (arr) => { const a = arr.filter((n) => Number.isFinite(n)).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null }
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : null)

// ── 데이터 로드 ──
async function loadProducts() {
  let q = sb.from('jimscanner_scout_products').select('*')
  if (arg('command')) q = q.eq('command_id', arg('command'))
  else if (arg('session')) q = q.eq('session_id', arg('session'))
  else if (arg('keyword')) q = q.ilike('keyword', `%${arg('keyword')}%`)
  else { console.error('사용법: --command <id> | --session <id> | --keyword <kw>'); process.exit(1) }
  const out = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q.range(from, from + 999)
    if (error) { console.error('조회 오류:', error.message); process.exit(1) }
    out.push(...(data ?? []))
    if (!data || data.length < 1000) break
  }
  // 같은 상품이 목록+상세로 중복 수집됐으면 병합(상세 우선)
  const byId = new Map()
  for (const p of out) {
    const prev = byId.get(p.product_id)
    if (!prev) byId.set(p.product_id, p)
    else {
      const merged = { ...prev }
      for (const [k, v] of Object.entries(p)) if (v != null && (merged[k] == null || p.detail_collected_at)) merged[k] = v
      byId.set(p.product_id, merged)
    }
  }
  return [...byId.values()]
}

async function loadReviews(productIds) {
  const out = []
  for (let i = 0; i < productIds.length; i += 100) {
    const { data, error } = await sb.from('jimscanner_scout_reviews').select('product_id, review_date, rating')
      .in('product_id', productIds.slice(i, i + 100)).limit(10000)
    if (error) { console.error('리뷰 조회 오류:', error.message); break }
    out.push(...(data ?? []))
  }
  return out
}

// ── 분석 ──
const products = await loadProducts()
if (!products.length) { console.log('수집 데이터 없음 — 먼저 collect_list 를 실행하세요'); process.exit(0) }
const reviews = await loadReviews(products.map((p) => p.product_id))
const keyword = arg('keyword') || products.find((p) => p.keyword)?.keyword || '(무제)'

// 가격 (상·하위 10% 트림 중앙값 — market-price.mjs 방식)
const prices = products.map((p) => p.price).filter((n) => n > 0).sort((a, b) => a - b)
const lo = Math.floor(prices.length * 0.1), hi = Math.ceil(prices.length * 0.9)
const priceMedian = median(prices.slice(lo, hi))

// 수요량
const reviewCounts = products.map((p) => p.review_count ?? 0)
const reviewSum = reviewCounts.reduce((a, b) => a + b, 0)
const reviewMedian = median(reviewCounts) ?? 0

// 경쟁 밀도 — 셀러 정보는 collect_detail 로 채워짐(없으면 표본 부족으로 표기)
const sellers = products.map((p) => p.seller).filter(Boolean)
const sellerSet = new Set(sellers)
const sellerN = sellerSet.size
let hhi = null
if (sellers.length >= 5) {
  const cnt = {}
  for (const s of sellers) cnt[s] = (cnt[s] || 0) + 1
  hhi = Math.round(Object.values(cnt).reduce((a, c) => a + Math.pow(c / sellers.length, 2), 0) * 100) / 100
}

// 로켓 점유
const rocketShare = pct(products.filter((p) => /^rocket($|_fresh|_global)/.test(p.delivery_badge || '')).length, products.length) ?? 0
const growthShare = pct(products.filter((p) => p.delivery_badge === 'rocket_growth').length, products.length) ?? 0

// 수요 최근성 — 리뷰 작성일 분포
const now = Date.now()
const dated = reviews.filter((r) => r.review_date)
const recent30 = dated.filter((r) => now - Date.parse(r.review_date) <= 30 * 24 * 3600 * 1000)
const recent30Share = dated.length >= 10 ? pct(recent30.length, dated.length) : null
const latestReview = dated.map((r) => r.review_date).sort().pop() ?? null

// 상품별 최근성(리뷰 수집된 상품만)
const recentByPid = {}
for (const r of dated) {
  recentByPid[r.product_id] ??= { total: 0, recent: 0 }
  recentByPid[r.product_id].total++
  if (now - Date.parse(r.review_date) <= 30 * 24 * 3600 * 1000) recentByPid[r.product_id].recent++
}

// ── 판정 (계획서 초기값 — 데이터 쌓이면 보정) ──
const verdicts = []
const sellerVerdict = sellerN ? (sellerN <= 15 ? '저경쟁' : sellerN <= 40 ? '중간' : '과열') : '표본없음(collect_detail 필요)'
verdicts.push(`셀러 ${sellerN || '?'}개 → ${sellerVerdict}${hhi != null ? ` (HHI ${hhi})` : ''}`)
verdicts.push(`리뷰 중앙값 ${reviewMedian} → ${reviewMedian >= 30 ? '수요 있음' : '수요 약함'}`)
if (recent30Share != null) verdicts.push(`최근 30일 리뷰 ${recent30Share}% → ${recent30Share >= 20 ? '수요 살아있음' : '수요 식음(죽은 수요 의심)'}`)
else verdicts.push('리뷰 날짜 표본 부족 → collect_reviews 로 최근성 확인 필요 (저수요 vs 저경쟁 구분의 핵심)')
verdicts.push(`로켓(직매입) 점유 ${rocketShare}% → ${rocketShare <= 40 ? '진입 여지' : '쿠팡 직매입 우세(회피 권장)'} · 로켓그로스 ${growthShare}%`)

const opportunity = sellerN > 0 && sellerN <= 15 && reviewMedian >= 30 && (recent30Share == null || recent30Share >= 20) && rocketShare <= 40

// 후보 상품 점수: 수요(리뷰) 0.35 + 최근성 0.25 + 비로켓 0.15 + 가격대 적합 0.25(트림중앙값 ±60% 구간)
const maxReview = Math.max(...reviewCounts, 1)
const scored = products.map((p) => {
  const demand = Math.min((p.review_count ?? 0) / maxReview, 1)
  const rec = recentByPid[p.product_id]
  const recency = rec && rec.total >= 3 ? rec.recent / rec.total : 0.5 // 표본 없으면 중립
  const nonRocket = /^rocket($|_fresh|_global)/.test(p.delivery_badge || '') ? 0 : 1
  const priceFit = priceMedian && p.price ? (Math.abs(p.price - priceMedian) / priceMedian <= 0.6 ? 1 : 0.3) : 0.5
  const score = Math.round((demand * 0.35 + recency * 0.25 + nonRocket * 0.15 + priceFit * 0.25) * 100)
  return { ...p, _score: score, _recency: rec ? pct(rec.recent, rec.total) : null }
}).sort((a, b) => b._score - a._score)

// ── 출력 ──
const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)
const slug = keyword.replace(/[^\w가-힣]+/g, '-').slice(0, 30)
const dir = path.join(REPO, 'data', 'scout', 'reports')
mkdirSync(dir, { recursive: true })

const top = scored.slice(0, 20)
const md = `# 소싱 후보 분석 — ${keyword} (${new Date().toISOString().slice(0, 10)})

## 키워드 종합 판정: ${opportunity ? '✅ 기회(저경쟁+수요)' : '⚠ 조건 미충족'}
${verdicts.map((v) => `- ${v}`).join('\n')}
- 상품 ${products.length}개 · 리뷰 합 ${reviewSum.toLocaleString()} · 트림 중앙가 ${priceMedian?.toLocaleString() ?? '?'}원 · 최신 리뷰 ${latestReview ?? '?'}

## 가설 해석
"판매자 적고 리뷰 적당" = 기회이려면 **수요가 살아있어야** 한다(최근 30일 리뷰 비율 ≥20%).
판매자도 적고 최근 리뷰도 없으면 저경쟁이 아니라 **저수요**다.

## 후보 상위 ${top.length}
| # | 상품명 | 가격 | 리뷰수 | 평점 | 최근30일% | 배송 | 점수 | URL |
|---|---|---|---|---|---|---|---|---|
${top.map((p, i) => `| ${i + 1} | ${(p.name || '').slice(0, 40).replace(/\|/g, '/')} | ${p.price?.toLocaleString() ?? '?'} | ${p.review_count ?? '-'} | ${p.rating ?? '-'} | ${p._recency ?? '-'} | ${p.delivery_badge ?? '-'} | ${p._score} | ${p.url ?? ''} |`).join('\n')}

## 다음 단계
${sellerN === 0 ? '- collect_detail 로 판매자 표본 확보 (경쟁 밀도 판정의 전제)\n' : ''}${recent30Share == null ? '- 상위 후보 collect_reviews 로 수요 최근성 확인\n' : ''}- 후보를 도매꾹에서 검색해 공급가 확인 → 마진 계산 (수동)
`
const file = path.join(dir, `${ts}-${slug}.md`)
writeFileSync(file, md, 'utf8')

console.log(`[판정] ${opportunity ? '기회' : '조건 미충족'} — ${verdicts.join(' / ')}`)
console.log(`[후보 Top5]`)
for (const p of top.slice(0, 5)) console.log(`  ${p._score}점 | ${(p.name || '').slice(0, 45)} | ${p.price?.toLocaleString()}원 | 리뷰 ${p.review_count ?? '-'} | ${p.delivery_badge}`)
console.log(`[리포트] ${path.relative(REPO, file)}`)
