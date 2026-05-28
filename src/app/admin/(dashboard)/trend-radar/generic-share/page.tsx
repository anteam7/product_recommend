import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import GenericShareScatter, { type ShareRow } from './GenericShareScatter'

export const dynamic = 'force-dynamic'

async function fetchShares(daysWindow: number): Promise<ShareRow[]> {
  const sb = createAdminClient()
  // RPC 는 마이그레이션(trends_v4_generic_share.sql) 적용 후 생성됨 → 타입 미생성, as any.
  const { data, error } = await (sb as any).rpc('jimscanner_trends_generic_share', {
    days_window: daysWindow,
  })
  if (error || !Array.isArray(data)) return []
  return (data as any[]).map((r) => ({
    category: r.category_top ?? 'other',
    generic_share: Number(r.generic_share ?? 0),
    trend_velocity: Number(r.trend_velocity ?? 0),
    total_volume: Number(r.total_volume ?? 0),
    generic_volume: Number(r.generic_volume ?? 0),
    branded_volume: Number(r.branded_volume ?? 0),
    keyword_count: Number(r.keyword_count ?? 0),
    generic_keyword_count: Number(r.generic_keyword_count ?? 0),
  }))
}

export default async function GenericSharePage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>
}) {
  const sp = await searchParams
  const days = Math.min(90, Math.max(7, Number(sp.days) || 30))
  const rows = await fetchShares(days)

  const goldCount = rows.filter((r) => r.generic_share >= 60 && r.trend_velocity > 0).length
  const brandedCount = rows.filter((r) => r.generic_share < 60).length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">위탁 적합도 게이트</h1>
          <p className="text-sm text-gray-500 mt-1">
            Generic vs Branded 수요점유 · X = generic_share (무명 수요 점유율) · Y = trend_velocity ·
            크기 = 전체 수요량
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <section className="grid grid-cols-2 md:grid-cols-3 gap-4">
        <Kpi label="카테고리" value={rows.length} hint={`${days}일 누적`} />
        <Kpi label="🏆 위탁 골드존" value={goldCount} hint="generic≥60 + 상승" />
        <Kpi label="🚫 브랜드 지배" value={brandedCount} hint="generic<60 위탁 불가" />
      </section>

      <div className="flex gap-2 text-sm">
        {[14, 30, 60].map((d) => (
          <Link
            key={d}
            href={`/admin/trend-radar/generic-share?days=${d}`}
            className={`px-3 py-1 rounded border ${
              days === d ? 'border-black font-semibold' : 'border-gray-200 text-gray-500 hover:text-black'
            }`}
          >
            {d}일
          </Link>
        ))}
      </div>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">아직 집계 데이터 없음</p>
          <p className="text-sm mt-2">
            키워드(volume_relative) 누적 + classify cron 의 brand 분류가 쌓이면 등장합니다.
            <br />
            마이그레이션 <code className="px-1 bg-gray-100 rounded">supabase/trends_v4_generic_share.sql</code> 적용 필요.
          </p>
        </div>
      ) : (
        <GenericShareScatter rows={rows} />
      )}

      <p className="text-xs text-gray-400">
        위탁판매는 도매 무명상품으로만 충족 가능 — 브랜드 검색이 지배하는 카테고리(좌측 회색)는 진입 불가,
        일반명 검색이 큰 골드존만 진입 가능합니다.
      </p>
    </div>
  )
}

function Kpi({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-3xl font-bold mt-1">{value.toLocaleString()}</div>
      <div className="text-xs text-gray-400 mt-1">{hint}</div>
    </div>
  )
}
