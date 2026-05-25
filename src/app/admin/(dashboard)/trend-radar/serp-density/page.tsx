import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import SerpDensityRow from './SerpDensityRow'

export const dynamic = 'force-dynamic'

interface LatestRow {
  keyword: string
  serp_type: string
  ad_count: number
  organic_count: number
  total_count: number
  ad_density: number | null
  top3_ad_count: number
  top3_ad_ratio: number | null
  avg_ad_price_krw: number | null
  organic_top_domain: string | null
  organic_top_domain_kind: string | null
  weighted_ad_density: number | null
  collected_at: string
}

interface HistoryPoint {
  bucket_date: string
  ad_density: number | null
  weighted_ad_density: number | null
  top3_ad_ratio: number | null
  samples: number
}

async function fetchData() {
  const sb = createAdminClient()
  // 새 테이블/뷰는 generated types 에 없어 as any 캐스팅으로 우회 (DDL 적용 후 정식 타입화)
  const sbAny = sb as any

  const { data: latestRaw } = await sbAny
    .from('jimscanner_serp_density_latest')
    .select('*')
    .order('ad_density', { ascending: false, nullsFirst: false })
    .limit(200)

  const latest = (latestRaw ?? []) as LatestRow[]

  // 30일 추이를 상위 5개에 대해서만 fetch (페이지 부하 절감)
  const topForHistory = latest.slice(0, 5)
  const historyByKeyword: Record<string, HistoryPoint[]> = {}
  await Promise.all(
    topForHistory.map(async (r) => {
      const { data } = await sbAny.rpc('jimscanner_serp_density_history', {
        p_keyword: r.keyword,
        days_window: 30,
      })
      historyByKeyword[r.keyword] = (data ?? []) as HistoryPoint[]
    }),
  )

  return { latest, historyByKeyword }
}

export default async function SerpDensityPage() {
  const { latest, historyByKeyword } = await fetchData()

  const blocked = latest.filter((r) => (r.ad_density ?? 0) >= 0.6)
  const warning = latest.filter((r) => (r.ad_density ?? 0) >= 0.4 && (r.ad_density ?? 0) < 0.6)
  const clean = latest.filter((r) => (r.ad_density ?? 0) < 0.4)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">SERP 광고밀도 인덱스</h1>
          <p className="text-sm text-gray-500 mt-1">
            네이버 쇼핑 1페이지의 paid vs organic 슬롯 점유율. 위치 가중치 = top3 슬롯 2배.
          </p>
          <p className="text-xs text-gray-400 mt-1">
            ad_density ≥ 0.6 → organic 진입 불가로 핀 게이트 자동 디스카운트.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard label="측정 키워드" value={latest.length} hint="최신 스냅샷 기준" />
        <KpiCard
          label="🚫 BLOCKED"
          value={blocked.length}
          hint="ad_density ≥ 0.6"
          tone="red"
        />
        <KpiCard
          label="⚠️ WARN"
          value={warning.length}
          hint="0.4 ~ 0.6"
          tone="amber"
        />
        <KpiCard label="✅ CLEAN" value={clean.length} hint="< 0.4" tone="green" />
      </section>

      {latest.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">아직 측정 데이터 없음</p>
          <p className="text-sm mt-2">
            수집기 실행:
            <code className="ml-1 px-1 bg-gray-100 rounded">
              node --env-file=.env.local scripts/scan-serp-ad-density.mjs
            </code>
          </p>
        </div>
      ) : (
        <>
          {/* 추이 차트 — top 5 */}
          {Object.keys(historyByKeyword).length > 0 && (
            <section className="rounded border border-gray-200 p-4">
              <h2 className="text-sm font-semibold text-gray-700 mb-3">
                상위 5 키워드 30일 추이
              </h2>
              <div className="space-y-3">
                {Object.entries(historyByKeyword).map(([kw, points]) => (
                  <SparkRow key={kw} keyword={kw} points={points} />
                ))}
              </div>
            </section>
          )}

          {/* 키워드 리스트 — 광고밀도 desc */}
          <section className="rounded border border-gray-200">
            <div className="grid grid-cols-12 text-xs text-gray-500 px-3 py-2 border-b border-gray-100 bg-gray-50">
              <div className="col-span-3">키워드</div>
              <div className="col-span-3">광고밀도 (paid / total)</div>
              <div className="col-span-1 text-right">ad</div>
              <div className="col-span-1 text-right">organic</div>
              <div className="col-span-1 text-right">top3 ad</div>
              <div className="col-span-2">organic #1</div>
              <div className="col-span-1 text-right">측정시각</div>
            </div>
            {latest.map((r) => (
              <SerpDensityRow key={r.keyword} row={r} />
            ))}
          </section>
        </>
      )}
    </div>
  )
}

function KpiCard({
  label,
  value,
  hint,
  tone = 'gray',
}: {
  label: string
  value: number
  hint: string
  tone?: 'gray' | 'red' | 'amber' | 'green'
}) {
  const toneClass = {
    gray: 'border-gray-200',
    red: 'border-red-300 bg-red-50',
    amber: 'border-amber-300 bg-amber-50',
    green: 'border-green-300 bg-green-50',
  }[tone]
  return (
    <div className={`rounded border ${toneClass} p-4`}>
      <div className="text-xs text-gray-600">{label}</div>
      <div className="text-3xl font-bold mt-1">{value.toLocaleString()}</div>
      <div className="text-xs text-gray-500 mt-1">{hint}</div>
    </div>
  )
}

function SparkRow({ keyword, points }: { keyword: string; points: HistoryPoint[] }) {
  if (points.length === 0) {
    return (
      <div className="text-xs text-gray-400">
        <span className="font-medium text-gray-700">{keyword}</span> — 추이 데이터 없음
      </div>
    )
  }
  const max = 1
  const w = 320
  const h = 32
  const step = points.length > 1 ? w / (points.length - 1) : w
  const path = points
    .map((p, i) => {
      const x = i * step
      const y = h - (p.ad_density ?? 0) / max * h
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')

  const latest = points[points.length - 1]
  const latestD = latest.ad_density ?? 0
  const color = latestD >= 0.6 ? 'stroke-red-500' : latestD >= 0.4 ? 'stroke-amber-500' : 'stroke-green-500'

  return (
    <div className="flex items-center gap-4 text-sm">
      <div className="w-48 truncate font-medium">{keyword}</div>
      <svg width={w} height={h} className="overflow-visible">
        <line x1={0} y1={h - 0.6 * h} x2={w} y2={h - 0.6 * h} className="stroke-red-200" strokeDasharray="2 2" />
        <line x1={0} y1={h - 0.4 * h} x2={w} y2={h - 0.4 * h} className="stroke-amber-200" strokeDasharray="2 2" />
        <path d={path} className={`fill-none ${color}`} strokeWidth={1.5} />
      </svg>
      <div className="text-xs font-mono text-gray-600 w-28 text-right">
        {points.length} pts · 최근 {(latestD * 100).toFixed(0)}%
      </div>
    </div>
  )
}
