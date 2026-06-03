import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import TimeToMarketScatter, { type T2MRow } from './TimeToMarketScatter'

export const dynamic = 'force-dynamic'

async function fetchTimeToMarket(): Promise<{ rows: T2MRow[]; error: string | null }> {
  const sb = createAdminClient()
  // RPC는 DB(supabase/trends_v4_timetomarket.sql)에 존재하나 generated 타입 미반영 — gen:types 시 캐스팅 제거
  const { data, error } = await sb.rpc('jimscanner_trends_timetomarket' as never, {
    reg_days: 2,
    default_lead: 7,
    floor_score: 20,
    lookback_days: 120,
    min_points: 2,
  } as never)
  if (error) return { rows: [], error: error.message }
  return { rows: (data ?? []) as T2MRow[], error: null }
}

export default async function TimeToMarketPage() {
  const { rows, error } = await fetchTimeToMarket()

  const lateCount = rows.filter((r) => r.verdict === 'late').length
  const safeCount = rows.filter((r) => r.verdict === 'safe').length
  const ampleCount = rows.filter((r) => r.verdict === 'ample').length
  const unknownCount = rows.filter((r) => r.verdict === 'unknown').length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">⏱ 타임투마켓 — 도착가능성 게이트</h1>
          <p className="text-sm text-gray-500 mt-1">
            수요 반감기 × 소싱 리드타임 — 지금 소싱하면 도착 시점에 트렌드 잔량이 남는가
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 개념 설명 */}
      <div className="rounded border border-indigo-200 bg-indigo-50 px-4 py-3 text-xs text-indigo-900 space-y-1">
        <div>
          <strong>위탁의 본질</strong>은 재고 선매입이 없어 &lsquo;수요 포착 → 주문 → 도착&rsquo;이다.
          트렌드가 반감기 짧은 플래시 패드면 도매 리드타임 안에 도착 전에 수요가 꺼져 사장 재고가 된다.
        </div>
        <div className="font-mono text-[11px] bg-white/60 rounded px-2 py-1">
          score(t) = peak·exp(−decay·Δt) · 반감기 = ln2/decay · 도착소요 = 리드타임 + 등록(2일) · 도착잔량 = exp(−decay·도착소요)
        </div>
      </div>

      {/* KPI 4종 */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="⛔ 늦음 (차단)" value={lateCount} color="text-red-700" border="border-red-300 bg-red-50" />
        <Kpi label="안전" value={safeCount} color="text-amber-700" border="border-amber-200 bg-amber-50" />
        <Kpi label="여유" value={ampleCount} color="text-emerald-700" border="border-emerald-200 bg-emerald-50" />
        <Kpi label="리드타임 미상" value={unknownCount} color="text-gray-600" border="border-gray-200" />
      </section>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          RPC 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            RPC <code>jimscanner_trends_timetomarket</code> 가 DB에 미적용 가능성.
            supabase/trends_v4_timetomarket.sql 적용 필요.
          </p>
        </div>
      )}

      {!error && rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">시계열 데이터 부족</div>
          <div className="text-xs text-gray-400">
            반감기 추정은 product별 최소 2개 이상의 score 관측이 필요합니다.
            매일 recompute cron 누적 후 자연 풍부해집니다.
          </div>
        </div>
      ) : (
        !error && <TimeToMarketScatter rows={rows} />
      )}
    </div>
  )
}

function Kpi({ label, value, color, border }: { label: string; value: number; color: string; border: string }) {
  return (
    <div className={`rounded border p-3 ${border}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${color}`}>{value.toLocaleString()}</div>
    </div>
  )
}
