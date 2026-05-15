import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import type { Tables } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

type PinRow = Tables<'jimscanner_trends_pins'>

async function fetchData() {
  const sb = createAdminClient()

  // 기존 jimscanner_trends_pins (Phase A 부터 존재) 사용 — 향후 v4 product 단위 핀 테이블 추가 가능.
  const { data: pins } = await sb
    .from('jimscanner_trends_pins')
    .select('keyword, source, notes, pinned_at')
    .order('pinned_at', { ascending: false })

  const pinList = (pins ?? []) as PinRow[]

  // 각 pin keyword 를 jimscanner_trends_aliases 로 product_id 매핑 후
  // v_supply_diversification 에서 single_source_risk 여부 조회.
  const keywords = pinList.map((p) => p.keyword).filter(Boolean)
  const riskByKeyword = new Map<string, { product_id: string; risk_label: string }>()

  if (keywords.length > 0) {
    const { data: aliases } = await sb
      .from('jimscanner_trends_aliases')
      .select('alias, product_id')
      .in('alias', keywords)
    type A = { alias: string; product_id: string }
    const aliasMap = new Map<string, string>()
    for (const a of (aliases ?? []) as A[]) aliasMap.set(a.alias, a.product_id)

    const productIds = [...new Set([...aliasMap.values()])]
    if (productIds.length > 0) {
      const { data: divRows } = await (sb as any)
        .from('v_supply_diversification')
        .select('product_id, risk_label, single_source_risk')
        .in('product_id', productIds)
        .eq('single_source_risk', true)
      type D = { product_id: string; risk_label: string }
      const riskByPid = new Map<string, string>()
      for (const r of (divRows ?? []) as D[]) riskByPid.set(r.product_id, r.risk_label)

      for (const [alias, pid] of aliasMap.entries()) {
        const lbl = riskByPid.get(pid)
        if (lbl) riskByKeyword.set(alias, { product_id: pid, risk_label: lbl })
      }
    }
  }

  return { pins: pinList, riskByKeyword }
}

const RISK_LABEL: Record<string, string> = {
  no_supplier: '공급사 0',
  single_supplier: '단일 공급원',
  all_out_of_stock_or_limited: '재고 위험',
}

export default async function PinsPage() {
  const { pins, riskByKeyword } = await fetchData()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">핀한 상품 후보</h1>
          <p className="text-sm text-gray-500 mt-1">
            위탁 검토 후보. 메모 + 검토 상태 토글은 다음 버전.
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
        <div className="rounded border border-gray-200 divide-y divide-gray-100">
          {pins.map((p) => {
            const risk = riskByKeyword.get(p.keyword)
            return (
              <div key={`${p.source}::${p.keyword}`} className="px-4 py-3 grid grid-cols-12 items-center text-sm">
                <div className="col-span-6">
                  <div className="font-medium flex items-center gap-2 flex-wrap">
                    {risk ? (
                      <Link
                        href={`/admin/trend-radar/products/${risk.product_id}`}
                        className="hover:underline"
                      >
                        {p.keyword}
                      </Link>
                    ) : (
                      <span>{p.keyword}</span>
                    )}
                    {risk && (
                      <span className="text-[10px] px-2 py-0.5 rounded bg-amber-200 text-amber-900 font-semibold">
                        ⚠ {RISK_LABEL[risk.risk_label] ?? '단일 공급원'}
                      </span>
                    )}
                  </div>
                  {p.notes && <div className="text-xs text-gray-500 mt-1">{p.notes}</div>}
                </div>
                <div className="col-span-3 text-xs text-gray-500">{p.source}</div>
                <div className="col-span-3 text-right text-xs text-gray-400 font-mono">
                  {p.pinned_at?.slice(0, 16)}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
