#!/usr/bin/env node
// 합치(Convergence) 보정 — 최신 jimscanner_trends_scores 행을 읽고,
// jimscanner_trends_source_convergence 에서 product 별 합치 점수를 가져와
// trend/supplier 보너스로 반영한 신규 score row 를 적재한다.
//
// 사용:
//   node scripts/recompute-scores.mjs
//
// 환경변수:
//   NEXT_PUBLIC_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 필요합니다.')
  process.exit(1)
}

const sb = createClient(url, key, { auth: { persistSession: false } })

// 보정 가중치:
//   trend_bonus    = (source_count - 2) * 5  (단, 최소 0, 최대 +25)
//   supplier_bonus = (source_count - 2) * 3  (단, 최소 0, 최대 +15)
// 합치=1 (단일 소스) 은 보너스 없음. 합치 ≥4 부터 가시적 부스트.
function bonus(sourceCount) {
  const t = Math.max(0, Math.min(25, (sourceCount - 2) * 5))
  const s = Math.max(0, Math.min(15, (sourceCount - 2) * 3))
  return { trend: t, supplier: s }
}

function clamp(n) {
  return Math.max(0, Math.min(100, Math.round(n)))
}

async function main() {
  console.log('[recompute-scores] 합치 보정 시작')
  const { data: conv, error: convErr } = await sb
    .from('jimscanner_trends_source_convergence')
    .select('*')
  if (convErr) throw convErr

  if (!conv || conv.length === 0) {
    console.log('[recompute-scores] convergence 결과 없음 — 종료')
    return
  }

  let updated = 0
  for (const c of conv) {
    // 가장 최근 점수 가져오기
    const { data: latest } = await sb
      .from('jimscanner_trends_scores')
      .select('*')
      .eq('product_id', c.product_id)
      .order('computed_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (!latest) continue

    const b = bonus(c.source_count)
    const newTrend = clamp(Number(latest.trend_score) + b.trend)
    const newSupplier = clamp(Number(latest.supplier_score) + b.supplier)
    // final = 단순 평균 (실제 가중치는 별도 파이프라인에서 재산출하지만 즉시 보정 반영을 위해 평균 사용)
    const newFinal = clamp(
      (newTrend + Number(latest.commerce_score) + newSupplier + Number(latest.competition_score)) / 4,
    )

    const components = { ...(latest.score_components ?? {}) }
    components.convergence = {
      source_count: c.source_count,
      sources: c.sources,
      convergence_score: c.convergence_score,
      trend_bonus: b.trend,
      supplier_bonus: b.supplier,
      applied_at: new Date().toISOString(),
    }

    const { error: insErr } = await sb.from('jimscanner_trends_scores').insert({
      product_id: c.product_id,
      trend_score: newTrend,
      commerce_score: latest.commerce_score,
      supplier_score: newSupplier,
      competition_score: latest.competition_score,
      final_score: newFinal,
      score_components: components,
    })
    if (insErr) {
      console.error('[recompute-scores] insert 실패', c.product_id, insErr.message)
      continue
    }
    updated++
  }

  console.log(`[recompute-scores] ${updated}/${conv.length} 상품 보정 완료`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
