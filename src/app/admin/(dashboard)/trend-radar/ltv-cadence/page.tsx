import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { recommendedCacCeiling } from '@/lib/trends/repurchase-cadence'

export const dynamic = 'force-dynamic'

interface CadenceRow {
  id: string
  category_top: string
  category_mid: string | null
  brand: string | null
  cadence_days_p25: number | null
  cadence_days_p50: number
  cadence_days_p75: number | null
  ltv_proxy_krw: number | null
  sample_size: number
  confidence_score: number | null
  evidence_jsonb: Record<string, unknown> | null
  computed_at: string
}

const CATEGORY_LABEL: Record<string, string> = {
  health: '🩺 건강',
  beauty: '💄 뷰티',
  living: '🧴 생활',
  apparel: '👕 의류',
  digital: '📱 디지털',
  pet: '🐶 반려',
}

async function fetchCadence(): Promise<{ rows: CadenceRow[]; error: string | null }> {
  const sb = createAdminClient()
  // 신규 테이블 — generated 타입 미반영. `as any` 캐스팅.
  const { data, error } = await (sb as any)
    .from('jimscanner_trends_repurchase_cadence')
    .select('*')
    .order('cadence_days_p50', { ascending: true })
    .limit(200)
  if (error) return { rows: [], error: error.message }
  return { rows: (data ?? []) as CadenceRow[], error: null }
}

function cadenceLabel(days: number): string {
  if (days <= 35) return '🟢 빠른 재구매 (evergreen)'
  if (days <= 75) return '🟡 중간 재구매'
  if (days <= 180) return '🟠 느린 재구매'
  return '🔴 단발성 모델'
}

function fmtKrw(n: number | null | undefined): string {
  if (n == null) return '—'
  return `${Math.round(n).toLocaleString()}원`
}

export default async function LtvCadencePage({
  searchParams,
}: {
  searchParams: Promise<{ pin?: string; margin?: string; payback?: string }>
}) {
  const sp = await searchParams
  const { rows, error } = await fetchCadence()
  const pinId = sp.pin ?? ''
  const margin = Math.min(0.9, Math.max(0.05, parseFloat(sp.margin ?? '0.3')))
  const payback = Math.min(2, Math.max(0.1, parseFloat(sp.payback ?? '0.5')))

  const focused = pinId ? rows.find((r) => r.id === pinId) ?? null : null

  // 매트릭스 차원
  const maxCadence = Math.max(180, ...rows.map((r) => r.cadence_days_p50))
  const maxLtv = Math.max(50000, ...rows.map((r) => r.ltv_proxy_krw ?? 0))

  function pos(r: CadenceRow): { x: number; y: number; size: number } {
    const x = Math.min(95, (r.cadence_days_p50 / maxCadence) * 90 + 3) // 0~95%
    const ltv = r.ltv_proxy_krw ?? 0
    const y = 95 - Math.min(90, (ltv / maxLtv) * 90) // 위가 큰 LTV
    const size = 14 + Math.min(28, Math.sqrt(r.sample_size) * 2)
    return { x, y, size }
  }

  function buildHref(over: Record<string, string | null>): string {
    const params = new URLSearchParams()
    if (pinId) params.set('pin', pinId)
    if (sp.margin) params.set('margin', sp.margin)
    if (sp.payback) params.set('payback', sp.payback)
    for (const [k, v] of Object.entries(over)) {
      if (v == null || v === '') params.delete(k)
      else params.set(k, v)
    }
    const qs = params.toString()
    return '/admin/trend-radar/ltv-cadence' + (qs ? `?${qs}` : '')
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🔁 재구매 주기 · LTV 매트릭스</h1>
          <p className="text-sm text-gray-500 mt-1">
            카테고리별 재구매 주기와 LTV proxy. 권장 광고 CAC 상한 자동 산출.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <div className="rounded border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
        <strong>방법론</strong> · (1) trends_keywords 자기상관(같은 키워드 재등장 간격) +
        (2) forwarder_reviews 의 재구매 토픽 빈도 + (3) 카테고리 벤치마크 seed 의 가중 평균.
        sample_size 50 미만이면 시드 추정에 가깝다.
      </div>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          DB 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            테이블 <code>jimscanner_trends_repurchase_cadence</code> 가 DB 에 적용 안 됐을 가능성. supabase/trends_v4_repurchase_cadence.sql 적용 필요.
          </p>
        </div>
      )}

      {!error && rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          데이터 없음. /api/cron/recompute-cadence 를 한 번 실행하라.
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* 매트릭스 */}
          <div className="lg:col-span-2 space-y-3">
            <div className="rounded border border-gray-200 bg-white p-4">
              <div className="relative" style={{ height: 360 }}>
                {/* 축 */}
                <div className="absolute inset-0 border-l-2 border-b-2 border-gray-300" />
                {/* Y label */}
                <div className="absolute -left-1 top-0 text-[10px] text-gray-500 -rotate-90 origin-top-left translate-y-32 -translate-x-2">
                  LTV proxy (원) →
                </div>
                {/* X label */}
                <div className="absolute bottom-[-22px] right-2 text-[10px] text-gray-500">
                  재구매 주기 p50 (일) →
                </div>
                {/* 4분면 안내 */}
                <div className="absolute top-2 left-2 text-[10px] text-green-700">
                  ◤ 고LTV · 빠른재구매 = 광고 헤드룸 큼
                </div>
                <div className="absolute bottom-2 right-2 text-[10px] text-gray-400">
                  ◢ 저LTV · 느린재구매 = 단발성
                </div>
                {/* 버블 */}
                {rows.map((r) => {
                  const p = pos(r)
                  const isFocused = focused?.id === r.id
                  return (
                    <Link
                      key={r.id}
                      href={buildHref({ pin: r.id })}
                      style={{
                        position: 'absolute',
                        left: `${p.x}%`,
                        top: `${p.y}%`,
                        width: p.size,
                        height: p.size,
                        marginLeft: -p.size / 2,
                        marginTop: -p.size / 2,
                      }}
                      className={`rounded-full border-2 flex items-center justify-center text-[9px] font-semibold transition-all ${
                        isFocused
                          ? 'bg-amber-400 border-amber-700 text-amber-900 z-10 scale-125'
                          : 'bg-blue-200/70 border-blue-500 text-blue-900 hover:bg-blue-300'
                      }`}
                      title={`${CATEGORY_LABEL[r.category_top] ?? r.category_top}/${r.category_mid ?? '*'} · ${r.cadence_days_p50}일 · ${fmtKrw(r.ltv_proxy_krw)}`}
                    >
                      {(CATEGORY_LABEL[r.category_top] ?? r.category_top).slice(0, 2)}
                    </Link>
                  )
                })}
              </div>
            </div>

            {/* 테이블 */}
            <div className="rounded border border-gray-200 overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 text-gray-500">
                  <tr>
                    <th className="px-3 py-2 text-left">카테고리</th>
                    <th className="px-3 py-2 text-right">p25 (일)</th>
                    <th className="px-3 py-2 text-right">p50 (일)</th>
                    <th className="px-3 py-2 text-right">p75 (일)</th>
                    <th className="px-3 py-2 text-right">LTV proxy</th>
                    <th className="px-3 py-2 text-right">sample</th>
                    <th className="px-3 py-2 text-right">conf.</th>
                    <th className="px-3 py-2 text-left">평가</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {rows.map((r) => (
                    <tr key={r.id} className={focused?.id === r.id ? 'bg-amber-50' : ''}>
                      <td className="px-3 py-2">
                        <Link href={buildHref({ pin: r.id })} className="hover:underline">
                          {CATEGORY_LABEL[r.category_top] ?? r.category_top}
                          {r.category_mid ? ` / ${r.category_mid}` : ''}
                          {r.brand ? ` · ${r.brand}` : ''}
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-right font-mono">{r.cadence_days_p25 ?? '—'}</td>
                      <td className="px-3 py-2 text-right font-mono font-bold">{r.cadence_days_p50}</td>
                      <td className="px-3 py-2 text-right font-mono">{r.cadence_days_p75 ?? '—'}</td>
                      <td className="px-3 py-2 text-right font-mono">{fmtKrw(r.ltv_proxy_krw)}</td>
                      <td className="px-3 py-2 text-right font-mono text-gray-500">{r.sample_size}</td>
                      <td className="px-3 py-2 text-right font-mono text-gray-500">
                        {r.confidence_score?.toFixed(2) ?? '—'}
                      </td>
                      <td className="px-3 py-2 text-[11px] text-gray-600">{cadenceLabel(r.cadence_days_p50)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* 사이드 패널: 핀 상세 + CAC 계산기 */}
          <aside className="space-y-3">
            <div className="rounded border border-gray-200 p-4 bg-white sticky top-4">
              <h2 className="text-sm font-semibold mb-2">📌 핀 상세</h2>
              {!focused ? (
                <p className="text-xs text-gray-500">
                  좌측 매트릭스나 테이블에서 카테고리를 선택하라.
                </p>
              ) : (
                <div className="space-y-3">
                  <div>
                    <div className="text-base font-bold">
                      {CATEGORY_LABEL[focused.category_top] ?? focused.category_top}
                      {focused.category_mid ? ` / ${focused.category_mid}` : ''}
                    </div>
                    <div className="text-[10px] text-gray-500 mt-1">
                      computed_at {focused.computed_at?.slice(0, 19).replace('T', ' ')}
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-2 text-center">
                    <Stat label="p25" value={`${focused.cadence_days_p25 ?? '—'}d`} />
                    <Stat label="p50" value={`${focused.cadence_days_p50}d`} bold />
                    <Stat label="p75" value={`${focused.cadence_days_p75 ?? '—'}d`} />
                  </div>

                  <div className="rounded bg-gray-50 p-3 space-y-1">
                    <div className="text-xs text-gray-500">LTV proxy (annualized)</div>
                    <div className="text-xl font-bold font-mono">{fmtKrw(focused.ltv_proxy_krw)}</div>
                  </div>

                  {/* CAC 계산기 */}
                  <div className="rounded border border-amber-200 bg-amber-50 p-3 space-y-2">
                    <div className="text-xs font-semibold text-amber-900">권장 광고 CAC 상한</div>
                    <div className="text-2xl font-bold font-mono text-amber-900">
                      {fmtKrw(recommendedCacCeiling(focused.ltv_proxy_krw, margin, payback))}
                    </div>
                    <div className="text-[10px] text-amber-800 font-mono">
                      = LTV {fmtKrw(focused.ltv_proxy_krw)} × 마진 {(margin * 100).toFixed(0)}% × 회수목표 {(payback * 100).toFixed(0)}%
                    </div>
                    <div className="flex flex-wrap gap-1 pt-1">
                      <span className="text-[10px] text-amber-800">마진율:</span>
                      {[0.15, 0.3, 0.5].map((m) => (
                        <Link
                          key={m}
                          href={buildHref({ margin: String(m) })}
                          className={`text-[10px] px-2 py-0.5 rounded ${
                            Math.abs(margin - m) < 0.001
                              ? 'bg-amber-700 text-white'
                              : 'bg-white text-amber-800'
                          }`}
                        >
                          {(m * 100).toFixed(0)}%
                        </Link>
                      ))}
                    </div>
                    <div className="flex flex-wrap gap-1">
                      <span className="text-[10px] text-amber-800">회수목표:</span>
                      {[0.3, 0.5, 1.0].map((p) => (
                        <Link
                          key={p}
                          href={buildHref({ payback: String(p) })}
                          className={`text-[10px] px-2 py-0.5 rounded ${
                            Math.abs(payback - p) < 0.001
                              ? 'bg-amber-700 text-white'
                              : 'bg-white text-amber-800'
                          }`}
                        >
                          {(p * 100).toFixed(0)}%
                        </Link>
                      ))}
                    </div>
                  </div>

                  {/* 근거 */}
                  {focused.evidence_jsonb && (
                    <details className="text-[11px]">
                      <summary className="cursor-pointer text-gray-600">근거 (evidence)</summary>
                      <pre className="mt-2 bg-gray-50 p-2 rounded overflow-x-auto text-[10px]">
                        {JSON.stringify(focused.evidence_jsonb, null, 2)}
                      </pre>
                    </details>
                  )}
                </div>
              )}
            </div>

            <div className="rounded border border-gray-200 p-3 text-[11px] text-gray-600 space-y-1">
              <div className="font-semibold text-gray-700">📐 공식</div>
              <code className="block bg-gray-50 px-2 py-1 rounded font-mono text-[10px] leading-relaxed">
                LTV ≈ 단가 × (365 / cadence_p50) × retention(0.6)
                <br />
                CAC 상한 = LTV × 마진율 × 회수목표
              </code>
              <div>예) 멜라토닌 30d, 단가 2만원 → LTV ≈ 14.6만원 → CAC 상한 (30% × 50%) ≈ 22,000원</div>
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, bold = false }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="rounded border border-gray-200 p-2">
      <div className="text-[10px] text-gray-500">{label}</div>
      <div className={`mt-1 font-mono ${bold ? 'text-lg font-bold' : 'text-sm'}`}>{value}</div>
    </div>
  )
}
