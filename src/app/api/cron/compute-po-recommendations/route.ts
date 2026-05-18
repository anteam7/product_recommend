import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { isAuthorizedCron } from '@/lib/market-signals'
import { recommendPO, DEFAULT_PIN_ASSUMPTIONS } from '@/lib/po-newsvendor'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * 핀별 Newsvendor PO 추천 일배치 cron.
 *
 * 모든 핀 (jimscanner_trends_pins) 에 대해 jimscanner_pin_po_recommendations 를 upsert.
 *
 * 입력 분석 (#13 KM 생존 / #17 반품률 / #18 가격탄력성 / #31 트렌드 반감기) 결과를
 * 핀별로 조회해야 하지만, 현 단계는 분석 산출물이 핀에 직접 연결돼 있지 않다.
 * 따라서 (a) 기존 row 의 assumptions 가 있으면 그것을 그대로 사용 (override 슬라이더로 들어온 값),
 * (b) 없으면 카테고리 기본값을 사용. 후속 PR 에서 분석 → 핀 매핑 RPC 추가 시 여기서 호출하면 된다.
 */
export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    return NextResponse.json(
      { error: 'NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 미설정' },
      { status: 500 },
    )
  }

  const admin = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const { data: pins, error: pinErr } = await admin
    .from('jimscanner_trends_pins')
    .select('keyword, source')
  if (pinErr) {
    return NextResponse.json({ error: pinErr.message }, { status: 500 })
  }
  const pinRows = (pins ?? []) as Array<{ keyword: string; source: string }>

  // 마이그레이션 직후엔 generated types 에 신규 테이블이 없으므로 any 캐스팅.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminAny = admin as any

  const { data: existing } = (await adminAny
    .from('jimscanner_pin_po_recommendations')
    .select('pin_keyword, pin_source, assumptions, unit_cost, price, return_rate, demand_p10, demand_p50, demand_p90')) as {
    data: Array<Record<string, unknown>> | null
  }

  const overrideMap = new Map<string, Record<string, unknown>>()
  for (const row of existing ?? []) {
    const k = `${row.pin_keyword as string}::${row.pin_source as string}`
    overrideMap.set(k, row)
  }

  type Upsert = {
    pin_keyword: string
    pin_source: string
    demand_p10: number
    demand_p50: number
    demand_p90: number
    return_rate: number
    unit_cost: number
    price: number
    recommended_qty: number
    expected_profit: number
    assumptions: Record<string, unknown>
    computed_at: string
  }

  const rows: Upsert[] = []
  let computedCount = 0
  for (const pin of pinRows) {
    const prev = overrideMap.get(`${pin.keyword}::${pin.source}`)
    const demandP10 = Number(prev?.demand_p10 ?? DEFAULT_PIN_ASSUMPTIONS.demandP10)
    const demandP50 = Number(prev?.demand_p50 ?? DEFAULT_PIN_ASSUMPTIONS.demandP50)
    const demandP90 = Number(prev?.demand_p90 ?? DEFAULT_PIN_ASSUMPTIONS.demandP90)
    const returnRate = Number(prev?.return_rate ?? DEFAULT_PIN_ASSUMPTIONS.returnRate)
    const unitCost = Number(prev?.unit_cost ?? DEFAULT_PIN_ASSUMPTIONS.unitCost)
    const price = Number(prev?.price ?? DEFAULT_PIN_ASSUMPTIONS.price)

    // 시드는 핀 키워드 기반 결정성 — 같은 입력이면 같은 결과.
    let seed = 0
    for (let i = 0; i < pin.keyword.length; i++) {
      seed = (seed * 31 + pin.keyword.charCodeAt(i)) >>> 0
    }
    const result = recommendPO({
      demandP10, demandP50, demandP90, returnRate, unitCost, price,
      samples: 2000,
      seed,
    })

    const prevAssumptions = (prev?.assumptions as Record<string, unknown> | undefined) ?? {}
    const assumptions: Record<string, unknown> = {
      ...prevAssumptions,
      critical_ratio: result.criticalRatio,
      contribution_margin: result.contributionMargin,
      effective_demand_p50: result.effectiveDemandP50,
      bootstrap: { p10: result.qtyP10, p50: result.qtyP50, p90: result.qtyP90, samples: result.bootstrapSamples },
      demand_source: prevAssumptions['demand_source'] ?? 'category_default',
      notes: prevAssumptions['notes'] ?? null,
    }

    rows.push({
      pin_keyword: pin.keyword,
      pin_source: pin.source,
      demand_p10: demandP10,
      demand_p50: demandP50,
      demand_p90: demandP90,
      return_rate: returnRate,
      unit_cost: unitCost,
      price,
      recommended_qty: result.recommendedQty,
      expected_profit: result.expectedProfit,
      assumptions,
      computed_at: new Date().toISOString(),
    })
    computedCount++
  }

  if (rows.length > 0) {
    const { error: upsertErr } = (await adminAny
      .from('jimscanner_pin_po_recommendations')
      .upsert(rows, { onConflict: 'pin_keyword,pin_source' })) as {
      error: { message: string } | null
    }
    if (upsertErr) {
      return NextResponse.json({ error: upsertErr.message, computed: computedCount }, { status: 500 })
    }
  }

  return NextResponse.json({ ok: true, computed: computedCount, pins: pinRows.length })
}
