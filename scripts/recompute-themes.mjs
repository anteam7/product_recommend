/**
 * 동조 상승 테마 바스켓 — 그리디 상관 군집화.
 *
 * jimscanner_trends_scores 의 product 별 final_score 시계열을 모아,
 * 궤적(Δ 시퀀스) 의 피어슨 상관으로 '함께 상승하는' product 를 묶는다.
 * 동반언급이 아니라 독립 궤적의 동조 상승을 본다는 점이 핵심.
 *
 * recompute(scores) 직후 1회 호출. (scripts/run-crons.mjs 에서 recompute 뒤)
 *
 *   node scripts/recompute-themes.mjs            # DRY-RUN (콘솔 출력만)
 *   node scripts/recompute-themes.mjs --apply    # jimscanner_trends_themes 에 기록
 */
import { readFileSync } from 'node:fs'; import { fileURLToPath } from 'node:url'; import path from 'node:path'; import { createClient } from '@supabase/supabase-js'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/).filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }))
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const APPLY = process.argv.includes('--apply')

// ── 튜닝 상수 ──────────────────────────────────────────────
const MIN_POINTS = 4        // 상관 계산에 필요한 최소 공통 시점(Δ) 수
const CORR_THRESHOLD = 0.6  // 군집 편입 상관 임계값
const MIN_MEMBERS = 2       // 테마 최소 구성원 수
const MAX_PRODUCTS = 1500   // 안전 상한
const RECENT_POINTS = 12    // product 당 최근 N 시점만 사용

// ── 1) product 별 final_score 시계열 로드 ───────────────────
async function loadSeries() {
  const { data, error } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, final_score, computed_at')
    .order('computed_at', { ascending: true })
    .limit(50000)
  if (error) throw error

  // product_id → [{t, v}] (시간순)
  const byProduct = new Map()
  for (const r of data ?? []) {
    if (!byProduct.has(r.product_id)) byProduct.set(r.product_id, [])
    byProduct.get(r.product_id).push({ t: r.computed_at, v: Number(r.final_score) })
  }

  // 궤적 = 연속 final_score 의 Δ 시퀀스 (최근 RECENT_POINTS 시점)
  const series = new Map()
  for (const [pid, pts] of byProduct) {
    if (pts.length < MIN_POINTS + 1) continue
    const recent = pts.slice(-(RECENT_POINTS + 1))
    const deltas = []
    for (let i = 1; i < recent.length; i++) deltas.push(recent[i].v - recent[i - 1].v)
    if (deltas.length < MIN_POINTS) continue
    const momentum = deltas.reduce((a, b) => a + b, 0) / deltas.length  // 평균 상승률
    series.set(pid, { deltas, momentum, n: recent.length })
  }
  return series
}

// ── 2) 피어슨 상관 (공통 꼬리 길이로 정렬) ─────────────────
function pearson(a, b) {
  const n = Math.min(a.length, b.length)
  if (n < MIN_POINTS) return null
  const x = a.slice(-n), y = b.slice(-n)
  const mx = x.reduce((s, v) => s + v, 0) / n
  const my = y.reduce((s, v) => s + v, 0) / n
  let num = 0, dx = 0, dy = 0
  for (let i = 0; i < n; i++) {
    const a0 = x[i] - mx, b0 = y[i] - my
    num += a0 * b0; dx += a0 * a0; dy += b0 * b0
  }
  if (dx === 0 || dy === 0) return null
  return num / Math.sqrt(dx * dy)
}

// ── 3) 그리디 상관 군집화 ──────────────────────────────────
// momentum 높은 seed 부터, threshold 이상 상관인 미할당 product 흡수.
function cluster(series) {
  const ids = [...series.keys()].slice(0, MAX_PRODUCTS)
  // 상승 추진력 큰 순으로 seed 우선
  ids.sort((p, q) => series.get(q).momentum - series.get(p).momentum)

  const assigned = new Set()
  const clusters = []
  for (const seed of ids) {
    if (assigned.has(seed)) continue
    const members = [seed]
    const pairCorr = []
    for (const cand of ids) {
      if (cand === seed || assigned.has(cand)) continue
      const r = pearson(series.get(seed).deltas, series.get(cand).deltas)
      if (r != null && r >= CORR_THRESHOLD) {
        members.push(cand); pairCorr.push(r)
      }
    }
    if (members.length < MIN_MEMBERS) continue
    members.forEach((m) => assigned.add(m))
    clusters.push({ members, pairCorr })
  }
  return clusters
}

// ── 4) 집계 지표 + 라벨 ────────────────────────────────────
function clamp(v) { return Math.max(0, Math.min(100, v)) }

async function main() {
  const series = await loadSeries()
  console.log(`[themes] 궤적 보유 product: ${series.size}`)
  if (series.size === 0) { console.log('데이터 부족 — 종료'); return }

  const clusters = cluster(series)
  console.log(`[themes] 군집 ${clusters.length}개 발견`)
  if (clusters.length === 0) return

  // product 메타 (라벨·카테고리)
  const allMembers = [...new Set(clusters.flatMap((c) => c.members))]
  const { data: prods } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top')
    .in('id', allMembers)
  const meta = new Map((prods ?? []).map((p) => [p.id, p]))

  // computed_at 스탬프는 한 배치에서 동일하게 (theme_id 슬러그용)
  const stamp = new Date().toISOString()
  const day = stamp.slice(0, 10)

  const rows = clusters.map((c, idx) => {
    const memMeta = c.members.map((m) => meta.get(m)).filter(Boolean)
    const momentums = c.members.map((m) => series.get(m).momentum)
    const avgMomentum = momentums.reduce((a, b) => a + b, 0) / momentums.length
    const cats = new Set(memMeta.map((m) => m.category_top ?? 'all'))
    const cohesion = c.pairCorr.length ? c.pairCorr.reduce((a, b) => a + b, 0) / c.pairCorr.length : 0
    // breadth = 구성원 수 + 카테고리 다양성 가중 (0~100 정규화)
    const breadth = clamp(c.members.length * 8 + (cats.size - 1) * 12)
    // aggregate_momentum: Δ 평균을 0~100 로 스케일 (Δ ±5 → 50±50)
    const aggMomentum = clamp(50 + avgMomentum * 10)
    // 대표 라벨 = momentum 최고 구성원 이름 + 외 N
    const top = [...c.members].sort((p, q) => series.get(q).momentum - series.get(p).momentum)[0]
    const topName = meta.get(top)?.canonical_name ?? '?'
    const label = c.members.length > 1 ? `${topName} 外 ${c.members.length - 1}` : topName

    return {
      theme_id: `theme-${day}-${String(idx + 1).padStart(2, '0')}`,
      label,
      constituent_product_ids: c.members,
      aggregate_momentum: Number(aggMomentum.toFixed(2)),
      breadth: Number(breadth.toFixed(2)),
      cohesion: Number((cohesion * 100).toFixed(2)),
      member_count: c.members.length,
      category_spread: cats.size,
      components: {
        avg_delta: Number(avgMomentum.toFixed(3)),
        pair_corr: c.pairCorr.map((r) => Number(r.toFixed(3))),
        categories: [...cats],
      },
      computed_at: stamp,
    }
  })

  rows.sort((a, b) => b.aggregate_momentum - a.aggregate_momentum)
  for (const r of rows.slice(0, 15)) {
    console.log(`  ${r.theme_id}  momentum=${r.aggregate_momentum} breadth=${r.breadth} cohesion=${r.cohesion} (${r.member_count}개/${r.category_spread}cat) — ${r.label}`)
  }

  if (!APPLY) { console.log('\nDRY-RUN — --apply 로 기록'); return }

  const { error } = await sb.from('jimscanner_trends_themes').insert(rows)
  if (error) throw error
  console.log(`\n[themes] ${rows.length}개 테마 기록 완료 (computed_at=${stamp})`)
}

main().catch((e) => { console.error(e); process.exit(1) })
