#!/usr/bin/env node
/**
 * 버즈 분포 분석 — Sponsored vs Organic 판별.
 *
 * 각 canonical product (jimscanner_trends_products) 의 alias 로
 * market_raw(naver_blog, naver_news, quasarzone_sale) 매칭 buzz 의
 * 시간분포 특성치를 계산해 jimscanner_trends_buzz_quality 에 적재.
 *
 * 호출:
 *   node --env-file=.env.local scripts/buzz-quality-classify.mjs
 *
 * 의존:
 *   - supabase/buzz_quality.sql 적용 후 DB 에 RPC 존재
 *   - NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
})

const WINDOW_DAYS = parseInt(process.env.BUZZ_WINDOW_DAYS ?? '14', 10)
const MIN_SAMPLES = 4
const MAX_PRODUCTS_PER_RUN = parseInt(process.env.BUZZ_MAX_PRODUCTS ?? '500', 10)

// ─────────────────────────────────────────────────────────────
// 통계 헬퍼 — kurtosis (excess), top1_share, cluster_lag_h, burst_score
// ─────────────────────────────────────────────────────────────
function kurtosisExcess(values) {
  const n = values.length
  if (n < 4) return null
  const mean = values.reduce((s, v) => s + v, 0) / n
  let m2 = 0
  let m4 = 0
  for (const v of values) {
    const d = v - mean
    m2 += d * d
    m4 += d * d * d * d
  }
  m2 /= n
  m4 /= n
  if (m2 === 0) return 0
  return m4 / (m2 * m2) - 3
}

function quantileTimestamp(sortedMs, q) {
  if (sortedMs.length === 0) return null
  const idx = Math.min(sortedMs.length - 1, Math.floor(sortedMs.length * q))
  return sortedMs[idx]
}

// ─────────────────────────────────────────────────────────────
// product 단위 분류
// ─────────────────────────────────────────────────────────────
function classify({ kurtosis, top1Share, clusterLagH, sampleCount }) {
  if (sampleCount < MIN_SAMPLES) return { grade: 'insufficient', burstScore: 0 }

  // burst_score: 표식이 강할수록 sponsored 의심.
  //   - kurtosis 양수 클수록 한 날 집중
  //   - top1_share 가 높을수록 집중
  //   - cluster_lag_h 가 짧을수록 동시 적재 (paid push 의 표식)
  const kComp = Math.max(0, Math.min(1, (kurtosis ?? 0) / 6))            // 0~6+ → 0~1
  const tComp = Math.max(0, Math.min(1, (top1Share ?? 0)))                // 이미 0~1
  // cluster lag 24h 이하 = 1.0, 14*24h 이상 = 0.0
  const lagH = clusterLagH ?? WINDOW_DAYS * 24
  const lComp = Math.max(0, Math.min(1, 1 - lagH / (WINDOW_DAYS * 24)))
  const burstScore = +(kComp * 0.4 + tComp * 0.4 + lComp * 0.2).toFixed(4)

  let grade = 'organic'
  if (burstScore >= 0.65 && top1Share >= 0.5) grade = 'sponsored_suspect'
  else if (burstScore >= 0.4) grade = 'mixed'
  return { grade, burstScore }
}

// ─────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────
async function main() {
  const startedAt = Date.now()
  console.log(`[buzz-quality] start window=${WINDOW_DAYS}d max=${MAX_PRODUCTS_PER_RUN}`)

  const { data: products, error: prodErr } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name')
    .order('last_seen_at', { ascending: false })
    .limit(MAX_PRODUCTS_PER_RUN)

  if (prodErr) {
    console.error('product fetch error:', prodErr.message)
    process.exit(1)
  }

  let ok = 0
  let skip = 0
  let fail = 0

  for (const p of products ?? []) {
    try {
      // RPC 호출 — generated types 미반영으로 as any 캐스팅 동등 효과 위해 untyped 호출
      const { data: rawRows, error: rpcErr } = await sb.rpc(
        /** @type {any} */ ('jimscanner_buzz_raw_for_product'),
        /** @type {any} */ ({ p_product_id: p.id, p_window_days: WINDOW_DAYS }),
      )
      if (rpcErr) {
        console.error(`  [${p.canonical_name}] rpc error: ${rpcErr.message}`)
        fail++
        continue
      }
      const rows = (rawRows ?? [])
      const sampleCount = rows.length

      // source 별 카운트
      const sourceBreakdown = {}
      for (const r of rows) {
        sourceBreakdown[r.source] = (sourceBreakdown[r.source] ?? 0) + 1
      }

      // 일별 카운트 (KST 기준)
      const dayKey = (ts) => {
        const d = new Date(ts)
        const kst = new Date(d.getTime() + 9 * 3600_000)
        return kst.toISOString().slice(0, 10)
      }
      const dayCounts = new Map()
      for (const r of rows) {
        const k = dayKey(r.captured_at)
        dayCounts.set(k, (dayCounts.get(k) ?? 0) + 1)
      }
      const uniqueDays = dayCounts.size

      // window 전체 (등장 안 한 날도 0 으로 채워서 kurtosis 의 의미 강화)
      const dayValues = []
      const nowMs = Date.now()
      for (let i = 0; i < WINDOW_DAYS; i++) {
        const d = new Date(nowMs - i * 86400_000)
        const kst = new Date(d.getTime() + 9 * 3600_000)
        const k = kst.toISOString().slice(0, 10)
        dayValues.push(dayCounts.get(k) ?? 0)
      }

      const kurt = kurtosisExcess(dayValues)
      const top1 = sampleCount > 0
        ? Math.max(...dayValues) / sampleCount
        : 0

      // cluster_lag_h: 첫 등장 → 80% 적재 시점
      let clusterLagH = null
      if (sampleCount >= 2) {
        const sortedMs = rows
          .map((r) => new Date(r.captured_at).getTime())
          .sort((a, b) => a - b)
        const firstMs = sortedMs[0]
        const p80 = quantileTimestamp(sortedMs, 0.8)
        if (firstMs != null && p80 != null) {
          clusterLagH = +((p80 - firstMs) / 3_600_000).toFixed(2)
        }
      }

      const { grade, burstScore } = classify({
        kurtosis: kurt,
        top1Share: top1,
        clusterLagH,
        sampleCount,
      })

      const computedAt = new Date().toISOString()
      const { error: insErr } = await sb
        .from(/** @type {any} */ ('jimscanner_trends_buzz_quality'))
        .insert(/** @type {any} */ ({
          product_id: p.id,
          window_days: WINDOW_DAYS,
          sample_count: sampleCount,
          unique_days: uniqueDays,
          kurtosis: kurt,
          top1_share: top1 ? +top1.toFixed(4) : null,
          cluster_lag_h: clusterLagH,
          burst_score: burstScore,
          grade,
          source_breakdown: sourceBreakdown,
          computed_at: computedAt,
        }))

      if (insErr) {
        console.error(`  [${p.canonical_name}] insert error: ${insErr.message}`)
        fail++
        continue
      }

      if (sampleCount === 0) {
        skip++
      } else {
        ok++
        if (grade === 'sponsored_suspect' || grade === 'mixed') {
          console.log(`  [${p.canonical_name}] n=${sampleCount} d=${uniqueDays} kurt=${kurt?.toFixed(2)} top1=${top1.toFixed(2)} lag=${clusterLagH}h burst=${burstScore} → ${grade}`)
        }
      }
    } catch (e) {
      console.error(`  [${p.canonical_name}] exception:`, e?.message ?? e)
      fail++
    }
  }

  console.log(`[buzz-quality] done ok=${ok} skip=${skip} fail=${fail} elapsed=${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
}

main().catch((e) => {
  console.error('fatal:', e)
  process.exit(1)
})
