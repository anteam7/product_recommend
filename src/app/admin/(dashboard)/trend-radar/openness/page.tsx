import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import OpennessScatter from './OpennessScatter'

export const dynamic = 'force-dynamic'

interface OpennessRow {
  scope_kind: string
  scope_value: string
  newcomer_rate: number
  avg_days_to_promote: number | null
  turnover_ratio: number
  openness_index: number
  verdict: string
  candidate_sku_count: number | null
  computed_for: string
}

const VERDICT_COLOR: Record<string, string> = {
  blocked: '#ef4444',
  tight: '#f97316',
  neutral: '#9ca3af',
  open: '#10b981',
  wide_open: '#059669',
  unknown: '#6b7280',
}

const VERDICT_LABEL: Record<string, string> = {
  blocked: '🚫 봉쇄',
  tight: '⚠ 협소',
  neutral: '· 중립',
  open: '✓ 개방',
  wide_open: '🚀 광폭',
  unknown: '? 미정',
}

async function fetchOpenness() {
  const sb = createAdminClient()
  // RPC + 신규 테이블이 generated 타입에 없을 수 있어 캐스팅. 마이그레이션 적용 후엔 정리.
  const { data, error } = await (sb as any)
    .from('jimscanner_category_openness')
    .select(
      'scope_kind, scope_value, newcomer_rate, avg_days_to_promote, turnover_ratio, openness_index, verdict, candidate_sku_count, computed_for',
    )
    .order('computed_for', { ascending: false })
    .order('openness_index', { ascending: false })
    .limit(500)

  if (error) return { rows: [] as OpennessRow[], error: error.message as string | null }

  // 가장 최근 computed_for 만 추림 (scope_value 별 latest)
  const seen = new Set<string>()
  const latest: OpennessRow[] = []
  for (const r of (data ?? []) as OpennessRow[]) {
    const k = `${r.scope_kind}|${r.scope_value}`
    if (seen.has(k)) continue
    seen.add(k)
    latest.push(r)
  }
  return { rows: latest, error: null as string | null }
}

export default async function OpennessPage() {
  const { rows, error } = await fetchOpenness()

  const total = rows.length
  const blocked = rows.filter((r) => r.verdict === 'blocked' || r.verdict === 'tight').length
  const open = rows.filter((r) => r.verdict === 'open' || r.verdict === 'wide_open').length
  const avgOpen = total > 0 ? rows.reduce((s, r) => s + Number(r.openness_index), 0) / total : 0
  const fastest = [...rows]
    .filter((r) => r.avg_days_to_promote != null)
    .sort((a, b) => Number(a.avg_days_to_promote) - Number(b.avg_days_to_promote))
    .slice(0, 10)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🚪 카테고리 개방성 (Openness Index)</h1>
          <p className="text-sm text-gray-500 mt-1">
            신규 셀러가 30일 안에 TOP-10에 도달할 수 있는 카테고리인가? — 봉쇄/개방 0~100 점수
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          데이터 로딩 실패: <code className="text-xs font-mono">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            <code>jimscanner_category_openness</code> 또는 RPC 미적용. supabase/trends_v4_seller_velocity.sql 적용 필요.
          </p>
        </div>
      )}

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="분석된 scope" value={total} />
        <Kpi label="🚫 봉쇄/협소" value={blocked} highlight={blocked > 0} color="red" />
        <Kpi label="✓ 개방/광폭" value={open} color="green" />
        <Kpi label="평균 Openness" value={avgOpen.toFixed(1)} />
      </section>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">스냅샷 누적 대기 중</div>
          <div className="text-xs text-gray-400">
            scripts/coupang-seller-rank-snapshot.mjs 가 30일 이상 누적되면 산점도가 의미를 가짐.<br />
            마이그레이션 미적용일 가능성도 있음 → supabase/trends_v4_seller_velocity.sql 확인.
          </div>
        </div>
      ) : (
        <>
          <OpennessScatter rows={rows} verdictColor={VERDICT_COLOR} />

          {/* 카테고리 표 */}
          <section className="rounded border border-gray-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500">
                <tr>
                  <th className="text-left px-3 py-2">scope</th>
                  <th className="text-right px-3 py-2">Openness</th>
                  <th className="text-right px-3 py-2">신규 출현율</th>
                  <th className="text-right px-3 py-2">평균 days→TOP10</th>
                  <th className="text-right px-3 py-2">Turnover</th>
                  <th className="text-right px-3 py-2">SKU 후보</th>
                  <th className="text-left px-3 py-2">판정</th>
                </tr>
              </thead>
              <tbody>
                {rows
                  .sort((a, b) => Number(b.openness_index) - Number(a.openness_index))
                  .map((r) => (
                    <tr key={`${r.scope_kind}|${r.scope_value}`} className="border-t border-gray-100 hover:bg-gray-50">
                      <td className="px-3 py-2 font-mono text-xs">
                        <span className="text-gray-400">{r.scope_kind}/</span>
                        {r.scope_value}
                      </td>
                      <td className="px-3 py-2 text-right font-mono font-bold">
                        {Number(r.openness_index).toFixed(1)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs">
                        {(Number(r.newcomer_rate) * 100).toFixed(0)}%
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs">
                        {r.avg_days_to_promote != null
                          ? `${Number(r.avg_days_to_promote).toFixed(0)}일`
                          : <span className="text-gray-400">—</span>}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs">
                        {(Number(r.turnover_ratio) * 100).toFixed(0)}%
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs text-gray-500">
                        {r.candidate_sku_count ?? '—'}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className="inline-block text-xs px-2 py-0.5 rounded"
                          style={{
                            background: VERDICT_COLOR[r.verdict] + '22',
                            color: VERDICT_COLOR[r.verdict],
                          }}
                        >
                          {VERDICT_LABEL[r.verdict] ?? r.verdict}
                        </span>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </section>

          {fastest.length > 0 && (
            <section className="rounded border border-emerald-200 bg-emerald-50/40 p-4">
              <h3 className="text-sm font-semibold mb-2 text-emerald-900">
                ⚡ 부상이 가장 빠른 scope (낮은 days→TOP10)
              </h3>
              <ol className="text-sm space-y-1">
                {fastest.map((r, i) => (
                  <li key={`${r.scope_kind}|${r.scope_value}`} className="flex items-baseline gap-3">
                    <span className="font-mono text-gray-400 w-6 text-right">{i + 1}</span>
                    <span className="font-mono text-xs">{r.scope_kind}/{r.scope_value}</span>
                    <span className="text-emerald-700 font-mono">{Number(r.avg_days_to_promote).toFixed(0)}일</span>
                    <span className="text-xs text-gray-500">openness {Number(r.openness_index).toFixed(0)}</span>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </>
      )}

      {/* 공식 설명 */}
      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 Openness Index 공식</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          openness = 0.4·newcomer_rate·100 + 0.3·(100 − days_norm) + 0.3·turnover·100
          <br />
          newcomer_rate = 최근 30일 신규 셀러 수 ÷ 평균 TOP-K
          <br />
          days_norm = (90 − avg_days_to_promote) / 90 · 100
          <br />
          turnover = 30일 내 들어왔다 나간 셀러 ÷ 평균 TOP-K
        </code>
        <div className="pt-2">
          <strong>해석:</strong> openness &lt; 30 ⇒ 로켓·PB 봉쇄 시장 (발행 비추) · openness &gt; 70 ⇒ 신규 진입 활발 (발행 권장)
        </div>
      </section>
    </div>
  )
}

function Kpi({
  label,
  value,
  highlight = false,
  color,
}: {
  label: string
  value: number | string
  highlight?: boolean
  color?: 'red' | 'green'
}) {
  const cls =
    color === 'red'
      ? 'border-red-300 bg-red-50 text-red-700'
      : color === 'green'
        ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
        : highlight
          ? 'border-amber-300 bg-amber-50'
          : 'border-gray-200'
  return (
    <div className={`rounded border p-3 ${cls}`}>
      <div className="text-xs opacity-70">{label}</div>
      <div className="text-2xl font-bold mt-1">
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}
