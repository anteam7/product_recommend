import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import KeywordDemandScatter, { type DemandRow } from './KeywordDemandScatter'

export const dynamic = 'force-dynamic'

interface DbRow {
  keyword: string
  monthly_pc: number | null
  monthly_mobile: number | null
  monthly_total: number | null
  comp_idx: string | null
  ad_depth: number | null
  est_cpc: number | null
  collected_at: string
}

async function fetchData(): Promise<{ rows: DemandRow[] }> {
  const sb = createAdminClient()

  // 최신 row 만 (keyword 별 latest)
  // jimscanner_trends_keyword_demand 는 신규 마이그레이션 — generated types 에 아직 없어 as any 캐스팅
  const { data } = await (sb as any)
    .from('jimscanner_trends_keyword_demand')
    .select('keyword, monthly_pc, monthly_mobile, monthly_total, comp_idx, ad_depth, est_cpc, collected_at')
    .order('collected_at', { ascending: false })
    .limit(3000)

  const seen = new Set<string>()
  const rows: DemandRow[] = []
  for (const r of ((data ?? []) as unknown as DbRow[])) {
    if (seen.has(r.keyword)) continue
    seen.add(r.keyword)
    rows.push({
      keyword: r.keyword,
      monthly_pc: r.monthly_pc ?? 0,
      monthly_mobile: r.monthly_mobile ?? 0,
      monthly_total: r.monthly_total ?? (r.monthly_pc ?? 0) + (r.monthly_mobile ?? 0),
      comp_idx: r.comp_idx,
      ad_depth: r.ad_depth,
      est_cpc: r.est_cpc,
    })
  }
  return { rows }
}

export default async function KeywordDemandPage() {
  const { rows } = await fetchData()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">키워드 수요 × 획득비용</h1>
          <p className="text-sm text-gray-500 mt-1">
            네이버 검색광고 키워드도구 — 월간 절대 검색량(PC+모바일) × 예상 CPC. 좌상단 = 수요 크고 CPC 낮은 저비용 진입 키워드.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 데이터 없음. collect-naver-searchad cron 누적 후 다시 방문.
        </div>
      ) : (
        <KeywordDemandScatter rows={rows} />
      )}
    </div>
  )
}
