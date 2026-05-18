import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import MarginWindowPinButton from './PinButton'

export const dynamic = 'force-dynamic'

interface MarginRow {
  product_id: string
  canonical_name: string
  category_top: string | null
  brand: string | null
  sources: string[] | null
  price_prev_krw: number | null
  price_curr_krw: number | null
  price_median_30d: number | null
  supply_drop_pct: number | null
  trend_delta_pt: number | null
  trend_score_latest: number | null
  final_score_latest: number | null
  expected_margin_expand_ppt: number | null
  estimated_window_close: string | null
  n_obs_30d: number | null
  is_margin_window: boolean
}

async function fetchData(opts: { showAll: boolean }) {
  const sb = createAdminClient()
  // view 가 schema 에 추가되기 전이라 `as never` 캐스팅으로 빌드 통과.
  let q = (sb.from('jimscanner_margin_windows' as never) as any)
    .select(
      'product_id, canonical_name, category_top, brand, sources, ' +
      'price_prev_krw, price_curr_krw, price_median_30d, ' +
      'supply_drop_pct, trend_delta_pt, trend_score_latest, final_score_latest, ' +
      'expected_margin_expand_ppt, estimated_window_close, n_obs_30d, is_margin_window',
    )
  if (!opts.showAll) q = q.eq('is_margin_window', true)
  q = q.limit(200)
  const { data, error } = await q
  return { rows: ((data as MarginRow[] | null) ?? []), error: error?.message ?? null }
}

function fmtKrw(v: number | null) {
  if (v == null) return <span className="text-gray-300">-</span>
  return `${v.toLocaleString()}원`
}

function fmtPct(v: number | null, sign = false) {
  if (v == null) return <span className="text-gray-300">-</span>
  const s = sign && v > 0 ? '+' : ''
  return `${s}${v.toFixed(1)}%`
}

function fmtDelta(v: number | null) {
  if (v == null) return <span className="text-gray-300">-</span>
  const sign = v > 0 ? '+' : ''
  const color = v > 1 ? 'text-emerald-600' : v < -1 ? 'text-rose-600' : 'text-gray-500'
  return <span className={color}>{sign}{v.toFixed(1)}pt</span>
}

export default async function MarginWindowPage({
  searchParams,
}: {
  searchParams: Promise<{ all?: string }>
}) {
  const sp = await searchParams
  const showAll = sp.all === '1'

  const { rows, error } = await fetchData({ showAll })
  const counted = rows.filter((r) => r.is_margin_window).length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">마진 확장 윈도우</h1>
          <p className="text-sm text-gray-500 mt-1">
            공급가 7d min 이 30d median 대비 5%+ 인하 + 트렌드 -5pt 이상 유지된 상품. 위탁 마진 일시 확장 후보.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={showAll ? '/admin/trend-radar/margin-window' : '/admin/trend-radar/margin-window?all=1'}
            className={`px-3 py-1 text-xs rounded ${
              showAll ? 'bg-gray-200 text-gray-800' : 'bg-amber-100 text-amber-800 font-semibold'
            }`}
          >
            {showAll ? '모든 상품 보기' : `윈도우만 (${counted})`}
          </Link>
          <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
            ← 대시보드
          </Link>
        </div>
      </header>

      {error && (
        <div className="rounded border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          view 미적용일 수 있음. supabase/trends_v4_margin_windows.sql 적용 후 재방문.
          <div className="text-xs text-rose-500 mt-1 font-mono">{error}</div>
        </div>
      )}

      {!error && rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          {showAll
            ? '집계 데이터 없음. supplier/ggsan 가격 시계열이 누적된 뒤 다시 방문.'
            : '현재 마진 확장 윈도우 후보 없음. "모든 상품 보기" 로 전체 집계 확인.'}
        </div>
      ) : (
        <div className="overflow-x-auto rounded border border-gray-200">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="text-left px-3 py-2">상품</th>
                <th className="text-left px-3 py-2">공급원</th>
                <th className="text-right px-3 py-2">이전가</th>
                <th className="text-right px-3 py-2">현재가(7d min)</th>
                <th className="text-right px-3 py-2">인하율</th>
                <th className="text-right px-3 py-2">수요변동</th>
                <th className="text-right px-3 py-2">예상 마진 ppt</th>
                <th className="text-right px-3 py-2">관측 수</th>
                <th className="text-right px-3 py-2">창 종료</th>
                <th className="text-right px-3 py-2">핀</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r) => (
                <tr key={r.product_id} className={r.is_margin_window ? 'bg-amber-50/50' : ''}>
                  <td className="px-3 py-2">
                    <div className="font-medium">{r.canonical_name}</div>
                    <div className="text-xs text-gray-400">
                      {r.category_top}{r.brand ? ` · ${r.brand}` : ''}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-500">
                    {(r.sources ?? []).join(', ') || '-'}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtKrw(r.price_prev_krw)}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-semibold">{fmtKrw(r.price_curr_krw)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    <span className={r.supply_drop_pct != null && r.supply_drop_pct >= 5 ? 'text-emerald-700 font-semibold' : 'text-gray-500'}>
                      {fmtPct(r.supply_drop_pct)}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{fmtDelta(r.trend_delta_pt)}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-emerald-700">
                    {fmtPct(r.expected_margin_expand_ppt, true)}
                  </td>
                  <td className="px-3 py-2 text-right text-xs text-gray-400 tabular-nums">{r.n_obs_30d ?? '-'}</td>
                  <td className="px-3 py-2 text-right text-xs text-gray-500 tabular-nums">
                    {r.estimated_window_close?.slice(0, 10) ?? '-'}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <MarginWindowPinButton
                      keyword={r.canonical_name}
                      source={`margin_window:${r.product_id}`}
                      notes={`인하 ${r.supply_drop_pct ?? '?'}% · 수요 ${r.trend_delta_pt ?? '?'}pt · 마진 +${r.expected_margin_expand_ppt ?? '?'}ppt 예상`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <footer className="text-xs text-gray-400 pt-4 border-t border-gray-100">
        <p>* 사전 집계 view: <code className="font-mono">jimscanner_margin_windows</code>.</p>
        <p>* 가격 시계열 소스: <code className="font-mono">jimscanner_trends_supplier</code> + <code className="font-mono">jimscanner_ggsan_price_history</code> (alias 매핑 시).</p>
        <p>* 갱신: <code className="font-mono">scripts/run-crons.mjs</code> 일 1회 (KST 03:30).</p>
      </footer>
    </div>
  )
}
