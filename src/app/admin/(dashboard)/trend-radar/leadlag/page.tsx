import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import LeadLagBoard from './LeadLagBoard'

export const dynamic = 'force-dynamic'

interface LeadLagRow {
  lead_category: string
  lag_category: string
  best_lag: number
  best_r: number
  n_overlap: number
  lead_accel: number
  lead_latest: number
  lag_latest: number
}

async function fetchLeadLag() {
  const sb = createAdminClient()
  const { data, error } = await sb.rpc('jimscanner_trends_category_leadlag' as never, {
    window_days: 45,
    min_overlap: 10,
    max_lag: 14,
  } as never)
  if (error) {
    return { rows: [] as LeadLagRow[], errorMessage: error.message }
  }
  return { rows: (data ?? []) as unknown as LeadLagRow[], errorMessage: null as string | null }
}

export default async function LeadLagPage() {
  const { rows, errorMessage } = await fetchLeadLag()

  // 후보 푸시 (callout 후보)
  const callouts = rows
    .filter((r) => Number(r.best_r) >= 0.5 && Number(r.best_lag) >= 3 && Number(r.lead_accel) > 0)
    .sort((a, b) => Number(b.best_r) - Number(a.best_r))
    .slice(0, 5)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold">카테고리 Lead-Lag 선행지표 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            (행=선행) → (열=후행) — 1~14일 lag cross-correlation (피어슨 r) ·
            r ≥ 0.5 & lag ≥ 3 & 최근 가속 &gt; 0 인 쌍이 매입 선행 시그널
          </p>
        </div>
        <Link
          href="/admin/trend-radar"
          className="text-sm text-gray-700 hover:text-black underline"
        >
          ← 대시보드
        </Link>
      </header>

      {errorMessage ? (
        <div className="rounded border border-red-300 bg-red-50 p-4 text-sm text-red-700">
          RPC 호출 실패: {errorMessage}
          <div className="mt-2 text-xs text-red-600">
            <code className="px-1 bg-white rounded">supabase/trends_v5_category_leadlag.sql</code>{' '}
            마이그레이션이 아직 적용되지 않았을 수 있습니다.
          </div>
        </div>
      ) : null}

      {/* 푸시 후보 callout */}
      {callouts.length > 0 && (
        <section className="rounded border border-amber-300 bg-amber-50 p-4">
          <div className="text-sm font-semibold mb-2">
            🔔 매입 선행 시그널 — 5일 뒤 뜰 가능성 (r ≥ 0.5 · lag ≥ 3 · 가속 &gt; 0)
          </div>
          <div className="space-y-1">
            {callouts.map((c) => (
              <div key={`${c.lead_category}->${c.lag_category}`} className="text-sm text-gray-800">
                <span className="font-semibold">{c.lead_category}</span>
                <span className="mx-2 text-gray-500">→ {Number(c.best_lag)}일 후 →</span>
                <span className="font-semibold">{c.lag_category}</span>
                <span className="ml-3 text-xs text-gray-600">
                  r={Number(c.best_r).toFixed(2)} · 가속={Number(c.lead_accel).toFixed(2)} ·
                  n={c.n_overlap}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 히트맵 + 시계열 */}
      {rows.length === 0 && !errorMessage ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">아직 lead-lag 시그널이 없습니다</p>
          <p className="text-sm mt-2">
            카테고리별 시계열이 최소 14일 이상 누적되어야 cross-correlation 이 산출됩니다.
          </p>
        </div>
      ) : (
        <LeadLagBoard rows={rows} />
      )}
    </div>
  )
}
