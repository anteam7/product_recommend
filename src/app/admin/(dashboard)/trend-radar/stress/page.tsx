import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import {
  computeStress,
  resilienceBadge,
  type PinStressInputs,
  type StressResult,
} from '@/lib/trends/pin-stress'

export const dynamic = 'force-dynamic'

async function fetchRows(): Promise<StressResult[]> {
  const sb = createAdminClient()
  // 뷰는 마이그레이션 후 생성. types 가 아직 모르므로 캐스팅.
  const { data, error } = await (sb as any)
    .from('jimscanner_pin_stress_inputs')
    .select('*')
    .order('final_score', { ascending: false, nullsFirst: false })
    .limit(120)
  if (error || !data) return []
  return (data as PinStressInputs[]).map(computeStress)
}

function fmtKrw(n: number): string {
  if (!Number.isFinite(n)) return '-'
  return Math.round(n).toLocaleString('ko-KR') + '원'
}

function fmtPct(n: number): string {
  if (!Number.isFinite(n)) return '-'
  return n.toFixed(1) + '%'
}

export default async function StressBoardPage() {
  const rows = await fetchRows()
  const counts = {
    strong: rows.filter((r) => r.resilience === 'strong').length,
    normal: rows.filter((r) => r.resilience === 'normal').length,
    fragile: rows.filter((r) => r.resilience === 'fragile').length,
    unknown: rows.filter((r) => r.resilience === 'unknown').length,
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">핀 마진 스트레스</h1>
          <p className="text-sm text-gray-500 mt-1">
            환율 / 관세율 / 도매가 / 국제택배비 ±5·10·20% 시 마진 민감도. 모형은
            추정치 — 실제 통관·결제수수료는 별도. (BEP = 마진=0 임계 %)
          </p>
        </div>
        <Link
          href="/admin/trend-radar"
          className="text-sm text-gray-700 hover:text-black underline"
        >
          ← 대시보드
        </Link>
      </header>

      <div className="flex flex-wrap gap-2 text-xs">
        <span className="rounded border border-green-300 bg-green-50 px-2 py-1">
          내성↑ {counts.strong}
        </span>
        <span className="rounded border border-gray-300 bg-gray-50 px-2 py-1">
          보통 {counts.normal}
        </span>
        <span className="rounded border border-red-300 bg-red-50 px-2 py-1">
          취약 {counts.fragile}
        </span>
        <span className="rounded border border-yellow-300 bg-yellow-50 px-2 py-1">
          계산불가 {counts.unknown}
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">표시할 핀이 없음</p>
          <p className="text-sm mt-2">
            <code>supabase/pin_stress.sql</code> 마이그레이션을 적용했는지, 그리고
            jimscanner_trends_products / scores / supplier 테이블에 데이터가
            있는지 확인.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded border border-gray-200">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-600">
              <tr>
                <th className="px-3 py-2 text-left">상품</th>
                <th className="px-3 py-2 text-left">카테고리</th>
                <th className="px-3 py-2 text-right">매가</th>
                <th className="px-3 py-2 text-right">매입가</th>
                <th className="px-3 py-2 text-right">기본 마진</th>
                <th className="px-3 py-2 text-right">마진율</th>
                <th className="px-3 py-2 text-right">BEP(환율)</th>
                <th className="px-3 py-2 text-right">BEP(관세)</th>
                <th className="px-3 py-2 text-right">BEP(도매)</th>
                <th className="px-3 py-2 text-right">BEP(택배)</th>
                <th className="px-3 py-2 text-center">내성</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r) => {
                const b = resilienceBadge(r.resilience)
                return (
                  <tr key={r.product_id} className="hover:bg-gray-50">
                    <td className="px-3 py-2 font-medium">{r.name}</td>
                    <td className="px-3 py-2 text-xs text-gray-600">
                      {r.category_top ?? '-'}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      {fmtKrw(r.selling_price_krw)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      {fmtKrw(r.supplier_price_krw)}
                    </td>
                    <td
                      className={`px-3 py-2 text-right font-mono text-xs ${
                        r.base_margin_krw < 0 ? 'text-red-700' : ''
                      }`}
                    >
                      {fmtKrw(r.base_margin_krw)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      {fmtPct(r.base_margin_pct)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      {r.bep.fx == null ? '안전' : `+${r.bep.fx}%`}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      {r.bep.duty == null ? '안전' : `+${r.bep.duty}%`}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      {r.bep.supplier == null ? '안전' : `+${r.bep.supplier}%`}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      {r.bep.shipping == null ? '안전' : `+${r.bep.shipping}%`}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <span className={`inline-block rounded border px-2 py-0.5 text-xs ${b.cls}`}>
                        {b.label}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right">
                      {r.computable && (
                        <Link
                          href={`/admin/trend-radar/pins/${r.product_id}/stress`}
                          className="text-xs text-blue-600 hover:underline"
                        >
                          토네이도 →
                        </Link>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-gray-400">
        면책: 본 마진은 매가 − 매입가 − 관세(매입가 × 관세율) − VAT(매가 × 부가세율) − 택배 −
        부대비 의 단순 모형. 면세한도 / 특송 분류 / 결제수수료 / 마켓 수수료 제외. 실제
        통관·결제 시 차이가 발생할 수 있음. 비교 우선순위 결정용.
      </p>
    </div>
  )
}
