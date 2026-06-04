import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import GlobalLagScatter, { type LagRow } from './GlobalLagScatter'

export const dynamic = 'force-dynamic'

// jimscanner_trends_global_lag 뷰 row (supabase/trends_global_lag_view.sql)
// 뷰는 아직 generated types 에 없어 as any 캐스팅으로 조회.
interface LagViewRow {
  product_id: string
  canonical_name: string
  category_top: string
  alias_total: number
  overseas_alias_count: number
  first_source: string | null
  first_source_overseas: boolean
  overseas_ratio: number
  global_lead_score: number
  trend_score: number | null
  commerce_score: number | null
  supplier_score: number | null
  competition_score: number | null
  final_score: number | null
  computed_at: string | null
  ggsan_sourceable: boolean
}

async function fetchData(): Promise<{ rows: LagRow[]; total: number; sourceable: number }> {
  const sb = createAdminClient()

  // 뷰 미마이그레이션 환경에서도 빌드/렌더가 죽지 않도록 try-catch
  const { data, error } = await (sb as any)
    .from('jimscanner_trends_global_lag')
    .select('*')
    .order('global_lead_score', { ascending: false })
    .limit(1000)

  if (error || !data) return { rows: [], total: 0, sourceable: 0 }

  const view = data as LagViewRow[]
  const rows: LagRow[] = view
    .filter((v) => v.competition_score != null && v.trend_score != null) // 점수 산출된 것만 플롯
    .map((v) => ({
      id: v.product_id,
      name: v.canonical_name ?? '?',
      category: v.category_top ?? 'all',
      globalLead: Number(v.global_lead_score ?? 0),
      competition: Number(v.competition_score ?? 0),
      trend: Number(v.trend_score ?? 0),
      overseasRatio: Number(v.overseas_ratio ?? 0),
      firstSource: v.first_source,
      firstSourceOverseas: !!v.first_source_overseas,
      ggsanSourceable: !!v.ggsan_sourceable,
      final: Number(v.final_score ?? 0),
    }))

  return {
    rows,
    total: view.length,
    sourceable: view.filter((v) => v.ggsan_sourceable).length,
  }
}

export default async function GlobalLagPage() {
  const { rows, total, sourceable } = await fetchData()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">글로벌 선행 갭 레이더</h1>
          <p className="text-sm text-gray-500 mt-1">
            해외 베스트(알리·무신사)에서 검증됐는데 국내 쿠팡 경쟁은 비어있는 <strong>시차 차익</strong> 후보 ·
            X = 글로벌 선행도 · Y = 국내 경쟁 약함 · 크기 = trend · 검은 테두리 = ggsan 소싱 가능
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {total > 0 && (
        <div className="flex gap-3 text-sm">
          <span className="rounded border border-gray-200 px-3 py-1">
            해외 시그널 canonical <strong>{total}</strong>
          </span>
          <span className="rounded border border-gray-200 px-3 py-1">
            ggsan 소싱 가능 <strong>{sourceable}</strong>
          </span>
          <span className="rounded border border-gray-200 px-3 py-1">
            점수 산출(플롯) <strong>{rows.length}</strong>
          </span>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 데이터 없음. 해외 베스트 수집(aliex_best·musinsa_best)과 score 산출 누적 후 다시 방문.
          <div className="mt-2 text-xs text-gray-400">
            (뷰 <code>jimscanner_trends_global_lag</code> 마이그레이션 적용 여부도 확인)
          </div>
        </div>
      ) : (
        <GlobalLagScatter rows={rows} />
      )}
    </div>
  )
}
