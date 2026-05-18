import { NextResponse, type NextRequest } from 'next/server'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { recommendPO, DEFAULT_PIN_ASSUMPTIONS } from '@/lib/po-newsvendor'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 핀 단위 PO 추천 override.
 * body { keyword, source, unit_cost?, price?, return_rate?, demand_p10?, demand_p50?, demand_p90? }
 * 한 슬라이더가 움직일 때마다 호출 → newsvendor 재계산 → 결과 + 가정 분해 반환.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdminEmail(user.email)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = (await request.json().catch(() => ({}))) as {
    keyword?: string
    source?: string
    unit_cost?: number
    price?: number
    return_rate?: number
    demand_p10?: number
    demand_p50?: number
    demand_p90?: number
  }
  if (!body.keyword || !body.source) {
    return NextResponse.json({ error: 'keyword, source required' }, { status: 400 })
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return NextResponse.json({ error: 'env missing' }, { status: 500 })
  const admin = createSupabaseClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  // 마이그레이션 직후엔 generated types 에 신규 테이블이 없으므로 any 캐스팅.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminAny = admin as any
  const { data: prev } = (await adminAny
    .from('jimscanner_pin_po_recommendations')
    .select('*')
    .eq('pin_keyword', body.keyword)
    .eq('pin_source', body.source)
    .maybeSingle()) as { data: Record<string, unknown> | null }

  const prevRow = prev ?? {}

  const demandP10 = Number(body.demand_p10 ?? prevRow.demand_p10 ?? DEFAULT_PIN_ASSUMPTIONS.demandP10)
  const demandP50 = Number(body.demand_p50 ?? prevRow.demand_p50 ?? DEFAULT_PIN_ASSUMPTIONS.demandP50)
  const demandP90 = Number(body.demand_p90 ?? prevRow.demand_p90 ?? DEFAULT_PIN_ASSUMPTIONS.demandP90)
  const returnRate = Number(body.return_rate ?? prevRow.return_rate ?? DEFAULT_PIN_ASSUMPTIONS.returnRate)
  const unitCost = Number(body.unit_cost ?? prevRow.unit_cost ?? DEFAULT_PIN_ASSUMPTIONS.unitCost)
  const price = Number(body.price ?? prevRow.price ?? DEFAULT_PIN_ASSUMPTIONS.price)

  let seed = 0
  for (let i = 0; i < body.keyword.length; i++) {
    seed = (seed * 31 + body.keyword.charCodeAt(i)) >>> 0
  }
  const result = recommendPO({
    demandP10, demandP50, demandP90, returnRate, unitCost, price,
    samples: 2000,
    seed,
  })

  const prevAssumptions = (prevRow.assumptions as Record<string, unknown> | undefined) ?? {}
  const assumptions: Record<string, unknown> = {
    ...prevAssumptions,
    critical_ratio: result.criticalRatio,
    contribution_margin: result.contributionMargin,
    effective_demand_p50: result.effectiveDemandP50,
    bootstrap: { p10: result.qtyP10, p50: result.qtyP50, p90: result.qtyP90, samples: result.bootstrapSamples },
    demand_source: 'manual_override',
    last_override_by: user.email ?? null,
  }

  const row = {
    pin_keyword: body.keyword,
    pin_source: body.source,
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
  }

  const { error } = (await adminAny
    .from('jimscanner_pin_po_recommendations')
    .upsert(row, { onConflict: 'pin_keyword,pin_source' })) as { error: { message: string } | null }

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true, recommendation: row })
}
