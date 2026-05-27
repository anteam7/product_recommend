import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface HeroCandidate {
  hero_keyword: string
  recent_hits: number
  prev_hits: number | null
  recent_volume: number | null
  prev_volume: number | null
  surge_ratio: number | null
  category_top: string | null
  last_seen_at: string
  sources: string[] | null
}

interface HaloPair {
  id: string
  hero_keyword: string
  complement_keyword: string
  relation_type: string
  confidence: number
  source: string
  notes: string | null
  is_active: boolean
}

interface LagRow {
  pair_id: string
  hero_keyword: string
  complement_keyword: string
  relation_type: string
  lag_days: number | null
  hero_hits: number | null
  complement_hits: number | null
}

interface GgsanMatch {
  goods_no: string
  title: string
  price_krw: number | null
  is_imminent: boolean
  image_url: string | null
  detail_url: string | null
  cate_label: string | null
}

// 보완재 자동 시드 — 규칙 기반 휴리스틱 (LLM 보강 전 부트스트랩)
const RELATION_SUFFIXES: { type: string; suffixes: string[] }[] = [
  { type: 'case',       suffixes: ['케이스', '커버', '파우치'] },
  { type: 'film',       suffixes: ['필름', '강화유리', '액정보호'] },
  { type: 'mount',      suffixes: ['거치대', '스탠드', '홀더'] },
  { type: 'refill',     suffixes: ['리필', '교체용'] },
  { type: 'filter',     suffixes: ['필터'] },
  { type: 'battery',    suffixes: ['배터리', '보조배터리'] },
  { type: 'strap',      suffixes: ['스트랩', '줄', '밴드'] },
  { type: 'cable',      suffixes: ['케이블', '충전기'] },
  { type: 'consumable', suffixes: ['세제', '소모품'] },
]

const RELATION_LABEL: Record<string, string> = {
  case: '🛡 케이스', film: '📱 필름', mount: '🎯 거치대',
  refill: '♻ 리필', filter: '🌬 필터', battery: '🔋 배터리',
  strap: '🎀 스트랩', cable: '🔌 케이블', consumable: '🧴 소모품',
  other: '🔗 기타',
}

async function fetchHeroes(limit: number): Promise<HeroCandidate[]> {
  const sb = createAdminClient()
  // 뷰 jimscanner_halo_hero_candidates 는 supabase/trends_v4_halo_pairs.sql 적용 후 존재
  const { data, error } = await sb
    .from('jimscanner_halo_hero_candidates' as never)
    .select('*')
    .order('surge_ratio', { ascending: false, nullsFirst: false })
    .limit(limit) as unknown as { data: HeroCandidate[] | null; error: { message: string } | null }
  if (error) return []
  return data ?? []
}

async function fetchPairsForHeroes(heroKeywords: string[]): Promise<HaloPair[]> {
  if (heroKeywords.length === 0) return []
  const sb = createAdminClient()
  const { data, error } = await sb
    .from('jimscanner_halo_pairs' as never)
    .select('*')
    .in('hero_keyword', heroKeywords)
    .eq('is_active', true) as unknown as { data: HaloPair[] | null; error: { message: string } | null }
  if (error) return []
  return data ?? []
}

async function fetchLagSignals(pairIds: string[]): Promise<LagRow[]> {
  if (pairIds.length === 0) return []
  const sb = createAdminClient()
  const { data, error } = await sb
    .from('jimscanner_halo_lag_signal' as never)
    .select('*')
    .in('pair_id', pairIds) as unknown as { data: LagRow[] | null; error: { message: string } | null }
  if (error) return []
  return data ?? []
}

async function fetchGgsanMatches(complements: string[]): Promise<Record<string, GgsanMatch[]>> {
  if (complements.length === 0) return {}
  const sb = createAdminClient()
  const result: Record<string, GgsanMatch[]> = {}
  // 단순 ILIKE 매칭 — pg_trgm 가속은 추후
  for (const kw of complements) {
    const token = kw.split(/\s+/).pop() ?? kw
    if (!token || token.length < 2) continue
    const { data } = await sb
      .from('jimscanner_ggsan_products' as never)
      .select('goods_no,title,price_krw,is_imminent,image_url,detail_url,cate_label')
      .ilike('title', `%${token}%`)
      .limit(3) as unknown as { data: GgsanMatch[] | null }
    if (data && data.length > 0) result[kw] = data
  }
  return result
}

function generateHeuristicComplements(hero: string): { keyword: string; type: string }[] {
  const out: { keyword: string; type: string }[] = []
  for (const r of RELATION_SUFFIXES) {
    for (const sfx of r.suffixes) {
      out.push({ keyword: `${hero} ${sfx}`, type: r.type })
    }
  }
  return out.slice(0, 5)
}

function lagBadge(lagDays: number | null): { label: string; cls: string } {
  if (lagDays == null) return { label: '데이터 부족', cls: 'bg-gray-100 text-gray-500' }
  if (lagDays > 1) return { label: `D+${lagDays.toFixed(1)} 후행`, cls: 'bg-emerald-100 text-emerald-700' }
  if (lagDays < -1) return { label: `D${lagDays.toFixed(1)} 선행`, cls: 'bg-amber-100 text-amber-700' }
  return { label: '동시발생', cls: 'bg-blue-100 text-blue-700' }
}

export default async function HaloDemandPage({
  searchParams,
}: {
  searchParams: Promise<{ hero?: string; limit?: string }>
}) {
  const sp = await searchParams
  const limit = Math.min(parseInt(sp.limit ?? '20', 10) || 20, 50)
  const selectedHero = sp.hero ?? ''

  const heroes = await fetchHeroes(limit)
  const heroKeywords = heroes.map((h) => h.hero_keyword)
  const pairs = await fetchPairsForHeroes(heroKeywords)
  const lagSignals = await fetchLagSignals(pairs.map((p) => p.id))
  const lagByPair = new Map(lagSignals.map((l) => [l.pair_id, l]))

  const currentHero = selectedHero
    ? heroes.find((h) => h.hero_keyword === selectedHero) ?? heroes[0]
    : heroes[0]

  const currentPairs = currentHero
    ? pairs.filter((p) => p.hero_keyword === currentHero.hero_keyword)
    : []

  // 보완재 후보가 비어있으면 휴리스틱으로 가상 추천
  const heuristic = currentHero && currentPairs.length === 0
    ? generateHeuristicComplements(currentHero.hero_keyword)
    : []

  const complementKeywords = [
    ...currentPairs.map((p) => p.complement_keyword),
    ...heuristic.map((h) => h.keyword),
  ]
  const ggsanByComplement = await fetchGgsanMatches(complementKeywords)

  const pairedHeroSet = new Set(pairs.map((p) => p.hero_keyword))

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">✨ Halo 보완재 선점 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            급상승 hero 키워드/SKU 의 보완재(케이스·필름·거치대·리필·필터·배터리 등)를 사전 매핑해
            후행 surge 를 선점한다.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <div className="rounded border border-purple-200 bg-purple-50 px-4 py-3 text-xs text-purple-900">
        <strong>읽는 법</strong> · 좌측에서 hero 키워드를 클릭 → 우측에 매핑된 보완재 후보,
        D±n 일 lag, ggsan 도매 매칭 SKU 가 표시된다. 보완재 매핑이 없으면 휴리스틱(케이스/필름/...) 으로
        가상 추천. LLM 자동 매핑은 <code>scripts/classify-trends-llm.mjs</code> 확장으로 추가 예정.
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* 좌: hero 리스트 */}
        <div className="md:col-span-1 space-y-1">
          <div className="text-xs font-semibold text-gray-500 px-2 py-1">
            급상승 hero 후보 ({heroes.length}건)
          </div>
          {heroes.length === 0 && (
            <div className="rounded border border-dashed border-gray-300 p-6 text-center text-xs text-gray-400">
              hero 후보 없음. 검색·쇼핑 트렌드가 14일 이상 누적되면 자동 표시.
            </div>
          )}
          {heroes.map((h) => {
            const isActive = currentHero?.hero_keyword === h.hero_keyword
            const hasPairs = pairedHeroSet.has(h.hero_keyword)
            return (
              <Link
                key={h.hero_keyword}
                href={`/admin/trend-radar/halo-demand?hero=${encodeURIComponent(h.hero_keyword)}&limit=${limit}`}
                className={`block rounded border px-3 py-2 text-sm transition-all ${
                  isActive
                    ? 'border-purple-400 bg-purple-50 font-semibold'
                    : 'border-gray-200 hover:bg-gray-50'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="truncate">{h.hero_keyword}</div>
                  {hasPairs && <span className="text-[10px] text-emerald-700">✓매핑</span>}
                </div>
                <div className="flex items-center gap-2 mt-1 text-[10px] text-gray-500 font-mono">
                  <span>최근 {h.recent_hits}건</span>
                  <span>vs 이전 {h.prev_hits ?? 0}건</span>
                  {h.surge_ratio != null && (
                    <span className="text-purple-700 font-semibold">
                      ×{Number(h.surge_ratio).toFixed(1)}
                    </span>
                  )}
                </div>
                {h.category_top && (
                  <div className="text-[10px] text-gray-400 mt-0.5">{h.category_top}</div>
                )}
              </Link>
            )
          })}
        </div>

        {/* 우: 보완재 + lag + ggsan 매칭 */}
        <div className="md:col-span-2 space-y-3">
          {!currentHero ? (
            <div className="rounded border border-dashed border-gray-300 p-12 text-center text-sm text-gray-500">
              hero 를 선택하세요
            </div>
          ) : (
            <>
              <div className="rounded border border-gray-200 p-4 bg-gray-50">
                <div className="flex items-baseline justify-between gap-3 flex-wrap">
                  <div>
                    <div className="text-xs text-gray-500">선택된 hero</div>
                    <div className="text-xl font-bold">{currentHero.hero_keyword}</div>
                  </div>
                  <div className="text-right text-xs text-gray-600 space-y-0.5">
                    <div>
                      surge ×<span className="font-mono font-bold text-purple-700">
                        {currentHero.surge_ratio != null
                          ? Number(currentHero.surge_ratio).toFixed(2)
                          : '–'}
                      </span>
                    </div>
                    <div className="text-gray-400">
                      from {(currentHero.sources ?? []).join(', ') || '–'}
                    </div>
                  </div>
                </div>
              </div>

              {/* 매핑된 보완재 */}
              {currentPairs.length === 0 && heuristic.length === 0 ? (
                <div className="rounded border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500">
                  보완재 매핑 없음. SQL 으로 jimscanner_halo_pairs 에 시드를 추가하거나 LLM 분류기를 실행하세요.
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="text-xs font-semibold text-gray-600">
                    보완재 후보 ({currentPairs.length + heuristic.length}건)
                    {currentPairs.length === 0 && (
                      <span className="ml-2 text-amber-600">⚠ 휴리스틱 추천 — DB 매핑 없음</span>
                    )}
                  </div>

                  {currentPairs.map((p) => {
                    const lag = lagByPair.get(p.id)
                    const lagInfo = lagBadge(lag?.lag_days ?? null)
                    const ggMatches = ggsanByComplement[p.complement_keyword] ?? []
                    return (
                      <div key={p.id} className="rounded border border-gray-200 p-3 space-y-2">
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <div className="flex items-center gap-2">
                            <span className="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-700">
                              {RELATION_LABEL[p.relation_type] ?? p.relation_type}
                            </span>
                            <span className="font-medium text-sm">{p.complement_keyword}</span>
                            <span className={`text-[10px] px-2 py-0.5 rounded ${lagInfo.cls}`}>
                              {lagInfo.label}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 text-[10px] text-gray-500">
                            <span>conf {Number(p.confidence).toFixed(2)}</span>
                            <span>· {p.source}</span>
                            <PinHeroOriginButton
                              hero={currentHero.hero_keyword}
                              complement={p.complement_keyword}
                            />
                          </div>
                        </div>
                        {ggMatches.length > 0 && (
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1 border-t border-gray-100">
                            {ggMatches.map((g) => (
                              <a
                                key={g.goods_no}
                                href={g.detail_url ?? '#'}
                                target="_blank"
                                rel="noopener"
                                className="flex gap-2 items-start text-xs hover:bg-gray-50 rounded p-1"
                              >
                                <div className="w-10 h-10 bg-gray-100 rounded overflow-hidden flex-shrink-0">
                                  {g.image_url && (
                                    // eslint-disable-next-line @next/next/no-img-element
                                    <img src={g.image_url} alt="" loading="lazy" className="w-full h-full object-cover" />
                                  )}
                                </div>
                                <div className="min-w-0 flex-1">
                                  <div className="truncate" title={g.title}>{g.title}</div>
                                  <div className="text-gray-500 mt-0.5">
                                    {g.price_krw ? `${g.price_krw.toLocaleString()}원` : '–'}
                                    {g.is_imminent && <span className="ml-1 text-red-600">🔥임박</span>}
                                  </div>
                                </div>
                              </a>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}

                  {heuristic.map((h, idx) => {
                    const ggMatches = ggsanByComplement[h.keyword] ?? []
                    return (
                      <div key={`heur-${idx}`} className="rounded border border-dashed border-amber-300 p-3 space-y-2 bg-amber-50/40">
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <div className="flex items-center gap-2">
                            <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-700">
                              {RELATION_LABEL[h.type] ?? h.type}
                            </span>
                            <span className="font-medium text-sm">{h.keyword}</span>
                            <span className="text-[10px] px-2 py-0.5 rounded bg-gray-100 text-gray-500">
                              휴리스틱
                            </span>
                          </div>
                        </div>
                        {ggMatches.length > 0 && (
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1 border-t border-amber-200">
                            {ggMatches.map((g) => (
                              <a
                                key={g.goods_no}
                                href={g.detail_url ?? '#'}
                                target="_blank"
                                rel="noopener"
                                className="flex gap-2 items-start text-xs hover:bg-white rounded p-1"
                              >
                                <div className="w-10 h-10 bg-gray-100 rounded overflow-hidden flex-shrink-0">
                                  {g.image_url && (
                                    // eslint-disable-next-line @next/next/no-img-element
                                    <img src={g.image_url} alt="" loading="lazy" className="w-full h-full object-cover" />
                                  )}
                                </div>
                                <div className="min-w-0 flex-1">
                                  <div className="truncate" title={g.title}>{g.title}</div>
                                  <div className="text-gray-500 mt-0.5">
                                    {g.price_krw ? `${g.price_krw.toLocaleString()}원` : '–'}
                                  </div>
                                </div>
                              </a>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 Halo 공식 (V0)</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          hero_surge = recent_hits(7d) / prev_hits(7d)
          <br />
          lag_days = first_seen(complement) − first_seen(hero) (양수 = 후행)
          <br />
          진입 추천 = hero_surge ≥ 1.3 AND complement.confidence ≥ 0.5 AND ggsan 매칭 SKU 존재
        </code>
        <div className="pt-2">
          <strong>V1 보강 예정:</strong> LLM 자동 보완재 매핑 (classify-trends-llm 확장) ·
          shopping_insight 시계열 정밀 lag-correlation · 핀 발행 시 hero_keyword origin 자동 기록
        </div>
      </section>
    </div>
  )
}

function PinHeroOriginButton({ hero, complement }: { hero: string; complement: string }) {
  // 클라이언트 핀 발행 액션은 별도 라우트가 필요 — V0 에선 표시만, 클릭 시 핀 페이지로 이동
  return (
    <Link
      href={`/admin/trend-radar/pins?seed=${encodeURIComponent(complement)}&origin=${encodeURIComponent('halo:' + hero)}`}
      className="text-[10px] px-2 py-0.5 rounded bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
    >
      📌 진입 핀
    </Link>
  )
}
