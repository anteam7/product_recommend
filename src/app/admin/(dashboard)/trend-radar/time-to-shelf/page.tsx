import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface ShelfRow {
  keyword: string
  category_top: string | null
  n_points: number
  first_seen: string
  last_seen: string
  current_volume: number | null
  peak_volume: number | null
  slope_per_day: number | null
  halflife_days: number | null
  supplier_source: string | null
  lead_time_days: number
  is_domestic: boolean | null
  publish_buffer_days: number
  shelf_buffer_days: number | null
  gate: 'GO' | 'CAUTION' | 'TOO_LATE'
}

const DAYS_OPTIONS = [
  { v: 14, label: '14일' },
  { v: 30, label: '30일 (기본)' },
  { v: 60, label: '60일' },
  { v: 90, label: '90일' },
] as const

const GATE_OPTIONS = [
  { v: '', label: '전체' },
  { v: 'CAUTION', label: '⚠ 빠듯함만' },
  { v: 'TOO_LATE', label: '⛔ 늦음만' },
  { v: 'GO', label: '✅ 진입가능만' },
] as const

async function fetchShelf(opts: { days: number; buffer: number; lead: number }) {
  const sb = createAdminClient()
  // RPC는 DB(supabase/trends_v4_timetoshelf_rpc.sql)에 존재하나 generated 타입 미반영 — `npm run gen:types` 시 캐스팅 제거
  const { data, error } = await sb.rpc('jimscanner_trends_time_to_shelf' as never, {
    days_window: opts.days,
    min_points: 2,
    publish_buffer_days: opts.buffer,
    default_lead_time_days: opts.lead,
    result_limit: 300,
  } as never)
  if (error) return { rows: [] as ShelfRow[], error: error.message }
  return { rows: (data ?? []) as ShelfRow[], error: null as string | null }
}

function buildHref(current: Record<string, string>, override: Record<string, string | null>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/time-to-shelf' + (qs ? `?${qs}` : '')
}

const GATE_META: Record<ShelfRow['gate'], { chip: string; label: string; bar: string }> = {
  GO: { chip: 'bg-emerald-100 text-emerald-700 border-emerald-300', label: '✅ GO', bar: 'bg-emerald-400' },
  CAUTION: { chip: 'bg-amber-100 text-amber-700 border-amber-300', label: '⚠ CAUTION', bar: 'bg-amber-400' },
  TOO_LATE: { chip: 'bg-red-100 text-red-700 border-red-300', label: '⛔ TOO-LATE', bar: 'bg-red-400' },
}

export default async function TimeToShelfPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; buffer?: string; lead?: string; gate?: string }>
}) {
  const sp = await searchParams
  const days = parseInt(sp.days ?? '30', 10)
  const validDays = DAYS_OPTIONS.some((d) => d.v === days) ? days : 30
  const buffer = Math.max(0, Math.min(30, parseInt(sp.buffer ?? '3', 10) || 3))
  const lead = Math.max(1, Math.min(60, parseInt(sp.lead ?? '7', 10) || 7))
  const gateFilter = sp.gate ?? ''

  const current: Record<string, string> = {
    days: String(validDays),
    buffer: String(buffer),
    lead: String(lead),
    gate: gateFilter,
  }

  const { rows: allRows, error } = await fetchShelf({ days: validDays, buffer, lead })
  const rows = gateFilter ? allRows.filter((r) => r.gate === gateFilter) : allRows

  // KPI
  const total = allRows.length
  const goCount = allRows.filter((r) => r.gate === 'GO').length
  const cautionCount = allRows.filter((r) => r.gate === 'CAUTION').length
  const tooLateCount = allRows.filter((r) => r.gate === 'TOO_LATE').length
  const matchedSupplier = allRows.filter((r) => r.supplier_source != null).length

  // 타임라인 스케일: 모든 행의 리드+버퍼·반감기 중 최대치 (상한 120일)
  const horizon = Math.min(
    120,
    Math.max(
      14,
      ...rows.map((r) =>
        Math.max(r.lead_time_days + r.publish_buffer_days, r.halflife_days ?? 0)
      )
    )
  )

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">⏱ 도착 타당성 게이트 (Time-to-Shelf)</h1>
          <p className="text-sm text-gray-500 mt-1">
            트렌드 잔여 반감기 × 소싱 리드타임을 한 화면에서 충돌 — 도착 전 소멸하는 fad를 사전 차단
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 설명 */}
      <div className="rounded border border-sky-200 bg-sky-50 px-4 py-3 text-xs text-sky-900 leading-relaxed">
        <strong>shelf buffer = 반감기(일) − (리드타임 + 발행·세팅 버퍼)</strong> ·{' '}
        <span className="font-mono">≥ +7 → GO</span>,{' '}
        <span className="font-mono">0~7 → CAUTION</span>,{' '}
        <span className="font-mono">&lt; 0 → TOO-LATE</span>. 수요 상승/유지(기울기 ≥ 0) 키워드는 소멸 없음 → GO.
        국내 단리드(ggsan)는 GO 비중↑, 1688 등 장리드는 NO-GO로 밀림.
      </div>

      {/* 필터 */}
      <div className="rounded border border-gray-200 px-4 py-3 space-y-3">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">시계열 기간</span>
            {DAYS_OPTIONS.map((d) => (
              <Link
                key={d.v}
                href={buildHref(current, { days: String(d.v) })}
                className={`px-2 py-1 text-xs rounded ${validDays === d.v ? 'bg-sky-100 text-sky-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
              >
                {d.label}
              </Link>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">발행·세팅 버퍼</span>
            {[1, 3, 5].map((b) => (
              <Link
                key={b}
                href={buildHref(current, { buffer: String(b) })}
                className={`px-2 py-1 text-xs rounded ${buffer === b ? 'bg-sky-100 text-sky-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
              >
                {b}일
              </Link>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">기본 리드타임</span>
            {[5, 7, 14].map((l) => (
              <Link
                key={l}
                href={buildHref(current, { lead: String(l) })}
                className={`px-2 py-1 text-xs rounded ${lead === l ? 'bg-sky-100 text-sky-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
              >
                {l}일
              </Link>
            ))}
            <span className="text-[10px] text-gray-400">(공급원 미매칭 시)</span>
          </div>
        </div>
        <div className="flex flex-wrap gap-1 border-t border-gray-100 pt-2">
          {GATE_OPTIONS.map((g) => (
            <Link
              key={g.v}
              href={buildHref(current, { gate: g.v || null })}
              className={`px-2 py-1 text-xs rounded ${gateFilter === g.v ? 'bg-black text-white font-semibold' : 'text-gray-500 hover:text-black'}`}
            >
              {g.label}
            </Link>
          ))}
        </div>
      </div>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Kpi label="분석 키워드" value={total} />
        <Kpi label="✅ GO" value={goCount} tone="emerald" />
        <Kpi label="⚠ CAUTION" value={cautionCount} tone="amber" />
        <Kpi label="⛔ TOO-LATE" value={tooLateCount} tone="red" />
        <Kpi label="공급원 매칭" value={matchedSupplier} />
      </section>

      {/* 에러 */}
      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          RPC 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            RPC <code>jimscanner_trends_time_to_shelf</code> 가 DB에 적용 안 됐을 가능성.
            supabase/trends_v4_timetoshelf_rpc.sql 적용 필요.
          </p>
        </div>
      )}

      {/* 타임라인 막대 */}
      {!error && rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">분석 가능한 키워드 없음</div>
          <div className="text-xs text-gray-400">
            volume_relative 시계열이 키워드당 최소 2포인트 이상 누적돼야 회귀 추정 가능.
            <br />
            naver_search_trend / naver_shopping_insight 수집이 며칠 더 쌓이면 자동 풍부해짐. (sources 페이지 확인)
          </div>
        </div>
      ) : (
        !error && (
          <div className="space-y-2">
            {/* 타임라인 헤더 눈금 */}
            <div className="flex items-center gap-3 px-3 text-[10px] text-gray-400">
              <div className="w-48 flex-shrink-0">키워드</div>
              <div className="flex-1 relative h-4">
                <span className="absolute left-0">오늘</span>
                <span className="absolute right-0">+{Math.round(horizon)}일</span>
              </div>
              <div className="w-28 flex-shrink-0 text-right">게이트</div>
            </div>

            {rows.map((r) => {
              const meta = GATE_META[r.gate]
              const leadEnd = r.lead_time_days + r.publish_buffer_days
              const leadPct = Math.min(100, (leadEnd / horizon) * 100)
              const halfPct =
                r.halflife_days != null ? Math.min(100, (r.halflife_days / horizon) * 100) : null
              return (
                <div
                  key={r.keyword}
                  className="flex items-center gap-3 rounded border border-gray-200 px-3 py-2.5 hover:bg-gray-50"
                >
                  {/* 키워드 + 메타 */}
                  <div className="w-48 flex-shrink-0 min-w-0">
                    <div className="text-sm font-medium truncate" title={r.keyword}>
                      {r.keyword}
                    </div>
                    <div className="text-[10px] text-gray-500 truncate">
                      {r.supplier_source ? (
                        <span className={r.is_domestic ? 'text-emerald-600' : 'text-red-600'}>
                          {r.is_domestic ? '🇰🇷' : '🌏'} {r.supplier_source} · 리드 {r.lead_time_days}일
                        </span>
                      ) : (
                        <span className="text-gray-400">공급원 미매칭 · 기본 {r.lead_time_days}일</span>
                      )}
                    </div>
                  </div>

                  {/* 타임라인 트랙 */}
                  <div className="flex-1 relative h-9">
                    {/* 베이스 라인 */}
                    <div className="absolute top-1/2 left-0 right-0 h-px bg-gray-200" />

                    {/* 리드타임 막대 (오늘 → 도착) */}
                    <div
                      className="absolute top-1/2 -translate-y-1/2 h-2 rounded-l bg-slate-300"
                      style={{ left: '0%', width: `${leadPct}%` }}
                      title={`도착까지 ${leadEnd}일 (리드 ${r.lead_time_days} + 버퍼 ${r.publish_buffer_days})`}
                    />
                    {/* 도착선 */}
                    <div
                      className="absolute top-0 bottom-0 w-0.5 bg-slate-600"
                      style={{ left: `${leadPct}%` }}
                      title={`도착 ≈ +${leadEnd}일`}
                    />
                    <span
                      className="absolute -top-0.5 text-[9px] text-slate-600 whitespace-nowrap"
                      style={{ left: `${leadPct}%`, transform: 'translateX(-50%)' }}
                    >
                      📦
                    </span>

                    {/* 반감기 소멸선 */}
                    {halfPct != null ? (
                      <>
                        <div
                          className={`absolute top-1/2 -translate-y-1/2 h-2 ${meta.bar} opacity-50`}
                          style={{
                            left: `${leadPct}%`,
                            width: `${Math.max(0, halfPct - leadPct)}%`,
                          }}
                        />
                        <div
                          className="absolute top-0 bottom-0 w-0.5 bg-red-500"
                          style={{ left: `${halfPct}%` }}
                          title={`반감기 ≈ +${Math.round(r.halflife_days!)}일`}
                        />
                        <span
                          className="absolute -bottom-0.5 text-[9px] text-red-500 whitespace-nowrap"
                          style={{ left: `${halfPct}%`, transform: 'translateX(-50%)' }}
                        >
                          ▼{Math.round(r.halflife_days!)}d
                        </span>
                      </>
                    ) : (
                      <span className="absolute top-1/2 -translate-y-1/2 right-0 text-[9px] text-emerald-600 font-semibold">
                        ↗ 수요 상승/유지
                      </span>
                    )}
                  </div>

                  {/* 게이트 칩 + buffer */}
                  <div className="w-28 flex-shrink-0 text-right space-y-0.5">
                    <span className={`inline-block px-2 py-0.5 text-[11px] font-semibold rounded border ${meta.chip}`}>
                      {meta.label}
                    </span>
                    <div className="text-[10px] font-mono text-gray-500">
                      {r.shelf_buffer_days != null
                        ? `${r.shelf_buffer_days >= 0 ? '+' : ''}${Math.round(r.shelf_buffer_days)}일 여유`
                        : `반감기 ∞`}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )
      )}

      {/* 공식 설명 */}
      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 Time-to-Shelf 공식</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          slope = 선형회귀(volume_relative ~ 일) — 최근 {validDays}일 시계열
          <br />
          halflife_days = slope &lt; 0 ? current_volume / (2 × |slope|) : ∞ (상승/유지)
          <br />
          shelf_buffer = halflife_days − (lead_time_days + {buffer}일 발행·세팅 버퍼)
          <br />
          gate = shelf_buffer ≥ +7 ? GO : shelf_buffer ≥ 0 ? CAUTION : TOO-LATE
        </code>
        <div className="pt-2">
          <strong>📦</strong> = 도착선(리드+버퍼) · <strong className="text-red-500">▼</strong> = 반감기 소멸선.
          도착선이 소멸선보다 왼쪽이면 진입 여유 있음(GO), 오른쪽이면 도착 전 소멸(TOO-LATE).
          공급원 미매칭 키워드는 기본 리드타임({lead}일) 가정 — trends_aliases 에 keyword↔product 매핑이 쌓이면 정밀해짐.
        </div>
      </section>
    </div>
  )
}

function Kpi({
  label,
  value,
  tone = 'gray',
}: {
  label: string
  value: number | string
  tone?: 'gray' | 'emerald' | 'amber' | 'red'
}) {
  const toneMap: Record<string, string> = {
    gray: 'border-gray-200',
    emerald: 'border-emerald-300 bg-emerald-50',
    amber: 'border-amber-300 bg-amber-50',
    red: 'border-red-300 bg-red-50',
  }
  const valTone: Record<string, string> = {
    gray: '',
    emerald: 'text-emerald-700',
    amber: 'text-amber-700',
    red: 'text-red-700',
  }
  return (
    <div className={`rounded border p-3 ${toneMap[tone]}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${valTone[tone]}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}
