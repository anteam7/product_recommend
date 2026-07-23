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

// 경쟁 판매자 수(collect_detail 로 채워짐) — 가설의 핵심 지표
const withSellerCount = products.filter((p) => Number.isFinite(p.competing_sellers))
const lowCompetition = withSellerCount.filter((p) => p.competing_sellers <= 3)

// 로켓 점유 (주의: 2026 DOM 변경으로 뱃지 감지 불안정 — 전량 'seller'면 미검출로 간주)
const rocketShare = pct(products.filter((p) => /^rocket($|_fresh|_global)/.test(p.delivery_badge || '')).length, products.length) ?? 0
const growthShare = pct(products.filter((p) => p.delivery_badge === 'rocket_growth').length, products.length) ?? 0
const badgeUnreliable = products.length > 0 && rocketShare === 0 && growthShare === 0

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
// 가설의 핵심: 경쟁 판매자 수(collect_detail). 있으면 이걸 1순위로, 없으면 미수집 표기.
if (withSellerCount.length) {
  const csMedian = median(withSellerCount.map((p) => p.competing_sellers))
  verdicts.push(`경쟁 판매자 수 중앙값 ${csMedian} (표본 ${withSellerCount.length}건) → 판매자 ≤3 인 저경쟁 상품 ${lowCompetition.length}건`)
} else {
  verdicts.push('경쟁 판매자 수 → 미수집(collect_detail 필요) · **가설의 "판매자 적음"은 이 지표 없이는 판정 불가**')
}
verdicts.push(`리뷰 중앙값 ${reviewMedian} → ${reviewMedian >= 30 ? '수요 있음' : '수요 약함'}`)
if (recent30Share != null) verdicts.push(`최근 30일 리뷰 ${recent30Share}% → ${recent30Share >= 20 ? '수요 살아있음' : '수요 식음(죽은 수요 의심)'}`)
else verdicts.push('리뷰 날짜 표본 부족 → collect_reviews 로 최근성 확인 필요 (저수요 vs 저경쟁 구분의 핵심)')
if (badgeUnreliable) verdicts.push('⚠ 로켓 뱃지 전량 미검출(2026 DOM 변경) → 경쟁강도 신호로 쓰지 말 것(셀렉터 수정 대기)')
else verdicts.push(`로켓(직매입) 점유 ${rocketShare}% · 로켓그로스 ${growthShare}%`)

const opportunity = withSellerCount.length > 0 && lowCompetition.length > 0 && reviewMedian >= 30

// 후보 상품 점수: 경쟁 판매자 수가 있으면 그걸 주지표로. 없으면 수요/최근성/가격 위주(경쟁은 미확인).
// 배지 미검출 시 nonRocket 는 변별력이 없으므로 가중치를 lowSeller/priceFit 로 재분배.
const maxReview = Math.max(...reviewCounts, 1)
const scored = products.map((p) => {
  const demand = Math.min((p.review_count ?? 0) / maxReview, 1)
  const rec = recentByPid[p.product_id]
  const recency = rec && rec.total >= 3 ? rec.recent / rec.total : 0.5 // 표본 없으면 중립
  // 저경쟁 신호: 경쟁 판매자 수 알면 적을수록 1(0→1.0, 3→0.5, 10+→0), 모르면 중립 0.5
  const lowSeller = Number.isFinite(p.competing_sellers)
    ? Math.max(0, 1 - p.competing_sellers / 6)
    : 0.5
  const priceFit = priceMedian && p.price ? (Math.abs(p.price - priceMedian) / priceMedian <= 0.6 ? 1 : 0.3) : 0.5
  const score = Math.round((demand * 0.3 + recency * 0.2 + lowSeller * 0.3 + priceFit * 0.2) * 100)
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
| # | 상품명 | 가격 | 리뷰수 | 판매자수 | 최근30일% | 점수 | URL |
|---|---|---|---|---|---|---|---|
${top.map((p, i) => `| ${i + 1} | ${(p.name || '').slice(0, 40).replace(/\|/g, '/')} | ${p.price?.toLocaleString() ?? '?'} | ${p.review_count ?? '-'} | ${Number.isFinite(p.competing_sellers) ? p.competing_sellers : '미수집'} | ${p._recency ?? '-'} | ${p._score} | ${p.url ?? ''} |`).join('\n')}

## 다음 단계
${withSellerCount.length === 0 ? '- **collect_detail 로 경쟁 판매자 수 확보** (가설 판정의 전제 — 지금은 미수집)\n' : ''}${recent30Share == null ? '- 상위 후보 collect_reviews 로 수요 최근성 확인\n' : ''}- 후보를 도매꾹에서 검색해 공급가 확인 → 마진 계산 (수동)
`
const file = path.join(dir, `${ts}-${slug}.md`)
writeFileSync(file, md, 'utf8')

console.log(`[판정] ${opportunity ? '기회' : '조건 미충족'} — ${verdicts.join(' / ')}`)
console.log(`[후보 Top5]`)
for (const p of top.slice(0, 5)) console.log(`  ${p._score}점 | ${(p.name || '').slice(0, 45)} | ${p.price?.toLocaleString()}원 | 리뷰 ${p.review_count ?? '-'} | 판매자 ${Number.isFinite(p.competing_sellers) ? p.competing_sellers : '?'}`)
console.log(`[리포트] ${path.relative(REPO, file)}`)
