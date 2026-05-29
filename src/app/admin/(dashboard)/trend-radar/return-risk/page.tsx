import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { computeMarginWithReturnBuffer } from '@/lib/coupang/price'

export const dynamic = 'force-dynamic'

interface RiskRow {
  product_id: string
  return_risk_score: number
  base_component: number
  modifier_component: number
  signal_component: number
  gate: string
  expected_return_rate: number | null
  risk_label: string | null
  risk_components: Record<string, unknown>
}

// 손익 기대치 데모용 대표 가격 (실제 상품 가격 미연동 후보 단계 — 평균치로 게이트 효과 시연)
const DEMO_LIST_PRICE = 19900
const DEMO_DOME = 8000

const GATE_STYLE: Record<string, { label: string; cls: string }> = {
  high: { label: '🚫 고위험', cls: 'bg-red-100 text-red-700 border-red-300' },
  medium: { label: '⚠️ 중위험', cls: 'bg-amber-100 text-amber-700 border-amber-300' },
  low: { label: '✅ 저위험', cls: 'bg-emerald-100 text-emerald-700 border-emerald-300' },
}

async function fetchData() {
  const sb = createAdminClient()

  // 최신 risk row 만 (product_id 별 latest). 새 테이블이라 타입 미생성 → as any.
  const { data: risks } = await (sb as any)
    .from('jimscanner_return_risk')
    .select(
      'product_id, return_risk_score, base_component, modifier_component, signal_component, gate, expected_return_rate, risk_label, risk_components, computed_at',
    )
    .order('computed_at', { ascending: false })
    .limit(3000)

  const seen = new Set<string>()
  const latest: RiskRow[] = []
  for (const r of (risks ?? []) as (RiskRow & { computed_at: string })[]) {
    if (seen.has(r.product_id)) continue
    seen.add(r.product_id)
    latest.push(r)
  }

  const ids = latest.map((r) => r.product_id)
  if (ids.length === 0) return { rows: [] }

  const { data: prods } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top, category_mid')
    .in('id', ids)
  const byId = new Map((prods ?? []).map((p: any) => [p.id, p]))

  const rows = latest.map((r) => {
    const p = byId.get(r.product_id) ?? {}
    const m = computeMarginWithReturnBuffer(DEMO_LIST_PRICE, DEMO_DOME, r.return_risk_score)
    return {
      ...r,
      name: (p as any).canonical_name ?? '?',
      category_top: (p as any).category_top ?? '?',
      category_mid: (p as any).category_mid ?? null,
      baseMargin: m.margin,
      returnBuffer: m.returnBuffer,
      adjustedMargin: m.adjustedMargin,
      adjustedMarginPct: m.adjustedMarginPct,
    }
  })

  rows.sort((a, b) => b.return_risk_score - a.return_risk_score)
  return { rows }
}

export default async function ReturnRiskPage() {
  const { rows } = await fetchData()

  const high = rows.filter((r) => r.gate === 'high')
  const eroded = rows.filter((r) => r.adjustedMargin <= 0)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">반품 리스크 게이트</h1>
          <p className="text-sm text-gray-500 mt-1">
            위탁 마진을 잠식하는 반품·교환 리스크를 점수화(0~100) · 고위험 후보를 게이트로 거른다.
            손익은 데모 가격(판매 {DEMO_LIST_PRICE.toLocaleString()}원 / 도매{' '}
            {DEMO_DOME.toLocaleString()}원) 기준 반품 버퍼 차감 후 기대 마진.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 요약 카드 */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded border border-gray-200 p-4">
          <div className="text-xs text-gray-500">전체 후보</div>
          <div className="text-2xl font-bold">{rows.length}</div>
        </div>
        <div className="rounded border border-red-200 bg-red-50 p-4">
          <div className="text-xs text-red-600">🚫 고위험 (deprioritize)</div>
          <div className="text-2xl font-bold text-red-700">{high.length}</div>
        </div>
        <div className="rounded border border-amber-200 bg-amber-50 p-4">
          <div className="text-xs text-amber-600">반품 버퍼 차감 시 마진 ≤ 0</div>
          <div className="text-2xl font-bold text-amber-700">{eroded.length}</div>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 데이터 없음. <code>supabase/return_risk_gate.sql</code> 적용 후{' '}
          <code>scripts/compute-return-risk.mjs</code> 실행 시 채워짐.
        </div>
      ) : (
        <div className="overflow-x-auto rounded border border-gray-200">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs text-gray-500">
              <tr>
                <th className="px-3 py-2">게이트</th>
                <th className="px-3 py-2">상품</th>
                <th className="px-3 py-2">카테고리</th>
                <th className="px-3 py-2 text-right">리스크</th>
                <th className="px-3 py-2 text-right">예상반품률</th>
                <th className="px-3 py-2 text-right">기본마진</th>
                <th className="px-3 py-2 text-right">반품버퍼</th>
                <th className="px-3 py-2 text-right">보정 후 마진</th>
                <th className="px-3 py-2">구성 (base/mod/sig)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const g = GATE_STYLE[r.gate] ?? GATE_STYLE.low
                const erodedRow = r.adjustedMargin <= 0
                return (
                  <tr
                    key={r.product_id}
                    className={`border-t border-gray-100 ${r.gate === 'high' ? 'bg-red-50/40' : ''}`}
                  >
                    <td className="px-3 py-2">
                      <span className={`inline-block rounded border px-2 py-0.5 text-xs ${g.cls}`}>
                        {g.label}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <Link
                        href={`/admin/trend-radar/products/${r.product_id}`}
                        className="hover:underline"
                      >
                        {r.name}
                      </Link>
                      {r.risk_label && (
                        <span className="ml-2 text-xs text-gray-400">[{r.risk_label}]</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-gray-500">
                      {r.category_top}
                      {r.category_mid ? ` · ${r.category_mid}` : ''}
                    </td>
                    <td className="px-3 py-2 text-right font-mono font-semibold">
                      {r.return_risk_score}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-gray-600">
                      {r.expected_return_rate ?? '—'}%
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-gray-600">
                      {r.baseMargin.toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-amber-700">
                      −{r.returnBuffer.toLocaleString()}
                    </td>
                    <td
                      className={`px-3 py-2 text-right font-mono font-semibold ${
                        erodedRow ? 'text-red-600' : 'text-emerald-700'
                      }`}
                    >
                      {r.adjustedMargin.toLocaleString()}
                      <span className="ml-1 text-xs font-normal text-gray-400">
                        ({r.adjustedMarginPct}%)
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-gray-400">
                      {r.base_component}/{r.modifier_component}/{r.signal_component}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-gray-400">
        리스크 = 카테고리 베이스율(반품 평균) + 위험 수식어 빈도(사이즈·교환·변질 등) + 시장
        시그널(pain_point·하자·리콜). 게이트: ≥65 고위험 / 35~64 중위험 / &lt;35 저위험.
      </p>
    </div>
  )
}
