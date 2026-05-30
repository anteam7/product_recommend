/**
 * 수요 스파이크 원인 자동 귀인 — 자생적 vs 외부유발 판별.
 *
 * 각 상품의 final_score 시계열(jimscanner_trends_scores)에서 급등(스파이크)을 탐지하고,
 * 귀인 윈도우(±2일) 내 타 소스 동시 이벤트를 교차조회해 원인을 라벨링한다.
 *   - tv      : naver_tvtime 동시 편성 키워드 매칭
 *   - hotdeal : quasarzone_sale 동시 등장
 *   - ad      : naver_blog 협찬/광고 버스트
 *   - organic : 외부 트리거 없음 (자생적 급등 = 가장 내구성 높은 진짜 신규수요)
 *
 * 결과는 jimscanner_trends_spike_attribution 에 upsert.
 *
 *   node scripts/attribute-spikes.mjs            # DRY-RUN (출력만)
 *   node scripts/attribute-spikes.mjs --apply    # DB 적용
 */
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
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
        v = v.slice(1, -1)
      return [l.slice(0, i).trim(), v]
    }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const APPLY = process.argv.includes('--apply')

// ── 튜닝 상수 ────────────────────────────────────────────────
const SPIKE_MIN_DELTA = 12 // 절대 점수 증가 최소치
const SPIKE_MIN_PCT = 25 // 상대 증가율 최소치(%)
const WINDOW_DAYS = 2 // 귀인 윈도우 ±N일
const DAY_MS = 24 * 60 * 60 * 1000

// ── 한글 토큰화 (간단 매칭용) ─────────────────────────────────
function tokens(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^가-힣a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2)
}
function overlapScore(aTokens, b) {
  const bt = new Set(tokens(b))
  if (bt.size === 0 || aTokens.length === 0) return 0
  let hit = 0
  for (const t of aTokens) if (bt.has(t)) hit++
  return hit / aTokens.length
}

async function main() {
  // 1) 점수 시계열 로드 (상품별 computed_at 오름차순)
  const { data: scores, error: scoreErr } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, trend_score, final_score, computed_at')
    .order('product_id', { ascending: true })
    .order('computed_at', { ascending: true })
    .limit(20000)
  if (scoreErr) throw new Error(`scores: ${scoreErr.message}`)

  const byProduct = new Map()
  for (const s of scores ?? []) {
    if (!byProduct.has(s.product_id)) byProduct.set(s.product_id, [])
    byProduct.get(s.product_id).push(s)
  }

  // 2) 상품명 로드 (매칭 키)
  const ids = [...byProduct.keys()]
  const nameById = new Map()
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500)
    const { data: prods } = await sb
      .from('jimscanner_trends_products')
      .select('id, canonical_name')
      .in('id', chunk)
    for (const p of prods ?? []) nameById.set(p.id, p.canonical_name)
  }

  // 3) 스파이크 탐지
  const spikes = []
  for (const [productId, series] of byProduct) {
    for (let i = 1; i < series.length; i++) {
      const before = Number(series[i - 1].final_score)
      const after = Number(series[i].final_score)
      const delta = after - before
      const deltaPct = before > 0 ? (delta / before) * 100 : delta > 0 ? 100 : 0
      if (delta >= SPIKE_MIN_DELTA && deltaPct >= SPIKE_MIN_PCT) {
        spikes.push({
          product_id: productId,
          name: nameById.get(productId) ?? '?',
          spike_at: series[i].computed_at,
          score_before: before,
          score_after: after,
          delta,
          delta_pct: Math.round(deltaPct * 10) / 10,
        })
      }
    }
  }
  console.log(`스파이크 탐지: ${spikes.length}건 (상품 ${byProduct.size}개 중)`)

  // 4) 이벤트 소스 사전 로드 (귀인 윈도우 전체를 커버)
  const allSpikeTimes = spikes.map((s) => new Date(s.spike_at).getTime())
  const minT = allSpikeTimes.length ? Math.min(...allSpikeTimes) - WINDOW_DAYS * DAY_MS : Date.now()
  const maxT = allSpikeTimes.length ? Math.max(...allSpikeTimes) + WINDOW_DAYS * DAY_MS : Date.now()
  const fromISO = new Date(minT).toISOString()
  const toISO = new Date(maxT).toISOString()

  // 4a) naver_tvtime 편성 키워드 (jimscanner_trends_keywords)
  const { data: tvRows } = await sb
    .from('jimscanner_trends_keywords')
    .select('keyword, collected_at')
    .eq('source', 'naver_tvtime')
    .gte('collected_at', fromISO)
    .lte('collected_at', toISO)
    .limit(10000)

  // 4b) quasarzone_sale 핫딜 (jimscanner_market_raw)
  const { data: dealRows } = await sb
    .from('jimscanner_market_raw')
    .select('title, metadata, captured_at')
    .eq('source', 'quasarzone_sale')
    .gte('captured_at', fromISO)
    .lte('captured_at', toISO)
    .limit(10000)

  // 4c) naver_blog 협찬 버스트 (jimscanner_market_raw)
  const { data: blogRows } = await sb
    .from('jimscanner_market_raw')
    .select('title, metadata, captured_at')
    .eq('source', 'naver_blog')
    .gte('captured_at', fromISO)
    .lte('captured_at', toISO)
    .limit(10000)

  const inWindow = (eventTime, spikeTime) =>
    Math.abs(new Date(eventTime).getTime() - new Date(spikeTime).getTime()) <= WINDOW_DAYS * DAY_MS

  // 5) 귀인
  const out = []
  for (const sp of spikes) {
    const nameTokens = tokens(sp.name)
    const evidence = { tv: [], hotdeal: [], ad: [] }

    for (const r of tvRows ?? []) {
      if (!inWindow(r.collected_at, sp.spike_at)) continue
      if (overlapScore(nameTokens, r.keyword) >= 0.4)
        evidence.tv.push({ keyword: r.keyword, at: r.collected_at })
    }
    for (const r of dealRows ?? []) {
      if (!inWindow(r.captured_at, sp.spike_at)) continue
      const t = r.metadata?.clean_title || r.title
      if (overlapScore(nameTokens, t) >= 0.4)
        evidence.hotdeal.push({ title: t, at: r.captured_at })
    }
    let adBurst = 0
    for (const r of blogRows ?? []) {
      if (!inWindow(r.captured_at, sp.spike_at)) continue
      const t = r.title || ''
      if (overlapScore(nameTokens, t) >= 0.4) adBurst++
    }
    // 협찬/광고 버스트: 윈도우 내 동일상품 블로그 글이 다수(>=3)면 광고 유발로 본다
    if (adBurst >= 3) evidence.ad.push({ burst_count: adBurst })

    // 우선순위: tv > hotdeal > ad > organic
    let trigger_type = 'organic'
    let confidence = 0
    if (evidence.tv.length > 0) {
      trigger_type = 'tv'
      confidence = Math.min(1, 0.6 + evidence.tv.length * 0.1)
    } else if (evidence.hotdeal.length > 0) {
      trigger_type = 'hotdeal'
      confidence = Math.min(1, 0.55 + evidence.hotdeal.length * 0.1)
    } else if (evidence.ad.length > 0) {
      trigger_type = 'ad'
      confidence = Math.min(1, 0.4 + adBurst * 0.1)
    } else {
      // 자생적: 외부 트리거가 전혀 없을수록 확신 높음
      trigger_type = 'organic'
      confidence = 0.7
    }

    out.push({
      product_id: sp.product_id,
      spike_at: sp.spike_at,
      score_before: sp.score_before,
      score_after: sp.score_after,
      delta: sp.delta,
      delta_pct: sp.delta_pct,
      trigger_type,
      trigger_confidence: Math.round(confidence * 100) / 100,
      evidence_refs: evidence,
      _name: sp.name,
    })
  }

  const counts = out.reduce((acc, r) => ((acc[r.trigger_type] = (acc[r.trigger_type] || 0) + 1), acc), {})
  console.log('귀인 결과:', counts)
  for (const r of out.slice(0, 15)) {
    console.log(
      `  [${r.trigger_type}] ${r._name} | ${r.score_before}→${r.score_after} (+${r.delta_pct}%) conf=${r.trigger_confidence}`,
    )
  }

  if (!APPLY) {
    console.log('\nDRY-RUN — DB 미반영. --apply 로 적용.')
    return
  }

  // 6) upsert
  const payload = out.map(({ _name, ...rest }) => rest)
  for (let i = 0; i < payload.length; i += 500) {
    const chunk = payload.slice(i, i + 500)
    const { error } = await sb
      .from('jimscanner_trends_spike_attribution')
      .upsert(chunk, { onConflict: 'product_id,spike_at' })
    if (error) throw new Error(`upsert: ${error.message}`)
  }
  console.log(`\n적용 완료: ${payload.length}건 upsert.`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
