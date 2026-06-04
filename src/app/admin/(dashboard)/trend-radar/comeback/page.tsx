import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// View jimscanner_trends_comeback 는 generated 타입 미반영 — `npm run gen:types` 시 캐스팅 제거
interface ComebackRow {
  product_id: string
  canonical_name: string
  category_top: string
  category_mid: string | null
  first_seen_at: string
  last_seen_at: string
  comeback_cycles: number
  avg_dormancy_days: number | null
  last_dormancy_days: number | null
  last_comeback_at: string | null
  first_active_at: string | null
  last_active_at: string | null
  active_days: number
  current_trend_score: number | null
  current_final_score: number | null
  latest_at: string | null
  is_currently_active: boolean
  comeback_type: 'cyclical' | 'returning' | 'one_off'
}

const TYPE_META: Record<ComebackRow['comeback_type'], { label: string; cls: string; desc: string }> = {
  cyclical: {
    label: '🔁 반복형',
    cls: 'bg-emerald-100 text-emerald-800 border-emerald-300',
    desc: '여러 번 떴다 가라앉길 반복 + 현재 주기 정합 — 검증된 반복 수요',
  },
  returning: {
    label: '↩ 복귀형',
    cls: 'bg-blue-100 text-blue-800 border-blue-300',
    desc: '과거 휴면 후 지금 다시 상승 중',
  },
  one_off: {
    label: '· 우발형',
    cls: 'bg-gray-100 text-gray-600 border-gray-300',
    desc: '컴백 이력은 있으나 현재 휴면',
  },
}

const FILTERS = [
  { v: '', label: '전체' },
  { v: 'cyclical', label: '🔁 반복형' },
  { v: 'returning', label: '↩ 복귀형' },
  { v: 'one_off', label: '우발형' },
] as const

async function fetchComeback() {
  const sb = createAdminClient()
  const { data, error } = await sb
    .from('jimscanner_trends_comeback' as never)
    .select('*')
    .limit(500)
  return { rows: (data ?? []) as unknown as ComebackRow[], error: error?.message ?? null }
}

function fmtDate(s: string | null): string {
  if (!s) return '—'
  return s.slice(0, 10)
}

export default async function ComebackPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string }>
}) {
  const sp = await searchParams
  const typeFilter = (sp.type ?? '') as string

  const { rows, error } = await fetchComeback()
  const filtered = typeFilter ? rows.filter((r) => r.comeback_type === typeFilter) : rows

  const cyclicalCount = rows.filter((r) => r.comeback_type === 'cyclical').length
  const returningCount = rows.filter((r) => r.comeback_type === 'returning').length
  const activeCount = rows.filter((r) => r.is_currently_active).length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🔁 재출현(컴백) 신뢰 레이더</h1>
          <p className="text-sm text-gray-500 mt-1">
            죽었다 살아난 반복 히트 — score 시계열의 <strong>활성→휴면(≥14일)→재활성</strong> 갭을 검출.
            반복형일수록 위탁 폐기 위험이 낮음.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="컴백 상품" value={rows.length} />
        <Kpi label="🔁 반복형" value={cyclicalCount} highlight={cyclicalCount > 0} />
        <Kpi label="↩ 복귀형" value={returningCount} />
        <Kpi label="현재 활성" value={activeCount} />
      </section>

      {/* 필터 */}
      <div className="flex flex-wrap gap-1">
        {FILTERS.map((f) => (
          <Link
            key={f.v}
            href={f.v ? `/admin/trend-radar/comeback?type=${f.v}` : '/admin/trend-radar/comeback'}
            className={`px-3 py-1 text-xs rounded ${
              typeFilter === f.v ? 'bg-black text-white font-semibold' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {f.label}
          </Link>
        ))}
      </div>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          VIEW 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            VIEW <code>jimscanner_trends_comeback</code> 미적용 가능성. <code>supabase/trends_comeback.sql</code> 적용 필요.
          </p>
        </div>
      )}

      {!error && filtered.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">컴백 패턴 없음</div>
          <div className="text-xs text-gray-400">
            아직 휴면→재활성 사이클이 누적되지 않았거나 score 시계열이 짧음. cron 누적 후 다시 방문.
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((r, i) => {
            const meta = TYPE_META[r.comeback_type]
            return (
              <div
                key={r.product_id}
                className={`rounded border p-3 ${
                  r.comeback_type === 'cyclical'
                    ? 'border-emerald-200 bg-emerald-50/40'
                    : r.is_currently_active
                    ? 'border-blue-200 bg-blue-50/30'
                    : 'border-gray-200'
                }`}
              >
                <div className="flex items-start gap-3">
                  <div className="w-8 text-center text-sm font-mono text-gray-400 pt-1">{i + 1}</div>

                  <div className="flex-1 min-w-0 space-y-1.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium leading-snug" title={r.canonical_name}>
                        {r.canonical_name}
                      </span>
                      <span className={`text-[11px] px-1.5 py-0.5 rounded border ${meta.cls}`} title={meta.desc}>
                        {meta.label}
                      </span>
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200">
                        컴백 {r.comeback_cycles}회
                      </span>
                      {r.is_currently_active && (
                        <span className="text-[11px] px-1.5 py-0.5 rounded bg-red-100 text-red-700">● 현재 활성</span>
                      )}
                    </div>
                    <div className="text-xs text-gray-500">
                      {r.category_top}
                      {r.category_mid ? ` · ${r.category_mid}` : ''}
                    </div>

                    {/* 재출현 타임라인 (점 = 컴백 시점, 막대 = 휴면 갭) */}
                    <ComebackTimeline row={r} />
                  </div>

                  {/* 지표 */}
                  <div className="text-right flex-shrink-0 text-[11px] text-gray-500 font-mono space-y-0.5 min-w-[120px]">
                    <div>
                      평균 재출현 <span className="text-gray-800 font-semibold">{r.avg_dormancy_days ?? '—'}일</span>
                    </div>
                    <div>
                      직전 휴면 <span className="text-gray-800 font-semibold">{r.last_dormancy_days ?? '—'}일</span>
                    </div>
                    <div>최근 컴백 {fmtDate(r.last_comeback_at)}</div>
                    {r.current_trend_score != null && (
                      <div className="text-amber-700">trend {Number(r.current_trend_score).toFixed(0)}</div>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* 설명 */}
      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 컴백 검출 로직</div>
        <ul className="list-disc pl-5 space-y-0.5">
          <li>활성일 = 해당 일자에 <code>trend_score ≥ 40</code> 인 score row 존재</li>
          <li>휴면 갭 = 연속 활성일 사이 간격 ≥ 14일 → 1회 컴백 사이클</li>
          <li>
            <strong>반복형(cyclical)</strong> = 컴백 2회+ AND 현재 활성 AND 직전 휴면이 평균 휴면 주기의 0.5~1.8배
            (= 과거 재출현 주기와 정합)
          </li>
          <li><strong>복귀형(returning)</strong> = 컴백 1회+ AND 현재 활성</li>
          <li><strong>우발형(one_off)</strong> = 컴백 이력은 있으나 현재 휴면</li>
        </ul>
      </section>
    </div>
  )
}

// 점 = 컴백 시점 / 막대 길이 = 직전 휴면 갭 (시각적 요약)
function ComebackTimeline({ row }: { row: ComebackRow }) {
  const dorm = row.last_dormancy_days ?? 0
  const avg = row.avg_dormancy_days ?? 0
  // 막대 폭: 휴면 갭을 90일 기준으로 정규화 (시각적 비교용)
  const pct = Math.max(6, Math.min(100, (dorm / 90) * 100))
  const cycles = Math.min(row.comeback_cycles, 8)
  return (
    <div className="flex items-center gap-2 pt-0.5">
      {/* 사이클 점들 */}
      <div className="flex items-center gap-0.5" title={`${row.comeback_cycles}회 컴백`}>
        {Array.from({ length: cycles }).map((_, i) => (
          <span key={i} className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500" />
        ))}
        {row.comeback_cycles > 8 && <span className="text-[10px] text-gray-400">+{row.comeback_cycles - 8}</span>}
      </div>
      {/* 직전 휴면 막대 */}
      <div className="flex-1 h-1.5 bg-gray-100 rounded overflow-hidden max-w-[200px]" title={`직전 휴면 ${dorm}일 / 평균 ${avg}일`}>
        <div className="h-full bg-amber-400" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function Kpi({ label, value, highlight = false }: { label: string; value: number | string; highlight?: boolean }) {
  return (
    <div className={`rounded border p-3 ${highlight ? 'border-emerald-300 bg-emerald-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${highlight ? 'text-emerald-700' : ''}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}
