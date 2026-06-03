import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// jimscanner_trends_source_leadlag 는 신규 테이블 — 마이그레이션 후 타입 생성 전이라 as any 캐스팅.
interface LeadLagRow {
  source_a: string
  source_b: string
  median_lag_hours: number
  mean_lag_hours: number | null
  sample_n: number
  lead_winrate: number
  window_days: number
  computed_at: string
}

interface ActionItem {
  keyword: string
  source_a: string
  source_b: string
  firstSeenA: string
  lagHours: number
  winrate: number
  etaHours: number // 후행 출처 도달 예상까지 남은 시간(h)
}

const MIN_WINRATE = 0.6 // 리더로 신뢰할 최소 승률
const MIN_SAMPLE = 4

/** 키워드 정규화 — compute-source-leadlag.mjs 와 동일 규칙. */
function normalize(kw: string | null): string {
  if (!kw) return ''
  return kw
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[^0-9a-z가-힣]/g, '')
    .trim()
}

async function fetchData(): Promise<{
  pairs: LeadLagRow[]
  sources: string[]
  actions: ActionItem[]
  computedAt: string | null
  error: string | null
}> {
  const sb = createAdminClient()

  // 신규 테이블 — 생성된 Database 타입에 아직 없어 as any 캐스팅.
  const { data: rawPairs, error: pairErr } = await (sb as any)
    .from('jimscanner_trends_source_leadlag')
    .select('source_a, source_b, median_lag_hours, mean_lag_hours, sample_n, lead_winrate, window_days, computed_at')
    .order('computed_at', { ascending: false })
    .limit(2000)

  if (pairErr) {
    return { pairs: [], sources: [], actions: [], computedAt: null, error: pairErr.message }
  }

  // (source_a,source_b) 별 latest 만 (opportunity 패턴: 최신 dedup).
  const seen = new Set<string>()
  const latest: LeadLagRow[] = []
  let computedAt: string | null = null
  for (const r of (rawPairs ?? []) as LeadLagRow[]) {
    if (!computedAt) computedAt = r.computed_at
    const key = `${r.source_a}→${r.source_b}`
    if (seen.has(key)) continue
    seen.add(key)
    latest.push(r)
  }

  // 신뢰 가능한 리드 쌍만 (승률·표본).
  const pairs = latest
    .filter((p) => p.lead_winrate >= MIN_WINRATE && p.sample_n >= MIN_SAMPLE && p.median_lag_hours > 0)
    .sort((a, b) => b.lead_winrate - a.lead_winrate || b.median_lag_hours - a.median_lag_hours)

  const sources = Array.from(new Set(pairs.flatMap((p) => [p.source_a, p.source_b]))).sort()

  // ── 액션 리스트: 선행 출처엔 떴지만 후행 출처엔 아직 없는 키워드 ──
  // 최근 키워드의 (정규화) 출처별 첫 등장 시각을 모은다.
  const actions: ActionItem[] = []
  if (pairs.length > 0) {
    const since14d = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()
    const { data: kws } = await sb
      .from('jimscanner_trends_keywords')
      .select('keyword, source, collected_at')
      .gte('collected_at', since14d)
      .order('collected_at', { ascending: true })
      .limit(8000)

    // normKeyword -> source -> firstSeenMs
    const firstByKw = new Map<string, Map<string, number>>()
    const displayName = new Map<string, string>()
    for (const r of (kws ?? []) as { keyword: string | null; source: string; collected_at: string }[]) {
      const nk = normalize(r.keyword)
      if (!nk || !r.source) continue
      if (!displayName.has(nk)) displayName.set(nk, (r.keyword ?? nk).trim())
      let m = firstByKw.get(nk)
      if (!m) {
        m = new Map()
        firstByKw.set(nk, m)
      }
      const ms = new Date(r.collected_at).getTime()
      const prev = m.get(r.source)
      if (prev === undefined || ms < prev) m.set(r.source, ms)
    }

    const now = Date.now()
    const HOUR = 3_600_000
    const dedupe = new Set<string>()
    for (const p of pairs) {
      for (const [nk, srcMap] of firstByKw) {
        const aMs = srcMap.get(p.source_a)
        if (aMs === undefined) continue // 선행 출처에 없으면 패스
        if (srcMap.has(p.source_b)) continue // 후행 출처에 이미 도달 → 선점 가치 소멸
        const elapsedH = (now - aMs) / HOUR
        const etaHours = p.median_lag_hours - elapsedH // 후행 도달까지 남은 시간
        if (etaHours <= 0) continue // 예상 도달 시점 지남 (아직 안 옴 = 신호 약화로 간주, 제외)
        const dk = `${p.source_a}→${p.source_b}:${nk}`
        if (dedupe.has(dk)) continue
        dedupe.add(dk)
        actions.push({
          keyword: displayName.get(nk) ?? nk,
          source_a: p.source_a,
          source_b: p.source_b,
          firstSeenA: new Date(aMs).toISOString(),
          lagHours: p.median_lag_hours,
          winrate: p.lead_winrate,
          etaHours,
        })
      }
    }
    // 도달 임박(eta 작음) + 승률 높은 순.
    actions.sort((a, b) => a.etaHours - b.etaHours || b.winrate - a.winrate)
  }

  return { pairs, sources, actions: actions.slice(0, 60), computedAt, error: null }
}

function fmtLag(h: number): string {
  if (h < 24) return `+${h.toFixed(1)}h`
  return `+${(h / 24).toFixed(1)}일`
}

function dn(etaHours: number): string {
  const d = Math.max(0, Math.round(etaHours / 24))
  if (d === 0) return '오늘~내일'
  return `D-${d}`
}

// 승률 → 셀 배경 (히트맵).
function heatCls(winrate: number | null): string {
  if (winrate == null) return 'bg-gray-50 text-gray-300'
  if (winrate >= 0.8) return 'bg-indigo-600 text-white'
  if (winrate >= 0.7) return 'bg-indigo-400 text-white'
  if (winrate >= 0.6) return 'bg-indigo-200 text-indigo-900'
  return 'bg-gray-100 text-gray-500'
}

export default async function LeadLagPage() {
  const { pairs, sources, actions, computedAt, error } = await fetchData()

  // 히트맵 lookup: a→b.
  const cell = new Map<string, LeadLagRow>()
  for (const p of pairs) cell.set(`${p.source_a}→${p.source_b}`, p)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">⏱ 출처 간 리드-랙 선행지표</h1>
          <p className="text-sm text-gray-500 mt-1">
            어느 출처가 다른 출처보다 먼저 신호를 주는가 — 그 시차가 곧 위탁 선점 리드타임
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <div className="rounded border border-indigo-200 bg-indigo-50 px-4 py-3 text-xs text-indigo-900">
        <strong>왜 리드-랙인가</strong> · 기존 보드는 시점 스냅샷 또는 출처 합의(삼각검증) 관점이라
        '어느 출처가 먼저 터지나'라는 <strong>시간 선행관계</strong>를 모델링하지 않았다. 같은 키워드가 출처 A 에
        먼저, 출처 B 에 나중에 뜬다면 그 시차가 곧 <strong>경쟁 혼잡 전 등록</strong>의 리드타임.
        <span className="block mt-1 text-indigo-700">
          집계: scripts/compute-source-leadlag.mjs (run-crons.mjs 막바지) · 적재: jimscanner_trends_source_leadlag ·
          마지막 집계 {computedAt ? new Date(computedAt).toLocaleString('ko-KR') : '—'}
        </span>
      </div>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          조회 에러: <code className="font-mono text-xs">{error}</code>
          <div className="mt-1 text-xs text-red-600">
            테이블 미생성 시 supabase/trends_source_leadlag.sql 적용 후 집계 스크립트 1회 실행 필요.
          </div>
        </div>
      )}

      {!error && pairs.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">신뢰 가능한 리드-랙 쌍 없음</div>
          <div className="text-xs text-gray-400">
            아직 출처 간 공유 키워드가 충분치 않거나(표본 {MIN_SAMPLE}+ / 승률 {Math.round(MIN_WINRATE * 100)}%+ 기준),
            집계 스크립트가 미실행. cron 누적 후 다시 방문.
          </div>
        </div>
      ) : (
        <>
          {/* ── 핵심 액션 리스트 ── */}
          <section>
            <h2 className="text-sm font-semibold text-gray-700 mb-2">
              🎯 선점 액션 — 선행 출처엔 떴지만 후행 출처엔 아직 없는 키워드
            </h2>
            {actions.length === 0 ? (
              <div className="rounded border border-dashed border-gray-300 p-6 text-center text-xs text-gray-400">
                현재 '선행 출처에만 뜬 in-flight' 키워드 없음 — 최근 14일 기준.
              </div>
            ) : (
              <div className="rounded border border-gray-200 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-gray-500 text-xs">
                    <tr>
                      <th className="px-3 py-2 text-left">키워드</th>
                      <th className="px-3 py-2 text-left">경로 (선행 → 후행)</th>
                      <th className="px-3 py-2 text-center">마켓 도달 예상</th>
                      <th className="px-3 py-2 text-right">중앙 시차</th>
                      <th className="px-3 py-2 text-right">리드 승률</th>
                      <th className="px-3 py-2 text-right">선행 등장</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {actions.map((a, i) => (
                      <tr key={i} className={a.etaHours <= 48 ? 'bg-green-50/40' : ''}>
                        <td className="px-3 py-2 font-medium">{a.keyword}</td>
                        <td className="px-3 py-2 text-xs">
                          <span className="font-mono text-indigo-700">{a.source_a}</span>
                          <span className="text-gray-400"> → </span>
                          <span className="font-mono text-gray-500">{a.source_b}</span>
                        </td>
                        <td className="px-3 py-2 text-center">
                          <span
                            className={`text-xs font-bold px-2 py-0.5 rounded ${
                              a.etaHours <= 48 ? 'bg-green-600 text-white' : 'bg-gray-200 text-gray-700'
                            }`}
                          >
                            {dn(a.etaHours)}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-gray-600">{fmtLag(a.lagHours)}</td>
                        <td className="px-3 py-2 text-right font-mono text-indigo-700">
                          {(a.winrate * 100).toFixed(0)}%
                        </td>
                        <td className="px-3 py-2 text-right text-xs text-gray-400">
                          {new Date(a.firstSeenA).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="text-[11px] text-gray-400 mt-1">
              마켓 도달 예상 = 선행 등장 + 중앙 시차 − 경과시간. 초록(D-2 이내)은 선점 골든타임 임박.
            </p>
          </section>

          {/* ── 방향성 출처-영향 히트맵 ── */}
          <section>
            <h2 className="text-sm font-semibold text-gray-700 mb-2">
              🔥 방향성 출처-영향 히트맵 (행 = 선행, 열 = 후행 · 색 = 리드 승률)
            </h2>
            <div className="rounded border border-gray-200 overflow-x-auto">
              <table className="text-xs border-collapse">
                <thead>
                  <tr>
                    <th className="px-2 py-1.5 text-left text-gray-400 font-medium sticky left-0 bg-white">
                      선행 ↓ \ 후행 →
                    </th>
                    {sources.map((s) => (
                      <th key={s} className="px-2 py-1.5 font-mono text-gray-500 whitespace-nowrap">
                        {s}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sources.map((ra) => (
                    <tr key={ra}>
                      <td className="px-2 py-1.5 font-mono text-gray-500 whitespace-nowrap sticky left-0 bg-white">
                        {ra}
                      </td>
                      {sources.map((cb) => {
                        if (ra === cb) {
                          return (
                            <td key={cb} className="px-2 py-1.5 text-center bg-gray-50 text-gray-300">
                              ·
                            </td>
                          )
                        }
                        const c = cell.get(`${ra}→${cb}`)
                        return (
                          <td
                            key={cb}
                            className={`px-2 py-1.5 text-center align-middle ${heatCls(c ? c.lead_winrate : null)}`}
                            title={
                              c
                                ? `${ra} → ${cb}: median ${fmtLag(c.median_lag_hours)}, 승률 ${(c.lead_winrate * 100).toFixed(0)}%, n=${c.sample_n}`
                                : '신뢰 쌍 없음'
                            }
                          >
                            {c ? (
                              <div className="leading-tight">
                                <div className="font-bold">{(c.lead_winrate * 100).toFixed(0)}%</div>
                                <div className="text-[10px] opacity-80">{fmtLag(c.median_lag_hours)}</div>
                              </div>
                            ) : (
                              ''
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-gray-400 mt-1">
              셀 = 행 출처가 열 출처를 선행. 진한 셀일수록 선행 승률 높음. 표본 {MIN_SAMPLE}+ · 승률 {Math.round(MIN_WINRATE * 100)}%+ 만 표시.
            </p>
          </section>

          {/* ── 리드 쌍 랭킹 ── */}
          <section>
            <h2 className="text-sm font-semibold text-gray-700 mb-2">📋 선행 출처 쌍 랭킹</h2>
            <div className="rounded border border-gray-200 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-gray-500 text-xs">
                  <tr>
                    <th className="px-3 py-2 text-left">선행 출처</th>
                    <th className="px-3 py-2 text-left">후행 출처</th>
                    <th className="px-3 py-2 text-right">중앙 시차</th>
                    <th className="px-3 py-2 text-right">평균 시차</th>
                    <th className="px-3 py-2 text-right">리드 승률</th>
                    <th className="px-3 py-2 text-right">표본</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {pairs.map((p, i) => (
                    <tr key={i}>
                      <td className="px-3 py-2 font-mono text-indigo-700">{p.source_a}</td>
                      <td className="px-3 py-2 font-mono text-gray-500">{p.source_b}</td>
                      <td className="px-3 py-2 text-right font-mono">{fmtLag(p.median_lag_hours)}</td>
                      <td className="px-3 py-2 text-right font-mono text-gray-400">
                        {p.mean_lag_hours != null ? fmtLag(p.mean_lag_hours) : '—'}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-indigo-700">
                        {(p.lead_winrate * 100).toFixed(0)}%
                      </td>
                      <td className="px-3 py-2 text-right text-gray-500">{p.sample_n}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 산식</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          공유 키워드(정규화) 별 first_seen[source] 계산 → 출처 쌍 (a,b): lag = first_b − first_a
          <br />
          median_lag_hours = median(lag) · lead_winrate = (a 가 먼저 등장한 비율) · source_a = 리더 방향
        </code>
        <div className="pt-1 text-gray-400">
          신규 테이블 jimscanner_trends_source_leadlag — 마이그레이션 supabase/trends_source_leadlag.sql.
        </div>
      </section>
    </div>
  )
}
