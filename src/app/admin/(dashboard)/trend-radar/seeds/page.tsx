import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import SeedsTable, { type SeedYieldRow } from './SeedsTable'

export const dynamic = 'force-dynamic'

async function fetchData(): Promise<SeedYieldRow[]> {
  const sb = createAdminClient()
  // trends_v4_seed_yield 마이그레이션 적용 후 사용 가능 — 미적용 환경에서는 빈 배열 반환.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (sb.from('jimscanner_trends_seeds_yield_30d' as any) as any)
    .select('*')
    .order('source')
    .order('display_order')
  if (error) {
    console.error('[seeds-yield] view query failed:', error.message)
    return []
  }
  return (data ?? []) as SeedYieldRow[]
}

export default async function SeedsYieldPage() {
  const rows = await fetchData()

  const totalSeeds = rows.length
  const activeSeeds = rows.filter((r) => r.is_active).length
  const pruneCandidates = rows.filter((r) => r.prune_candidate).length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">시드 수율 감사</h1>
          <p className="text-sm text-gray-500 mt-1">
            시드(카테고리 cid / keyword group) 단위 30·90일 inserted, pin, Cost-per-Pin.
            ‘90일 0 pin & 30일 0 매칭 키워드’ 시드는 휴면 후보(빨간 행).
          </p>
        </div>
        <Link href="/admin/trend-radar/sources" className="text-sm text-gray-700 hover:text-black underline">
          ← 소스 헬스
        </Link>
      </header>

      <section className="flex gap-4 text-sm">
        <div className="rounded border border-gray-200 px-3 py-2">
          전체 시드 <strong className="ml-1">{totalSeeds}</strong>
        </div>
        <div className="rounded border border-gray-200 px-3 py-2">
          활성 <strong className="ml-1 text-green-700">{activeSeeds}</strong>
        </div>
        <div className="rounded border border-red-200 bg-red-50 px-3 py-2">
          휴면 후보 <strong className="ml-1 text-red-700">{pruneCandidates}</strong>
        </div>
      </section>

      <SeedsTable rows={rows} />

      <section className="rounded border border-dashed border-gray-300 p-4 text-xs text-gray-500 space-y-1">
        <div>
          <strong className="text-gray-700">컬럼 의미:</strong>{' '}
          inserted_30d/90d 는 trends_runs.triggered_seed_id 정확 어트리뷰션. matched/pin
          은 시드 config(name·keywords) ↔ trends_keywords/trends_pins best-effort 조인 — 신규 collector
          run 이 누적되며 갱신.
        </div>
        <div>
          <strong className="text-gray-700">Cost-per-Pin (inserted/pin, 90d):</strong>{' '}
          API/LLM 호출 단가 곱하면 실 비용. NULL = pin 0 (휴면 후보).
        </div>
      </section>
    </div>
  )
}
