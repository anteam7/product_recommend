import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface DensityRow {
  keyword: string
  intent_count: number
  mention_count: number
  intent_density_pct: number | null
  where_to_buy_count: number
  recommend_count: number
  want_count: number
  alternative_count: number
  first_intent_at: string
  last_intent_at: string
  sources: string[]
}

interface IntentRow {
  id: string
  source: string
  source_url: string | null
  keyword: string
  intent_type: string
  price_band: string | null
  user_context: string | null
  quote: string
  confidence: number
  captured_at: string
}

const DAYS_OPTIONS = [
  { v: 7, label: '7일' },
  { v: 14, label: '14일' },
  { v: 30, label: '30일 (기본)' },
  { v: 60, label: '60일' },
] as const

const INTENT_TYPE_LABEL: Record<string, string> = {
  where_to_buy: '🛒 어디서 사',
  recommend_request: '🙋 추천 요청',
  want_to_buy: '💭 사고싶음',
  alternative: '🔄 대체상품',
}

function buildHref(current: Record<string, string>, override: Record<string, string | null>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/ugc-intent' + (qs ? `?${qs}` : '')
}

async function fetchData(days: number, selectedKeyword: string) {
  const sb = createAdminClient()
  const cutoff = new Date(Date.now() - days * 86400_000).toISOString()

  // 키워드별 밀도 — view 가 캐싱하므로 60일 기준이지만 클라이언트에선 days 별 정렬만
  const densityRes = await (sb
    .from('jimscanner_ugc_intent_density' as never)
    .select('*')
    .order('intent_count', { ascending: false })
    .limit(200) as unknown as Promise<{ data: DensityRow[] | null; error: { message: string } | null }>)

  // 최근 발화 인용 목록 (기간 적용)
  // 테이블이 generated 타입에 미반영 — `npm run gen:types` 시 캐스팅 제거
  let intentsQuery = sb
    .from('jimscanner_ugc_intent' as never)
    .select('id, source, source_url, keyword, intent_type, price_band, user_context, quote, confidence, captured_at')
    .gte('captured_at', cutoff)
    .order('captured_at', { ascending: false })
    .limit(100)
  if (selectedKeyword) intentsQuery = intentsQuery.eq('keyword', selectedKeyword)
  const intentsRes = (await intentsQuery) as unknown as {
    data: IntentRow[] | null
    error: { message: string } | null
  }

  return {
    density: (densityRes.data ?? []) as DensityRow[],
    densityError: densityRes.error?.message ?? null,
    intents: ((intentsRes.data as IntentRow[] | null) ?? []),
    intentsError: intentsRes.error?.message ?? null,
  }
}

export default async function UgcIntentPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; keyword?: string }>
}) {
  const sp = await searchParams
  const days = parseInt(sp.days ?? '30', 10)
  const validDays = DAYS_OPTIONS.some((d) => d.v === days) ? days : 30
  const keyword = (sp.keyword ?? '').trim()

  const current: Record<string, string> = {
    days: String(validDays),
    keyword,
  }

  const { density, densityError, intents, intentsError } = await fetchData(validDays, keyword)

  const totalIntents = density.reduce((s, r) => s + r.intent_count, 0)
  const topKeyword = density[0]?.keyword ?? '—'
  const avgDensity =
    density.length > 0
      ? density
          .filter((r) => r.intent_density_pct != null)
          .reduce((s, r) => s + (r.intent_density_pct ?? 0), 0) /
        Math.max(1, density.filter((r) => r.intent_density_pct != null).length)
      : 0

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">💬 UGC 구매의향 마이닝</h1>
          <p className="text-sm text-gray-500 mt-1">
            naver_blog/news + quasarzone 본문에서 추출한 잠재 구매의향 발화. Intent Density = 의향발화 / 키워드 총 멘션.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <div className="rounded border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
        <strong>왜 보는가</strong> · &quot;어디서 사요&quot; 같은 발화는 naver_search_trend 상승보다 평균 5-14일 선행하는
        진성 잠재수요. KCA·라이브커머스 같은 외생 시그널과 구조적으로 다른 *내생* 수요 시그널이다.
        <br />
        <strong>핀 결정 게이트</strong> · 추천 보드의 IntentDensity 컬럼에 합류돼 위탁 후보 핀 판단에 쓰임.
      </div>

      <div className="rounded border border-gray-200 px-4 py-3 space-y-3">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">기간 (발화 인용)</span>
            {DAYS_OPTIONS.map((d) => (
              <Link
                key={d.v}
                href={buildHref(current, { days: String(d.v) })}
                className={`px-2 py-1 text-xs rounded ${
                  validDays === d.v
                    ? 'bg-amber-100 text-amber-700 font-semibold'
                    : 'text-gray-500 hover:text-black'
                }`}
              >
                {d.label}
              </Link>
            ))}
          </div>
          {keyword && (
            <Link
              href={buildHref(current, { keyword: null })}
              className="px-3 py-1 text-xs rounded bg-black text-white"
            >
              ✕ &quot;{keyword}&quot; 필터 해제
            </Link>
          )}
        </div>
      </div>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="추출된 키워드" value={density.length} />
        <Kpi label="총 의향발화" value={totalIntents} />
        <Kpi label="Top 키워드" value={topKeyword} />
        <Kpi label="평균 Density" value={`${avgDensity.toFixed(1)}%`} />
      </section>

      {(densityError || intentsError) && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 space-y-1">
          {densityError && <div>Density view 에러: <code className="font-mono text-xs">{densityError}</code></div>}
          {intentsError && <div>Intent 테이블 에러: <code className="font-mono text-xs">{intentsError}</code></div>}
          <p className="text-xs mt-2 text-red-700">
            supabase/trends_v6_ugc_intent.sql 적용 여부 확인. cron: `node scripts/mine-ugc-intent.mjs`.
          </p>
        </div>
      )}

      {/* 키워드 랭킹 */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-gray-700">📊 키워드별 Intent Density 랭킹 (최근 60일)</h2>
        {density.length === 0 ? (
          <div className="rounded border border-dashed border-gray-300 p-8 text-center text-gray-500 text-sm">
            아직 추출된 의향 발화 없음. `node --env-file=.env.local scripts/mine-ugc-intent.mjs` 실행 필요.
          </div>
        ) : (
          <div className="overflow-x-auto rounded border border-gray-200">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="text-left px-3 py-2">#</th>
                  <th className="text-left px-3 py-2">키워드</th>
                  <th className="text-right px-3 py-2">의향발화</th>
                  <th className="text-right px-3 py-2">멘션</th>
                  <th className="text-right px-3 py-2">Density</th>
                  <th className="text-left px-3 py-2">유형 분포</th>
                  <th className="text-left px-3 py-2">최근발화</th>
                </tr>
              </thead>
              <tbody>
                {density.slice(0, 50).map((r, i) => (
                  <tr key={r.keyword} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50/60'}>
                    <td className="px-3 py-2 text-gray-400 font-mono">{i + 1}</td>
                    <td className="px-3 py-2">
                      <Link
                        href={buildHref(current, { keyword: r.keyword })}
                        className="font-medium text-amber-700 hover:underline"
                      >
                        {r.keyword}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-right font-mono font-semibold">{r.intent_count}</td>
                    <td className="px-3 py-2 text-right font-mono text-gray-500">{r.mention_count}</td>
                    <td className="px-3 py-2 text-right font-mono">
                      {r.intent_density_pct == null ? (
                        <span className="text-gray-300">—</span>
                      ) : (
                        <span
                          className={
                            r.intent_density_pct >= 30
                              ? 'text-red-700 font-bold'
                              : r.intent_density_pct >= 15
                                ? 'text-amber-700'
                                : 'text-gray-600'
                          }
                        >
                          {r.intent_density_pct.toFixed(1)}%
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-[10px] text-gray-600">
                      <Bar label="구매처" v={r.where_to_buy_count} max={r.intent_count} color="bg-red-300" />
                      <Bar label="추천" v={r.recommend_count} max={r.intent_count} color="bg-blue-300" />
                      <Bar label="희망" v={r.want_count} max={r.intent_count} color="bg-amber-300" />
                      <Bar label="대체" v={r.alternative_count} max={r.intent_count} color="bg-gray-300" />
                    </td>
                    <td className="px-3 py-2 text-gray-500 whitespace-nowrap">
                      {new Date(r.last_intent_at).toLocaleDateString('ko-KR')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 발화 원문 인용 */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-gray-700">
          💬 발화 원문 인용 {keyword && <span className="text-amber-700">— &quot;{keyword}&quot;</span>}
        </h2>
        {intents.length === 0 ? (
          <div className="text-xs text-gray-400 px-2">기간 내 인용 없음.</div>
        ) : (
          <div className="space-y-2">
            {intents.map((it) => (
              <div key={it.id} className="rounded border border-gray-200 px-3 py-2 text-xs space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="bg-amber-100 text-amber-800 px-2 py-0.5 rounded font-semibold">
                    {it.keyword}
                  </span>
                  <span className="bg-gray-100 text-gray-700 px-2 py-0.5 rounded">
                    {INTENT_TYPE_LABEL[it.intent_type] ?? it.intent_type}
                  </span>
                  {it.price_band && (
                    <span className="bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded">💰 {it.price_band}</span>
                  )}
                  {it.user_context && (
                    <span className="bg-purple-100 text-purple-800 px-2 py-0.5 rounded">👤 {it.user_context}</span>
                  )}
                  <span className="ml-auto text-[10px] text-gray-400 font-mono">
                    {it.source} · {new Date(it.captured_at).toLocaleDateString('ko-KR')} ·
                    conf {it.confidence.toFixed(2)}
                  </span>
                </div>
                <blockquote className="border-l-2 border-amber-300 pl-2 text-gray-700 italic">
                  “{it.quote}”
                </blockquote>
                {it.source_url && (
                  <a
                    href={it.source_url}
                    target="_blank"
                    rel="noopener"
                    className="text-[10px] text-blue-600 hover:underline"
                  >
                    원문 ↗
                  </a>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 지표 정의</div>
        <div>
          · <strong>Intent Density</strong> = 의향발화 수 / 키워드 총 멘션 수 (60일 누적). ≥30% 시 진성 수요 신호.
        </div>
        <div>
          · <strong>Intent→Search Conversion Lag</strong> = 의향발화 captured_at 후 N일 내 naver_search_trend 상승률 (V1 RPC 예정).
        </div>
        <div className="pt-2">
          <strong>마이닝 cron</strong>: <code className="bg-gray-100 px-1 rounded">node --env-file=.env.local scripts/mine-ugc-intent.mjs</code>
        </div>
      </section>
    </div>
  )
}

function Kpi({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded border border-gray-200 p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-2xl font-bold mt-1 truncate">
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}

function Bar({ label, v, max, color }: { label: string; v: number; max: number; color: string }) {
  if (v === 0) return null
  const pct = max > 0 ? Math.round((v / max) * 100) : 0
  return (
    <div className="flex items-center gap-1">
      <span className="w-8 text-gray-500">{label}</span>
      <div className="flex-1 h-1.5 bg-gray-100 rounded overflow-hidden min-w-[40px]">
        <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="font-mono w-6 text-right">{v}</span>
    </div>
  )
}
