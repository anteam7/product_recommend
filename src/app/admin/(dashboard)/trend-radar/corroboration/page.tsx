import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import CorroborationBoard, { type AxisKey, type CorroborationRow, AXIS_ORDER } from './CorroborationBoard'

export const dynamic = 'force-dynamic'

interface ViewRow {
  keyword: string
  keyword_norm: string
  source_count: number
  diversity_index: number
  score: number
  axis_json: Record<string, { norm: number; raw: number }>
  refreshed_at: string
}

async function fetchData(): Promise<{ rows: CorroborationRow[]; refreshedAt: string | null }> {
  const sb = createAdminClient()

  // materialized view 가 아직 미적용일 수 있으므로 안전하게 `as never` 캐스팅.
  const res = await sb
    .from('jimscanner_trend_corroboration' as never)
    .select('keyword, keyword_norm, source_count, diversity_index, score, axis_json, refreshed_at')
    .order('score', { ascending: false })
    .limit(500)

  if (res.error || !res.data) {
    return { rows: [], refreshedAt: null }
  }

  const raw = res.data as unknown as ViewRow[]
  const rows: CorroborationRow[] = raw.map((r) => {
    const axes: Record<AxisKey, { norm: number; raw: number }> = {} as never
    for (const k of AXIS_ORDER) {
      const v = r.axis_json?.[k]
      axes[k] = { norm: Number(v?.norm ?? 0), raw: Number(v?.raw ?? 0) }
    }
    return {
      keyword: r.keyword,
      keyword_norm: r.keyword_norm,
      source_count: Number(r.source_count ?? 0),
      diversity_index: Number(r.diversity_index ?? 0),
      score: Number(r.score ?? 0),
      axes,
    }
  })

  const refreshedAt = raw[0]?.refreshed_at ?? null
  return { rows, refreshedAt }
}

export default async function CorroborationPage() {
  const { rows, refreshedAt } = await fetchData()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">🛰️ Corroboration 레이더</h1>
          <p className="text-sm text-gray-500 mt-1">
            지난 14일 — 독립 소스 8축 발화 강도(0~1) 정규화 + Herfindahl 다양성 보정 신뢰점수.
            단일 소스 스파이크는 score 낮음, 여러 소스가 외친 신호는 score 높음.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">아직 데이터 없음</p>
          <p className="text-sm mt-2">
            supabase/trends_corroboration.sql 마이그레이션 적용 후<br />
            <code className="px-1 bg-gray-100 rounded">node --env-file=.env.local scripts/refresh-corroboration.mjs</code>{' '}
            로 materialized view 를 채우세요.
          </p>
        </div>
      ) : (
        <>
          <div className="text-xs text-gray-500">
            {rows.length}개 키워드 · 마지막 refresh{' '}
            {refreshedAt ? new Date(refreshedAt).toLocaleString('ko-KR') : '—'}
          </div>
          <CorroborationBoard rows={rows} />
        </>
      )}
    </div>
  )
}
