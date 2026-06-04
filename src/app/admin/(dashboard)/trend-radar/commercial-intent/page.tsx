import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import CommercialIntentScatter, { type IntentRow } from './CommercialIntentScatter'

export const dynamic = 'force-dynamic'

// 마이그레이션(supabase/trends_commercial_intent_view.sql) 후 존재하는 뷰.
// 타입 미생성 상태이므로 행 형태를 로컬에 선언하고 `as any` 로 캐스팅한다.
interface IntentViewRow {
  keyword: string
  category_top: string | null
  search_index: number | null
  shopping_index: number | null
  commercial_intent_ratio: number | null
  zone: 'BUY' | 'AVOID' | 'UNPAIRED'
  collected_at: string
}

async function fetchData() {
  const sb = createAdminClient()

  const { data, error } = await (sb as any)
    .from('jimscanner_trends_commercial_intent')
    .select('keyword, category_top, search_index, shopping_index, commercial_intent_ratio, zone, collected_at')
    .order('commercial_intent_ratio', { ascending: false, nullsFirst: false })
    .limit(500)

  const view = (error ? [] : ((data ?? []) as IntentViewRow[]))

  // 산점도엔 두 지수가 모두 있는 paired 행만, unpaired 는 카운트만.
  const rows: IntentRow[] = view
    .filter((r) => r.search_index != null && r.shopping_index != null && r.zone !== 'UNPAIRED')
    .map((r) => ({
      keyword: r.keyword,
      category: r.category_top,
      search: Number(r.search_index),
      shopping: Number(r.shopping_index),
      ratio: Number(r.commercial_intent_ratio ?? 0),
      zone: r.zone === 'BUY' ? 'BUY' : 'AVOID',
    }))

  const unpaired = view.filter((r) => r.zone === 'UNPAIRED').length
  return { rows, unpaired, missing: !!error }
}

export default async function CommercialIntentPage() {
  const { rows, unpaired, missing } = await fetchData()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">검색의향 vs 쇼핑클릭 갭</h1>
          <p className="text-sm text-gray-500 mt-1">
            X = 검색관심도 · Y = 쇼핑클릭관심도 · 대각선 = 전환선 · 위(BUY) = 구매수요 / 아래(AVOID) = 정보성·비구매
          </p>
        </div>
        <Link href="/admin/trend-radar/opportunity" className="text-sm text-gray-700 hover:text-black underline">
          ← Opportunity Matrix
        </Link>
      </header>

      {missing ? (
        <div className="rounded border border-dashed border-amber-300 bg-amber-50 p-6 text-sm text-amber-800">
          뷰 <code>jimscanner_trends_commercial_intent</code> 가 아직 없습니다. 마이그레이션
          <code className="mx-1">supabase/trends_commercial_intent_view.sql</code>
          를 DB 에 적용하세요.
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          두 소스가 같은 키워드 축에서 아직 겹치지 않음 (paired 0건
          {unpaired > 0 ? ` · unpaired ${unpaired}건` : ''}). cron 누적 후 다시 방문.
        </div>
      ) : (
        <>
          <CommercialIntentScatter rows={rows} />
          <p className="text-xs text-gray-400">
            paired {rows.length}건 · unpaired {unpaired}건 (한쪽 소스만 존재 — 산점도 제외)
          </p>
        </>
      )}
    </div>
  )
}
