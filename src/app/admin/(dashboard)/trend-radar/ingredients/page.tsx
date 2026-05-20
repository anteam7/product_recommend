import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface IngredientVelocityRow {
  id: string
  name: string
  aliases: string[] | null
  functional_class: string | null
  regulatory_tag: string | null
  trk_14d: number
  trk_30d: number
  mr_suggest_14d: number
  mr_news_14d: number
  mr_blog_14d: number
  mr_14d: number
  mr_30d: number
  total_14d: number
  total_30d: number
  velocity: number | null
  trk_recent_kw: string | null
  trk_recent_src: string | null
}

interface MatchRow {
  goods_no: string
  title: string
  cate_cd: string | null
  cate_label: string | null
  price_krw: number | null
  is_imminent: boolean
  image_url: string | null
  detail_url: string | null
  matched_term: string
}

async function fetchVelocity(): Promise<{ rows: IngredientVelocityRow[]; error: string | null }> {
  const sb = createAdminClient()
  // ingredient_lexicon.sql 적용 후 generated 타입 캐시 미반영 — `as never` 캐스팅
  const { data, error } = await (sb
    .from('jimscanner_ingredient_velocity' as never)
    .select('*')
    .order('total_14d', { ascending: false })
    .limit(200) as unknown as Promise<{ data: IngredientVelocityRow[] | null; error: { message: string } | null }>)
  if (error) return { rows: [], error: error.message }
  return { rows: (data ?? []) as IngredientVelocityRow[], error: null }
}

async function fetchMatchesFor(ingredientId: string): Promise<MatchRow[]> {
  const sb = createAdminClient()
  const { data, error } = await sb.rpc(
    'jimscanner_ingredient_ggsan_matches' as never,
    { ingredient_id_in: ingredientId, result_limit: 12 } as never,
  )
  if (error) return []
  return (data ?? []) as MatchRow[]
}

function velocityClass(v: number | null): string {
  if (v == null) return 'text-gray-400'
  if (v >= 1.5) return 'text-red-700 font-semibold'
  if (v >= 1.1) return 'text-amber-700 font-medium'
  if (v >= 0.9) return 'text-gray-700'
  return 'text-gray-400'
}

function velocityLabel(v: number | null): string {
  if (v == null) return '—'
  if (v >= 1.5) return '🔥 급가속'
  if (v >= 1.1) return '↑ 가속'
  if (v >= 0.9) return '→ 평년'
  return '↓ 감속'
}

export default async function IngredientsPage({
  searchParams,
}: {
  searchParams: Promise<{ ing?: string; cls?: string }>
}) {
  const sp = await searchParams
  const selectedId = sp.ing ?? ''
  const filterClass = sp.cls ?? ''

  const { rows: allRows, error } = await fetchVelocity()

  // functional_class 목록
  const classSet = new Set<string>()
  for (const r of allRows) if (r.functional_class) classSet.add(r.functional_class)
  const classes = Array.from(classSet).sort()

  const rows = filterClass
    ? allRows.filter((r) => r.functional_class === filterClass)
    : allRows

  // 선택된 원료 → ggsan 매칭 카드
  let matches: MatchRow[] = []
  let selected: IngredientVelocityRow | null = null
  if (selectedId) {
    selected = allRows.find((r) => r.id === selectedId) ?? null
    if (selected) matches = await fetchMatchesFor(selectedId)
  }

  // KPI
  const totalIngredients = rows.length
  const acceleratingCount = rows.filter((r) => (r.velocity ?? 0) >= 1.1).length
  const mentioned14d = rows.filter((r) => r.total_14d > 0).length
  const totalMentions14d = rows.reduce((s, r) => s + r.total_14d, 0)

  function hrefFor(override: Record<string, string | null>): string {
    const p = new URLSearchParams()
    if (selectedId) p.set('ing', selectedId)
    if (filterClass) p.set('cls', filterClass)
    for (const [k, v] of Object.entries(override)) {
      if (v == null || v === '') p.delete(k)
      else p.set(k, v)
    }
    const qs = p.toString()
    return '/admin/trend-radar/ingredients' + (qs ? `?${qs}` : '')
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🧪 원료 ↔ ggsan 브릿지</h1>
          <p className="text-sm text-gray-500 mt-1">
            건기식 원료(NMN/베르베린/아쉬와간다…) 14/30일 멘션 velocity × ggsan 완제품 매칭. 브랜드 단위 trigram 매칭이 놓치는 원료-퍼스트 트렌드를 잡는다.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          <div className="font-semibold mb-1">데이터 조회 실패</div>
          <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            <code>jimscanner_ingredient_lexicon</code> / <code>jimscanner_ingredient_velocity</code> 미적용 가능성.
            <code className="ml-1">supabase/ingredient_lexicon.sql</code> 적용 필요.
          </p>
        </div>
      )}

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="원료 총수" value={totalIngredients} />
        <Kpi label="14일 멘션 있음" value={mentioned14d} />
        <Kpi label="↑ 가속 중" value={acceleratingCount} highlight={acceleratingCount > 0} />
        <Kpi label="14일 총 멘션" value={totalMentions14d} />
      </section>

      {/* 클래스 필터 */}
      {classes.length > 0 && (
        <div className="rounded border border-gray-200 px-4 py-3">
          <div className="flex flex-wrap gap-1 items-center">
            <span className="text-xs text-gray-500 mr-2">기능별</span>
            <Link
              href={hrefFor({ cls: null })}
              className={`px-2 py-1 text-xs rounded ${filterClass === '' ? 'bg-black text-white font-semibold' : 'text-gray-500 hover:text-black'}`}
            >
              전체
            </Link>
            {classes.map((c) => (
              <Link
                key={c}
                href={hrefFor({ cls: c })}
                className={`px-2 py-1 text-xs rounded ${filterClass === c ? 'bg-black text-white font-semibold' : 'text-gray-500 hover:text-black'}`}
              >
                {c}
              </Link>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* 좌: velocity 랭킹 */}
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-gray-700">
            원료 랭킹 ({rows.length}건) · 14일 멘션 ↓
          </h2>
          {rows.length === 0 ? (
            <div className="rounded border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500">
              조건에 맞는 원료 없음
            </div>
          ) : (
            <div className="space-y-1">
              {rows.map((r) => (
                <Link
                  key={r.id}
                  href={hrefFor({ ing: r.id })}
                  className={`block rounded border px-3 py-2 transition-colors ${
                    selectedId === r.id
                      ? 'border-amber-400 bg-amber-50'
                      : 'border-gray-200 hover:bg-gray-50'
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">{r.name}</div>
                      <div className="text-[11px] text-gray-500 truncate">
                        {r.functional_class ?? '—'}
                        {r.regulatory_tag ? ` · ${r.regulatory_tag}` : ''}
                        {r.aliases && r.aliases.length > 0 ? ` · alias ${r.aliases.length}` : ''}
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <div className="font-mono text-sm">
                        <span className="text-gray-700">{r.total_14d}</span>
                        <span className="text-gray-300"> / </span>
                        <span className="text-gray-400">{r.total_30d}</span>
                      </div>
                      <div className={`text-[11px] font-mono ${velocityClass(r.velocity)}`}>
                        {velocityLabel(r.velocity)} {r.velocity != null ? `(${r.velocity.toFixed(2)}x)` : ''}
                      </div>
                    </div>
                  </div>
                  {r.total_14d > 0 && (
                    <div className="flex gap-2 mt-1 text-[10px] text-gray-500">
                      {r.trk_14d > 0 && <span>📊 trends {r.trk_14d}</span>}
                      {r.mr_suggest_14d > 0 && <span>🔮 suggest {r.mr_suggest_14d}</span>}
                      {r.mr_news_14d > 0 && <span>📰 news {r.mr_news_14d}</span>}
                      {r.mr_blog_14d > 0 && <span>✍️ blog {r.mr_blog_14d}</span>}
                    </div>
                  )}
                </Link>
              ))}
            </div>
          )}
        </section>

        {/* 우: 매칭 ggsan 카드 */}
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-gray-700">
            {selected ? `🛒 "${selected.name}" 매칭 ggsan 상품` : '👈 좌측에서 원료 선택'}
          </h2>
          {selected ? (
            matches.length === 0 ? (
              <div className="rounded border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500">
                매칭 상품 없음 — alias 보강하거나 ggsan 카탈로그가 부족할 수 있음
                {selected.aliases && selected.aliases.length > 0 && (
                  <div className="text-[11px] text-gray-400 mt-2">
                    검색 term: {selected.name}, {selected.aliases.join(', ')}
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                {matches.map((m) => (
                  <a
                    key={m.goods_no}
                    href={m.detail_url ?? '#'}
                    target="_blank"
                    rel="noopener"
                    className={`block rounded border overflow-hidden hover:shadow-sm transition-shadow ${
                      m.is_imminent
                        ? 'border-red-200 bg-red-50/40 hover:bg-red-50'
                        : 'border-gray-200 hover:bg-gray-50'
                    }`}
                  >
                    <div className="flex items-start gap-3 p-3">
                      <div className="w-16 h-16 bg-gray-100 rounded overflow-hidden flex-shrink-0 relative">
                        {m.image_url && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={m.image_url} alt="" loading="lazy" className="w-full h-full object-cover" />
                        )}
                        {m.is_imminent && (
                          <span className="absolute top-0 left-0 bg-red-600 text-white text-[9px] px-1 leading-tight rounded-br">
                            임박
                          </span>
                        )}
                      </div>
                      <div className="flex-1 min-w-0 space-y-1">
                        <div className="text-sm font-medium leading-snug" title={m.title}>
                          {m.title}
                        </div>
                        <div className="text-[11px] text-gray-500">
                          {m.cate_label ?? m.cate_cd} · {m.goods_no}
                        </div>
                        <div className="text-[11px]">
                          <span className="bg-amber-100 text-amber-800 px-2 py-0.5 rounded">
                            🧪 매칭 term: &quot;{m.matched_term}&quot;
                          </span>
                        </div>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <div className="text-sm font-bold">
                          {m.price_krw ? `${m.price_krw.toLocaleString()}원` : '—'}
                        </div>
                      </div>
                    </div>
                  </a>
                ))}
              </div>
            )
          ) : (
            <div className="rounded border border-dashed border-gray-300 p-12 text-center text-sm text-gray-400">
              좌측 원료 카드를 클릭하면 매칭 ggsan 상품이 여기 나타납니다
            </div>
          )}
        </section>
      </div>

      {/* 공식 */}
      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 velocity 공식</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          velocity = (14d_mentions / 14) ÷ (30d_mentions / 30)
          <br />
          mentions = trends_keywords(원료ILIKE) + market_raw(google_suggest|naver_news|naver_blog, 원료ILIKE)
        </code>
        <div className="pt-2">
          1.0 = 평년, 1.1↑ = 가속, 1.5↑ = 급가속. 30일 합계가 0이면 NULL.
          <br />
          recommend RPC V1: <code>final_score</code> 에 <code>ingredient_score × 0.2</code> 가중치 반영
          (<code>supabase/ggsan_recommend_rpc_v1_ingredient.sql</code>).
        </div>
      </section>
    </div>
  )
}

function Kpi({ label, value, highlight = false }: { label: string; value: number | string; highlight?: boolean }) {
  return (
    <div className={`rounded border p-3 ${highlight ? 'border-amber-300 bg-amber-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${highlight ? 'text-amber-700' : ''}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}
