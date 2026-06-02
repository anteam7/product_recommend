import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import SectorRotationGraph, { type SectorRow } from './SectorRotationGraph'

export const dynamic = 'force-dynamic'

const TOP_LABEL: Record<string, string> = {
  health: '헬스 (건강·영양)',
  living: '리빙 (생활·주방)',
  digital: '디지털 (가전·액세서리)',
}

async function fetchSectors(opts: { top: string | null }) {
  const sb = createAdminClient()
  // RPC는 DB(supabase/trends_v4_sector_rotation.sql)에 존재하나 generated 타입 미반영
  //   — `npm run gen:types` 시 캐스팅 제거.
  const { data, error } = await sb.rpc('jimscanner_trends_sector_rotation' as never, {
    cur_days: 7,
    prior_days: 7,
    group_mid: opts.top != null,
    top_filter: opts.top,
  } as never)

  if (error) {
    return { rows: [] as SectorRow[], error: error.message }
  }
  return { rows: ((data ?? []) as unknown as SectorRow[]), error: null }
}

export default async function SectorsPage({
  searchParams,
}: {
  searchParams: Promise<{ top?: string }>
}) {
  const sp = await searchParams
  const top = sp.top && TOP_LABEL[sp.top] ? sp.top : null
  const { rows, error } = await fetchSectors({ top })

  // breadth 가중 평균 (전체 시장 폭 헤드라인)
  const totalProducts = rows.reduce((a, r) => a + Number(r.product_count ?? 0), 0)
  const totalRising = rows.reduce((a, r) => a + Number(r.rising_count ?? 0), 0)
  const overallBreadth = totalProducts > 0 ? Math.round((1000 * totalRising) / totalProducts) / 10 : 0

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">
            섹터 로테이션 맵
            {top && <span className="text-gray-400 font-normal"> · {TOP_LABEL[top]} 드릴다운</span>}
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            상품이 아니라 <b>카테고리</b> 단위 거시 모멘텀 — 이번 주 어느 우물을 팔지 자원 배분 결정용.
            X = 상대 강도(level) · Y = 변화율(momentum) · 점 크기 = 상승 상품 비중(breadth %)
          </p>
        </div>
        <div className="flex gap-3 text-sm">
          {top && (
            <Link href="/admin/trend-radar/sectors" className="text-gray-700 hover:text-black underline">
              ← 전체 섹터
            </Link>
          )}
          <Link href="/admin/trend-radar" className="text-gray-700 hover:text-black underline">
            대시보드
          </Link>
        </div>
      </header>

      {error ? (
        <div className="rounded border border-amber-300 bg-amber-50 p-6 text-sm text-amber-800">
          RPC <code>jimscanner_trends_sector_rotation</code> 미적용 상태일 수 있습니다.
          <br />
          <code>supabase/trends_v4_sector_rotation.sql</code> 적용 후 다시 방문하세요.
          <div className="mt-2 text-xs text-amber-600">에러: {error}</div>
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          현재 윈도우(최근 7일)에 집계할 점수 시계열이 없습니다. cron 누적 후 다시 방문.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="rounded border border-gray-200 p-3">
              <div className="text-xs text-gray-500">집계 카테고리</div>
              <div className="text-xl font-bold">{rows.length}</div>
            </div>
            <div className="rounded border border-gray-200 p-3">
              <div className="text-xs text-gray-500">집계 상품 수</div>
              <div className="text-xl font-bold">{totalProducts}</div>
            </div>
            <div className="rounded border border-gray-200 p-3">
              <div className="text-xs text-gray-500">전체 시장 폭 (breadth)</div>
              <div className="text-xl font-bold">{overallBreadth}%</div>
            </div>
            <div className="rounded border border-gray-200 p-3">
              <div className="text-xs text-gray-500">윈도우</div>
              <div className="text-xl font-bold">7일 vs 직전 7일</div>
            </div>
          </div>

          <SectorRotationGraph rows={rows} drilldown={top != null} />
        </>
      )}
    </div>
  )
}
