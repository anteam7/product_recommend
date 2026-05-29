import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// RPC(supabase/trends_freshness_rpc.sql) 가 generated 타입에 미반영 — `npm run gen:types` 시 캐스팅 제거
interface FreshnessRow {
  product_id: string
  product_name: string | null
  category_top: string | null
  final_score: number
  computed_at: string
  alias_count: number
  latest_alias_at: string | null
  alias_sources: string[] | null
  supplier_count: number
  latest_supplier_at: string | null
  evidence_age_hours: number
  oldest_evidence_age_hours: number
  decay_factor: number
  freshness_adjusted_score: number
  delta: number
  frozen: boolean
  frozen_sources: string[] | null
}

const HALF_LIFE_OPTIONS = [
  { v: 1.5, label: '1.5일 (공격적)' },
  { v: 3, label: '3일 (기본)' },
  { v: 7, label: '7일 (완만)' },
] as const

async function fetchFreshness(halfLife: number) {
  const sb = createAdminClient()
  const { data, error } = await sb.rpc('jimscanner_trends_freshness' as never, {
    half_life_days: halfLife,
    result_limit: 300,
  } as never)
  if (error) return { rows: [] as FreshnessRow[], error: error.message }
  return { rows: (data ?? []) as FreshnessRow[], error: null as string | null }
}

function fmtAge(hours: number): string {
  const h = Number(hours)
  if (!isFinite(h) || h < 0) return '?'
  if (h < 1) return `${Math.round(h * 60)}분`
  if (h < 48) return `${h.toFixed(1)}시간`
  return `${(h / 24).toFixed(1)}일`
}

function sourceLabel(s: string): string {
  const map: Record<string, string> = {
    naver_tvtime: '📺 TV편성',
    naver_shopping_hot: '🛍 쇼핑hot',
    naver_shopping_insight: '🛍 쇼핑insight',
    naver_search_trend: '🔍 검색트렌드',
    aliex_best: '🅰 알리',
    musinsa_best: '🅼 무신사',
    manual: '✍ 수동',
  }
  return map[s] ?? s
}

export default async function FreshnessPage({
  searchParams,
}: {
  searchParams: Promise<{ hl?: string }>
}) {
  const sp = await searchParams
  const hlParsed = parseFloat(sp.hl ?? '3')
  const halfLife = HALF_LIFE_OPTIONS.some((o) => Math.abs(o.v - hlParsed) < 0.001) ? hlParsed : 3

  const { rows, error } = await fetchFreshness(halfLife)

  // 보정점수 기준 재정렬
  const reranked = [...rows].sort(
    (a, b) => Number(b.freshness_adjusted_score) - Number(a.freshness_adjusted_score),
  )

  // 재수집 필요 큐: 동결됐거나 신선도 50% 미만(=증거가 반감기 이상 묵음)
  const recollectQueue = rows
    .filter((r) => r.frozen || Number(r.decay_factor) < 0.5)
    .sort((a, b) => {
      // 동결 우선, 그다음 원점수 높은 순
      if (a.frozen !== b.frozen) return a.frozen ? -1 : 1
      return Number(b.final_score) - Number(a.final_score)
    })

  // Stale-but-High: 원점수는 높은데 델타(낡음 페널티)가 큰 상위
  const staleButHigh = [...rows]
    .filter((r) => Number(r.final_score) >= 40)
    .sort((a, b) => Number(b.delta) - Number(a.delta))
    .slice(0, 15)

  // KPI
  const total = rows.length
  const frozenCount = rows.filter((r) => r.frozen).length
  const staleCount = rows.filter((r) => Number(r.decay_factor) < 0.5).length
  const avgDecay = total > 0 ? rows.reduce((s, r) => s + Number(r.decay_factor), 0) / total : 0

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🧊 신선도 보정 점수</h1>
          <p className="text-sm text-gray-500 mt-1">
            증거 나이 기반 지수 감쇠로 final_score 를 보정 — 낡은 증거 위에 선 점수를 가려낸다
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 설명 */}
      <div className="rounded border border-sky-200 bg-sky-50 px-4 py-3 text-xs text-sky-900">
        <strong>왜 필요한가</strong> · 같은 점수라도 근거가 <em>오늘 5개 소스 교차</em>인지{' '}
        <em>며칠 전 단일 1관측</em>인지에 따라 신뢰도가 다르다. 증거 나이에 반감기 감쇠를 적용해
        보정점수를 만들고, 드라이버 소스가 수집 실패(error/partial) 상태면 <strong>증거 동결</strong>{' '}
        배지를 단다. 보정점수로 소싱 우선순위를 재정렬하라.
      </div>

      {/* 반감기 필터 */}
      <div className="rounded border border-gray-200 px-4 py-3 flex flex-wrap items-center gap-3">
        <span className="text-xs text-gray-500">증거 반감기</span>
        {HALF_LIFE_OPTIONS.map((o) => (
          <Link
            key={o.v}
            href={`/admin/trend-radar/freshness?hl=${o.v}`}
            className={`px-2 py-1 text-xs rounded ${
              Math.abs(halfLife - o.v) < 0.001
                ? 'bg-sky-100 text-sky-700 font-semibold'
                : 'text-gray-500 hover:text-black'
            }`}
          >
            {o.label}
          </Link>
        ))}
        <span className="text-[11px] text-gray-400">
          반감기마다 증거 가중치 ½ → decay = exp(−ln2 · age / half_life)
        </span>
      </div>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          RPC 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            RPC <code>jimscanner_trends_freshness</code> 미적용 가능성. supabase/trends_freshness_rpc.sql
            적용 필요.
          </p>
        </div>
      )}

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="대상 상품" value={total} />
        <Kpi label="🧊 증거 동결" value={frozenCount} highlight={frozenCount > 0} />
        <Kpi label="⏳ 낡음(신선도<50%)" value={staleCount} highlight={staleCount > 0} />
        <Kpi label="평균 신선도" value={`${(avgDecay * 100).toFixed(0)}%`} />
      </section>

      {!error && total === 0 && (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          점수 데이터 없음. scores 누적 후 다시 방문.
        </div>
      )}

      {/* Stale-but-High */}
      {staleButHigh.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-baseline gap-2">
            <h2 className="text-lg font-bold">⚠️ Stale-but-High</h2>
            <span className="text-xs text-gray-500">
              원점수는 높은데 증거가 낡아 보정 시 가장 많이 깎이는 상품 — 소싱 전 재수집 권장
            </span>
          </div>
          <div className="space-y-1.5">
            {staleButHigh.map((r) => (
              <div
                key={r.product_id}
                className="flex items-center gap-3 rounded border border-amber-200 bg-amber-50/40 px-3 py-2"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate" title={r.product_name ?? ''}>
                    {r.product_name ?? r.product_id.slice(0, 8)}
                    {r.frozen && <FrozenBadge sources={r.frozen_sources} />}
                  </div>
                  <div className="text-[11px] text-gray-500">
                    {r.category_top ?? 'all'} · 최신 증거 {fmtAge(r.evidence_age_hours)} 전 ·{' '}
                    소스 {(r.alias_sources ?? []).length}종 · 공급원 {r.supplier_count}
                  </div>
                </div>
                <DeltaBar final={Number(r.final_score)} adjusted={Number(r.freshness_adjusted_score)} />
                <div className="text-right w-28 flex-shrink-0">
                  <div className="text-[11px] text-gray-400 font-mono line-through">
                    {Number(r.final_score).toFixed(1)}
                  </div>
                  <div className="text-lg font-bold font-mono text-amber-700">
                    {Number(r.freshness_adjusted_score).toFixed(1)}
                  </div>
                  <div className="text-[10px] text-red-600 font-mono">
                    −{Number(r.delta).toFixed(1)} ({(Number(r.decay_factor) * 100).toFixed(0)}%)
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 재수집 필요 큐 */}
      {recollectQueue.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-baseline gap-2">
            <h2 className="text-lg font-bold">🔁 재수집 필요 큐</h2>
            <span className="text-xs text-gray-500">
              동결(드라이버 소스 실패) 또는 신선도 50% 미만 — 수집 cron 점검 우선순위
            </span>
          </div>
          <div className="grid md:grid-cols-2 gap-1.5">
            {recollectQueue.slice(0, 30).map((r) => (
              <div
                key={r.product_id}
                className={`flex items-center gap-2 rounded border px-3 py-2 ${
                  r.frozen ? 'border-sky-300 bg-sky-50' : 'border-gray-200'
                }`}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate" title={r.product_name ?? ''}>
                    {r.product_name ?? r.product_id.slice(0, 8)}
                    {r.frozen && <FrozenBadge sources={r.frozen_sources} />}
                  </div>
                  <div className="text-[11px] text-gray-500">
                    최신 증거 {fmtAge(r.evidence_age_hours)} 전 · 가장 낡은 {fmtAge(r.oldest_evidence_age_hours)} 전
                  </div>
                </div>
                <TrustMeter decay={Number(r.decay_factor)} />
              </div>
            ))}
          </div>
          {recollectQueue.length > 30 && (
            <p className="text-xs text-gray-400">+ {recollectQueue.length - 30}건 더</p>
          )}
        </section>
      )}

      {/* 보정점수 재정렬 전체 리스트 */}
      {reranked.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-baseline gap-2">
            <h2 className="text-lg font-bold">📊 보정점수 재정렬</h2>
            <span className="text-xs text-gray-500">freshness_adjusted_score 내림차순 (상위 50)</span>
          </div>
          <div className="overflow-x-auto rounded border border-gray-200">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500">
                <tr>
                  <th className="px-3 py-2 text-left">#</th>
                  <th className="px-3 py-2 text-left">상품</th>
                  <th className="px-3 py-2 text-left">소스</th>
                  <th className="px-3 py-2 text-center">신뢰</th>
                  <th className="px-3 py-2 text-right">원점수</th>
                  <th className="px-3 py-2 text-right">보정점수</th>
                  <th className="px-3 py-2 text-right">델타</th>
                </tr>
              </thead>
              <tbody>
                {reranked.slice(0, 50).map((r, i) => (
                  <tr key={r.product_id} className="border-t border-gray-100 hover:bg-gray-50">
                    <td className="px-3 py-2 font-mono text-gray-400">{i + 1}</td>
                    <td className="px-3 py-2">
                      <div className="font-medium truncate max-w-[220px]" title={r.product_name ?? ''}>
                        {r.product_name ?? r.product_id.slice(0, 8)}
                        {r.frozen && <FrozenBadge sources={r.frozen_sources} />}
                      </div>
                      <div className="text-[11px] text-gray-400">
                        {r.category_top ?? 'all'} · {fmtAge(r.evidence_age_hours)} 전
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {(r.alias_sources ?? []).slice(0, 4).map((s) => (
                          <span
                            key={s}
                            className="text-[10px] bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded"
                          >
                            {sourceLabel(s)}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-center">
                      <TrustMeter decay={Number(r.decay_factor)} />
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-gray-400">
                      {Number(r.final_score).toFixed(1)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono font-bold text-sky-700">
                      {Number(r.freshness_adjusted_score).toFixed(1)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-[12px] text-red-500">
                      −{Number(r.delta).toFixed(1)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* 공식 */}
      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 Freshness Decay 공식</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          age_days = (now − max(latest_alias, latest_supplier, computed_at)) / 86400
          <br />
          decay_factor = exp(−ln(2) × age_days / half_life_days)
          <br />
          freshness_adjusted_score = final_score × decay_factor
          <br />
          frozen = 드라이버 소스(alias.source)가 trends_runs 최신 상태 error/partial
        </code>
      </section>
    </div>
  )
}

function Kpi({
  label,
  value,
  highlight = false,
}: {
  label: string
  value: number | string
  highlight?: boolean
}) {
  return (
    <div className={`rounded border p-3 ${highlight ? 'border-sky-300 bg-sky-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${highlight ? 'text-sky-700' : ''}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}

// 신뢰 미터 — decay_factor(0~1) 를 막대로
function TrustMeter({ decay }: { decay: number }) {
  const pct = Math.max(0, Math.min(100, decay * 100))
  const color = pct >= 70 ? 'bg-emerald-500' : pct >= 40 ? 'bg-amber-500' : 'bg-red-500'
  return (
    <div className="inline-flex items-center gap-1.5" title={`신선도 ${pct.toFixed(0)}%`}>
      <div className="w-16 h-1.5 rounded-full bg-gray-200 overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] font-mono text-gray-500 w-8 text-right">{pct.toFixed(0)}%</span>
    </div>
  )
}

// 델타 막대 — 원점수 대비 보정점수의 손실폭 시각화
function DeltaBar({ final, adjusted }: { final: number; adjusted: number }) {
  const keepPct = final > 0 ? Math.max(0, Math.min(100, (adjusted / final) * 100)) : 0
  return (
    <div className="hidden sm:block w-28 flex-shrink-0" title={`보존 ${keepPct.toFixed(0)}%`}>
      <div className="h-2 rounded-full bg-red-200 overflow-hidden">
        <div className="h-full bg-sky-500" style={{ width: `${keepPct}%` }} />
      </div>
    </div>
  )
}

function FrozenBadge({ sources }: { sources: string[] | null }) {
  const list = (sources ?? []).map(sourceLabel).join(', ')
  return (
    <span
      title={list ? `동결 소스: ${list}` : '드라이버 소스 수집 실패'}
      className="ml-1.5 align-middle text-[10px] font-semibold px-1.5 py-0.5 rounded bg-sky-600 text-white"
    >
      🧊 동결
    </span>
  )
}
