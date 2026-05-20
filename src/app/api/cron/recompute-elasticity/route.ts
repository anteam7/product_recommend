import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { isAuthorizedCron } from '@/lib/market-signals'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

/**
 * Vercel Cron — 가격탄력성 ε 일 1회 재계산.
 * supabase/trends_v5_elasticity.sql 의 recompute_elasticity() RPC 호출.
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

  const startedAt = Date.now()
  // RPC 는 types/supabase.ts 미반영 → as any
  const { data, error } = await (admin as any).rpc('recompute_elasticity')

  if (error) {
    return NextResponse.json(
      {
        ok: false,
        executed_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
        error: error.message,
      },
      { status: 500 },
    )
  }

  const rows = Array.isArray(data) ? data : []
  const samples: number[] = rows
    .map((r: any) => (typeof r?.sample_n === 'number' ? r.sample_n : 0))
    .filter((n: number) => Number.isFinite(n))
  const epsilons: number[] = rows
    .map((r: any) => (typeof r?.epsilon === 'number' ? r.epsilon : null))
    .filter((v: number | null): v is number => v !== null && Number.isFinite(v))

  const elastic = epsilons.filter((e) => e < -1).length
  const mid = epsilons.filter((e) => e <= -0.3 && e >= -1).length
  const inelastic = epsilons.filter((e) => e > -0.3).length
  const samplesSum = samples.reduce((a, b) => a + b, 0)

  return NextResponse.json({
    ok: true,
    executed_at: new Date().toISOString(),
    duration_ms: Date.now() - startedAt,
    processed: rows.length,
    samples_total: samplesSum,
    epsilon_bands: { elastic, mid, inelastic },
  })
}
