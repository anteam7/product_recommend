import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import type { Tables } from '@/lib/supabase'
import { PinPoCard } from './pin-po-card'

export const dynamic = 'force-dynamic'

type PinRow = Tables<'jimscanner_trends_pins'>

type PoRow = {
  pin_keyword: string
  pin_source: string
  demand_p10: number
  demand_p50: number
  demand_p90: number
  return_rate: number
  unit_cost: number
  price: number
  recommended_qty: number
  expected_profit: number
  assumptions: Record<string, unknown> | null
  computed_at: string | null
}

async function fetchData() {
  const sb = createAdminClient()

  const { data: pins } = await sb
    .from('jimscanner_trends_pins')
    .select('keyword, source, notes, pinned_at')
    .order('pinned_at', { ascending: false })

  // jimscanner_pin_po_recommendations 는 마이그레이션 적용 후에만 존재.
  // generated types 에 아직 없을 수 있어서 any 캐스팅으로 우회.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: poList } = (await (sb as any)
    .from('jimscanner_pin_po_recommendations')
    .select('*')) as { data: PoRow[] | null }

  const poByKey = new Map<string, PoRow>()
  for (const row of poList ?? []) {
    poByKey.set(`${row.pin_keyword}::${row.pin_source}`, row)
  }

  return { pins: (pins ?? []) as PinRow[], poByKey }
}

export default async function PinsPage() {
  const { pins, poByKey } = await fetchData()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">핀한 상품 후보</h1>
          <p className="text-sm text-gray-500 mt-1">
            위탁 검토 후보. 각 핀에 Newsvendor 기반 권장 발주량 위젯 부착.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {pins.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">핀한 항목 없음</p>
          <p className="text-sm mt-2">
            대시보드 / 디테일 페이지에서 핀 토글 (다음 PR-4.5).
            <br />
            현재는 기존 v3 트렌드 레이더의 키워드 핀만 노출.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {pins.map((p) => {
            const key = `${p.keyword}::${p.source}`
            const po = poByKey.get(key) ?? null
            return (
              <PinPoCard key={key} pin={p} po={po} />
            )
          })}
        </div>
      )}
    </div>
  )
}
