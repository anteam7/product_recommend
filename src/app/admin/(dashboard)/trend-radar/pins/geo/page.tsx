import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { KR_REGIONS, klDivergenceVsUniform, topRegions } from '@/lib/trends/kr-regions'
import GeoHeatmap, { type PinSkew } from './GeoHeatmap'

export const dynamic = 'force-dynamic'

type RegionShareRow = {
  keyword: string
  region_code: string
  region_name: string
  share_ratio: number
  collected_at: string
}

async function fetchPinSkews(): Promise<PinSkew[]> {
  const sb = createAdminClient()

  // region_share 는 generated types 에 아직 없음 — as any.
  // 최근 30일 이내 데이터만 (한 키워드당 최신 collected_at 만 추리는 로직은 그룹핑으로 처리).
  const since = new Date(Date.now() - 30 * 24 * 3600_000).toISOString()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (sb as any)
    .from('jimscanner_trends_region_share')
    .select('keyword, region_code, region_name, share_ratio, collected_at')
    .gte('collected_at', since)
    .order('collected_at', { ascending: false })
    .limit(5000)

  if (error || !data) return []

  // 키워드별로 가장 최신 collected_at 의 17개 행만 사용.
  const latestByKeyword = new Map<string, { at: string; rows: RegionShareRow[] }>()
  for (const r of data as RegionShareRow[]) {
    const cur = latestByKeyword.get(r.keyword)
    if (!cur) {
      latestByKeyword.set(r.keyword, { at: r.collected_at, rows: [r] })
    } else if (r.collected_at === cur.at) {
      cur.rows.push(r)
    } else if (r.collected_at > cur.at) {
      latestByKeyword.set(r.keyword, { at: r.collected_at, rows: [r] })
    }
  }

  const pins: PinSkew[] = []
  for (const [keyword, { at, rows }] of latestByKeyword) {
    const shares: Record<string, number> = {}
    for (const row of rows) shares[row.region_code] = Number(row.share_ratio)
    const kl = klDivergenceVsUniform(shares)
    const top3 = topRegions(shares, 3)
    pins.push({ keyword, kl_divergence: kl, top3, shares, collected_at: at })
  }

  return pins
}

export default async function GeoPage() {
  const pins = await fetchPinSkews()
  const totalRegions = KR_REGIONS.length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">지역별 디맨드 편중도</h1>
          <p className="text-sm text-gray-500 mt-1">
            핀 × 17개 시도 검색 비중. 균등분포(1/{totalRegions}) 대비 KL-divergence 로 편중도 산출.
          </p>
        </div>
        <Link href="/admin/trend-radar/pins" className="text-sm text-gray-700 hover:text-black underline">
          ← 핀 목록
        </Link>
      </header>

      <div className="flex gap-2 border-b border-gray-200">
        <Link
          href="/admin/trend-radar/pins"
          className="px-3 py-2 text-sm rounded-t text-gray-500 hover:text-black"
        >
          리스트
        </Link>
        <span className="px-3 py-2 text-sm rounded-t bg-white border-x border-t border-gray-200 -mb-px font-semibold text-black">
          Geo 히트맵
        </span>
      </div>

      <GeoHeatmap pins={pins} />
    </div>
  )
}
