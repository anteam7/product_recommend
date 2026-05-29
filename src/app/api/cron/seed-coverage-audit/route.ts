import { NextResponse, type NextRequest } from 'next/server'
import { isAuthorizedCron } from '@/lib/market-signals'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { runSeedCoverageAudit } from '@/lib/trends/seed-coverage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// 시드 커버리지 갭 감사 스냅샷을 jimscanner_trends_seed_audit 에 적재.
// 입력단 자가교정 추이(커버리지·블라인드스팟·dead seed)를 시계열로 보존.
export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request))
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const audit = await runSeedCoverageAudit(30)

    // jimscanner_trends_seed_audit 는 generated 타입에 없으므로 as any 우회.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb = createAdminClient() as any
    const { error } = await sb.from('jimscanner_trends_seed_audit').insert({
      window_days: audit.windowDays,
      active_seed_count: audit.activeSeedCount,
      total_products: audit.totalProducts,
      total_signals: audit.totalSignals,
      product_coverage_rate: audit.productCoverageRate,
      signal_coverage_rate: audit.signalCoverageRate,
      blindspot_count: audit.blindspots.length,
      dead_seed_count: audit.deadSeeds.length,
      detail: {
        blindspots: audit.blindspots.slice(0, 30),
        deadSeeds: audit.deadSeeds.map((c) => ({
          id: c.seed.id,
          label: c.seed.label,
          source: c.seed.source,
          matchedProducts: c.matchedProducts,
          matchedSignals: c.matchedSignals,
        })),
      },
    })

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({
      ok: true,
      productCoverageRate: audit.productCoverageRate,
      signalCoverageRate: audit.signalCoverageRate,
      blindspots: audit.blindspots.length,
      deadSeeds: audit.deadSeeds.length,
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}
