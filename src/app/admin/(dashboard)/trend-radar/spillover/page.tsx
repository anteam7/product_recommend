import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface EdgeRow {
  a_cat: string
  b_cat: string
  best_lag_days: number
  corr: number
  sample_n: number
  avg_a_vol: number | null
  avg_b_vol: number | null
}

interface HotKw {
  keyword: string
  hit_count: number
  last_seen: string
}

interface GgsanCand {
  goods_no: string
  title: string
  cate_label: string | null
  price_krw: number | null
  is_imminent: boolean
}

const DEFAULT_MIN_CORR = 0.4
const DEFAULT_MIN_N = 8

async function fetchEdges(minCorr: number, minN: number) {
  const sb = createAdminClient()
  // 머터리얼라이즈드 뷰는 generated 타입 미반영 — any 캐스팅으로 우회
  // (`npm run gen:types` 시 캐스팅 제거)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fromAny = (sb as any).from('jimscanner_category_lag_edges')
  const { data, error } = await fromAny
    .select('a_cat, b_cat, best_lag_days, corr, sample_n, avg_a_vol, avg_b_vol')
    .gte('corr', minCorr)
    .gte('sample_n', minN)
    .order('corr', { ascending: false })
    .limit(200)

  if (error) return { rows: [] as EdgeRow[], error: error.message as string }
  return { rows: (data ?? []) as EdgeRow[], error: null as string | null }
}

async function fetchHotKeywords(cat: string): Promise<HotKw[]> {
  const sb = createAdminClient()
  const { data, error } = await sb.rpc(
    'jimscanner_category_hot_keywords' as never,
    { in_cat: cat, days_window: 7, result_limit: 6 } as never,
  )
  if (error || !data) return []
  return data as HotKw[]
}

async function fetchGgsanForCategory(catLabel: string): Promise<GgsanCand[]> {
  const sb = createAdminClient()
  // 간단한 trgm 매칭: ggsan 상품 title 이 카테고리 라벨과 유사한 후보
  const { data, error } = await sb
    .from('jimscanner_ggsan_products')
    .select('goods_no, title, cate_label, price_krw, is_imminent')
    .ilike('title', `%${catLabel}%`)
    .order('is_imminent', { ascending: false })
    .limit(4)
  if (error || !data) return []
  return data as GgsanCand[]
}

function lagBadgeStyle(lag: number) {
  if (lag <= 2) return 'bg-red-100 text-red-700'
  if (lag <= 5) return 'bg-amber-100 text-amber-700'
  if (lag <= 8) return 'bg-blue-100 text-blue-700'
  return 'bg-gray-100 text-gray-600'
}

function corrBarWidth(corr: number) {
  const pct = Math.min(100, Math.max(8, Math.round(corr * 100)))
  return `${pct}%`
}

export default async function SpilloverPage({
  searchParams,
}: {
  searchParams: Promise<{ corr?: string; n?: string; focus?: string }>
}) {
  const sp = await searchParams
  const minCorr = parseFloat(sp.corr ?? String(DEFAULT_MIN_CORR))
  const minN = parseInt(sp.n ?? String(DEFAULT_MIN_N), 10)
  const focus = sp.focus ?? ''

  const { rows, error } = await fetchEdges(
    Number.isFinite(minCorr) ? minCorr : DEFAULT_MIN_CORR,
    Number.isFinite(minN) ? minN : DEFAULT_MIN_N,
  )

  // 노드(카테고리) 집합 추출
  const nodes = new Set<string>()
  for (const r of rows) {
    nodes.add(r.a_cat)
    nodes.add(r.b_cat)
  }
  const nodeList = [...nodes].sort()

  // focus 카테고리 (UI 상단 카드용) — 명시 없으면 corr 최상위 엣지의 a_cat 사용
  const focusedCat = focus || rows[0]?.a_cat || ''

  // 상위 5개 엣지에 대해 자세한 카드를 만들기 위한 패치 데이터
  const topEdges = rows.slice(0, 5)
  const enriched = await Promise.all(
    topEdges.map(async (e) => {
      const [hot, ggsan] = await Promise.all([
        fetchHotKeywords(e.a_cat),
        fetchGgsanForCategory(e.b_cat),
      ])
      return { edge: e, aHot: hot, bGgsan: ggsan }
    }),
  )

  const focusHot = focusedCat ? await fetchHotKeywords(focusedCat) : []

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🌐 카테고리 Spillover Map</h1>
          <p className="text-sm text-gray-500 mt-1">
            인접 카테고리 간 lag 전파 — &lsquo;A 카테고리가 지금 뜨고 있다 → B 카테고리는 D-{`{lag}`}일
            후 뜰 가능성&rsquo;
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 한계 알림 */}
      <div className="rounded border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
        <strong>V0 한계</strong> · classified_category 가 비어있는 키워드는 category_top 으로 fallback.
        샘플 부족 페어는 제외 (sample_n &lt; {minN}). 양(+) 상관만 표시.
      </div>

      {/* 필터 */}
      <div className="rounded border border-gray-200 px-4 py-3 flex flex-wrap items-center gap-3">
        <span className="text-xs text-gray-500">corr ≥</span>
        {[0.3, 0.4, 0.5, 0.6].map((c) => (
          <Link
            key={c}
            href={`/admin/trend-radar/spillover?corr=${c}&n=${minN}${focus ? `&focus=${encodeURIComponent(focus)}` : ''}`}
            className={`px-2 py-1 text-xs rounded ${
              Math.abs(minCorr - c) < 0.001
                ? 'bg-amber-100 text-amber-700 font-semibold'
                : 'text-gray-500 hover:text-black'
            }`}
          >
            {c.toFixed(2)}
          </Link>
        ))}
        <span className="ml-4 text-xs text-gray-500">sample ≥</span>
        {[5, 8, 12].map((n) => (
          <Link
            key={n}
            href={`/admin/trend-radar/spillover?corr=${minCorr}&n=${n}${focus ? `&focus=${encodeURIComponent(focus)}` : ''}`}
            className={`px-2 py-1 text-xs rounded ${
              minN === n
                ? 'bg-amber-100 text-amber-700 font-semibold'
                : 'text-gray-500 hover:text-black'
            }`}
          >
            {n}
          </Link>
        ))}
      </div>

      {error && (
        <div className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          엣지 fetch 실패: {error}
          <div className="text-xs mt-1 text-red-700">
            materialized view <code>jimscanner_category_lag_edges</code> 가 아직 적용 안 됐을 수
            있음. <code>supabase/trends_v5_category_lag.sql</code> 적용 후 cron 1회 도는 것을 기다리세요.
          </div>
        </div>
      )}

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard label="엣지" value={rows.length} hint={`corr ≥ ${minCorr}`} />
        <KpiCard label="카테고리 노드" value={nodeList.length} hint="이번 필터에 포함" />
        <KpiCard
          label="평균 lag"
          value={
            rows.length
              ? Math.round(
                  (rows.reduce((s, r) => s + r.best_lag_days, 0) / rows.length) * 10,
                ) / 10
              : 0
          }
          hint="일"
        />
        <KpiCard
          label="평균 corr"
          value={
            rows.length
              ? Math.round((rows.reduce((s, r) => s + Number(r.corr), 0) / rows.length) * 100) /
                100
              : 0
          }
          hint=""
        />
      </section>

      {/* 'A가 지금 뜨고 있다' focus 카드 */}
      {focusedCat && (
        <section className="rounded border border-gray-200 p-4 bg-gray-50">
          <div className="text-xs text-gray-500 mb-2">선행 카테고리 (focus)</div>
          <div className="flex items-baseline gap-3 flex-wrap">
            <h2 className="text-lg font-bold">{focusedCat}</h2>
            <span className="text-xs text-gray-500">최근 7일 hot 키워드</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {focusHot.length === 0 ? (
              <span className="text-xs text-gray-400">데이터 없음</span>
            ) : (
              focusHot.map((k) => (
                <span
                  key={k.keyword}
                  className="px-2 py-0.5 text-xs rounded bg-white border border-gray-200"
                >
                  {k.keyword} <span className="text-gray-400 font-mono ml-1">{k.hit_count}</span>
                </span>
              ))
            )}
          </div>
        </section>
      )}

      {/* 상위 5개 엣지: 자세한 카드 (A hot keywords + B ggsan 후보) */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-3">
          🔥 Top spillover 페어 (corr × lag)
        </h2>
        {enriched.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="grid gap-3">
            {enriched.map(({ edge: e, aHot, bGgsan }) => (
              <div
                key={`${e.a_cat}->${e.b_cat}`}
                className="rounded border border-gray-200 bg-white p-4 space-y-3"
              >
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-2 text-sm">
                    <Link
                      href={`/admin/trend-radar/spillover?corr=${minCorr}&n=${minN}&focus=${encodeURIComponent(e.a_cat)}`}
                      className="font-bold hover:underline"
                    >
                      {e.a_cat}
                    </Link>
                    <span className="text-gray-400">→</span>
                    <Link
                      href={`/admin/trend-radar/spillover?corr=${minCorr}&n=${minN}&focus=${encodeURIComponent(e.b_cat)}`}
                      className="font-bold hover:underline"
                    >
                      {e.b_cat}
                    </Link>
                    <span className={`px-2 py-0.5 text-xs font-semibold rounded ${lagBadgeStyle(e.best_lag_days)}`}>
                      D-{e.best_lag_days}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-gray-500">
                    <span>
                      corr <span className="font-mono font-bold text-black">{Number(e.corr).toFixed(2)}</span>
                    </span>
                    <span>
                      n <span className="font-mono">{e.sample_n}</span>
                    </span>
                  </div>
                </div>
                <div className="h-1.5 bg-gray-100 rounded overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-amber-300 to-red-500"
                    style={{ width: corrBarWidth(Number(e.corr)) }}
                  />
                </div>
                <p className="text-xs text-gray-600">
                  <strong>{e.a_cat}</strong> 가 뜨면 약 <strong>{e.best_lag_days}일</strong> 뒤{' '}
                  <strong>{e.b_cat}</strong> 도 따라 오를 가능성. 운영자는 그 사이에 B 카테고리 위탁
                  후보를 선제 등록.
                </p>

                <div className="grid md:grid-cols-2 gap-3">
                  {/* A 카테고리 hot keywords */}
                  <div>
                    <div className="text-xs text-gray-500 mb-1">
                      ▸ {e.a_cat} 에서 지금 뜨는 키워드 (7일)
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {aHot.length === 0 ? (
                        <span className="text-xs text-gray-400">데이터 없음</span>
                      ) : (
                        aHot.map((k) => (
                          <span
                            key={k.keyword}
                            className="px-2 py-0.5 text-xs rounded bg-gray-50 border border-gray-200"
                          >
                            {k.keyword}{' '}
                            <span className="text-gray-400 font-mono ml-1">{k.hit_count}</span>
                          </span>
                        ))
                      )}
                    </div>
                  </div>

                  {/* B 카테고리 ggsan 후보 */}
                  <div>
                    <div className="text-xs text-gray-500 mb-1">
                      ▸ {e.b_cat} 키워드로 매칭된 ggsan 후보
                    </div>
                    <div className="space-y-1">
                      {bGgsan.length === 0 ? (
                        <span className="text-xs text-gray-400">매칭 없음</span>
                      ) : (
                        bGgsan.map((g) => (
                          <div key={g.goods_no} className="flex items-center gap-2 text-xs">
                            <span className="truncate">{g.title}</span>
                            {g.is_imminent && (
                              <span className="px-1 py-0.5 text-[10px] rounded bg-red-100 text-red-700">
                                임박
                              </span>
                            )}
                            {g.price_krw != null && (
                              <span className="ml-auto font-mono text-gray-500">
                                {g.price_krw.toLocaleString()}원
                              </span>
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 전체 엣지 테이블 */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-2">전체 엣지 ({rows.length})</h2>
        {rows.length === 0 ? (
          <div className="text-xs text-gray-400 px-3 py-6 text-center border border-dashed border-gray-200 rounded">
            현재 필터에 매칭되는 엣지가 없습니다.
          </div>
        ) : (
          <div className="overflow-x-auto rounded border border-gray-200">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500">
                <tr>
                  <th className="text-left px-3 py-2">A (선행)</th>
                  <th className="text-left px-3 py-2">B (후행)</th>
                  <th className="text-right px-3 py-2">best lag</th>
                  <th className="text-right px-3 py-2">corr</th>
                  <th className="text-right px-3 py-2">n</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={`${r.a_cat}->${r.b_cat}`}
                    className="border-t border-gray-100 hover:bg-gray-50"
                  >
                    <td className="px-3 py-1.5">
                      <Link
                        href={`/admin/trend-radar/spillover?corr=${minCorr}&n=${minN}&focus=${encodeURIComponent(r.a_cat)}`}
                        className="hover:underline"
                      >
                        {r.a_cat}
                      </Link>
                    </td>
                    <td className="px-3 py-1.5">{r.b_cat}</td>
                    <td className="px-3 py-1.5 text-right font-mono">D-{r.best_lag_days}</td>
                    <td className="px-3 py-1.5 text-right font-mono font-bold">
                      {Number(r.corr).toFixed(2)}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-gray-500">
                      {r.sample_n}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

function KpiCard({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="rounded border border-gray-200 p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-2xl font-bold mt-1">{value.toLocaleString()}</div>
      {hint && <div className="text-xs text-gray-400 mt-0.5">{hint}</div>}
    </div>
  )
}

function EmptyState() {
  return (
    <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
      <p className="text-base font-medium">아직 학습된 spillover 엣지가 없습니다</p>
      <p className="text-sm mt-2">
        recompute_scores cron 이 1회 이상 돈 후, jimscanner_refresh_category_lag() 가 호출돼야
        머터리얼라이즈드 뷰가 채워집니다.
        <br />
        분류된 키워드가 카테고리 당 최소 5일 이상 누적된 후에야 corr 가 계산됩니다.
      </p>
    </div>
  )
}
