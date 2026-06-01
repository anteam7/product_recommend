import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// ─────────────────────────────────────────────────────────────────────────────
// 발굴 포트폴리오 매니저 — 보유 SKU 대비 한계 다양성 기여도 보드
//
// 현재 등록/판매중 SKU(jimscanner_coupang_listings)로 '포트폴리오 프로파일'(카테고리·
// 가격대·시즌 편중)을 산출하고, 발굴 후보(jimscanner_ggsan_recommend RPC)마다
// '한계 다양성 기여도 = standalone final_score × 다양성 배수'를 계산한다.
// 같은 카테고리·유사 상품명(토큰 중복)으로 겹치는 후보는 카니발리제이션으로 강등,
// 빈 카테고리·비수기·다른 가격대를 채우는 후보는 가산.
// 신규 수집 불필요 — coupang_listings + ggsan_products(cate) + recommend RPC 조인만.
// ─────────────────────────────────────────────────────────────────────────────

interface ListingRow {
  source_goods_no: string | null
  registered_title: string | null
  list_price_krw: number | null
  status: string | null
  brand: string | null
}

interface GgsanCate {
  goods_no: string
  cate_cd: string | null
  cate_label: string | null
}

interface RecommendRow {
  goods_no: string
  title: string
  cate_cd: string | null
  cate_label: string | null
  price_krw: number | null
  final_score: number
}

// cate_cd → 수요 피크 시즌 휴리스틱 (건기식 계절성, v0 — 추후 trends_scores 시계열로 대체)
const SEASON_BY_CATE: Record<string, string> = {
  '001': '연중', // 장건강
  '002': '연중', // 눈건강
  '003': '겨울', // 간건강 (연말 회식)
  '005': '겨울', // 혈행건강
  '006': '환절기', // 관절건강
  '007': '겨울', // 면역건강
  '008': '봄/여름', // 체지방 (다이어트)
  '009': '연중', // 건기식기타
  '010': '겨울', // 전통건강식품
  '011': '연중', // 전립선
  '012': '연중', // 식품분말
  '013': '연중', // 가공식품기타
  '014': '봄/여름', // 신선식품
}
const SEASONS = ['겨울', '환절기', '봄/여름', '연중'] as const

const PRICE_BANDS: { label: string; min: number; max: number }[] = [
  { label: '~1만', min: 0, max: 10000 },
  { label: '1~2만', min: 10000, max: 20000 },
  { label: '2~3만', min: 20000, max: 30000 },
  { label: '3~5만', min: 30000, max: 50000 },
  { label: '5만+', min: 50000, max: Infinity },
]
function priceBand(p: number | null): string {
  const v = Number(p) || 0
  return (PRICE_BANDS.find((b) => v >= b.min && v < b.max) ?? PRICE_BANDS[0]).label
}

const STOP_TOKENS = new Set([
  '정', '캡슐', '캡', '포', '스틱', '환', '구미', '티백', '개입', '개', '병', '박스',
  '대용량', '국내산', '프리미엄', '정품', '건강기능식품', '건강식품', '영양제', 'mg', 'g', 'ml',
])
function tokenize(s: string): Set<string> {
  return new Set(
    (s || '')
      .replace(/[()[\]{}/,·\-+*~^|]/g, ' ')
      .split(/\s+/)
      .map((w) => w.replace(/\d+(mg|g|ml|정|포|개|캡슐|스틱|환)?$/i, '').trim())
      .filter((w) => [...w].length >= 2 && !STOP_TOKENS.has(w)),
  )
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / (a.size + b.size - inter)
}
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

async function fetchData() {
  // 일부 테이블(coupang_listings, ggsan_products)이 generated 타입 미반영 — `npm run gen:types` 후 캐스팅 제거
  const sb = createAdminClient() as any

  // 1) 보유 포트폴리오 — ggsan 소싱으로 실제 등록된 SKU (SKIPPED 제외)
  const { data: listingsRaw } = await sb
    .from('jimscanner_coupang_listings')
    .select('source_goods_no, registered_title, list_price_krw, status, brand')
    .eq('source', 'ggsan')
    .neq('status', 'SKIPPED')
    .not('seller_product_id', 'is', null)
  const listings = (listingsRaw ?? []) as ListingRow[]

  // 2) 보유 SKU 의 ggsan 카테고리 매핑
  const goodsNos = [...new Set(listings.map((l) => l.source_goods_no).filter(Boolean))] as string[]
  const cateByGoods = new Map<string, GgsanCate>()
  if (goodsNos.length) {
    const { data: gp } = await sb
      .from('jimscanner_ggsan_products')
      .select('goods_no, cate_cd, cate_label')
      .in('goods_no', goodsNos)
    for (const g of (gp ?? []) as GgsanCate[]) cateByGoods.set(g.goods_no, g)
  }

  // 3) 발굴 후보 (recommend RPC) — 신규 수집 없음
  let candidates: RecommendRow[] = []
  let rpcError: string | null = null
  const { data: rec, error } = await sb.rpc('jimscanner_ggsan_recommend' as never, {
    days_window: 30,
    min_sim: 0.2,
    min_score: 0.5,
    result_limit: 200,
  } as never)
  if (error) rpcError = error.message
  else candidates = (rec ?? []) as RecommendRow[]

  return { listings, cateByGoods, candidates, rpcError }
}

interface Held {
  cate_cd: string
  cate_label: string
  title: string
  tokens: Set<string>
  price: number | null
}

export default async function PortfolioPage() {
  const { listings, cateByGoods, candidates, rpcError } = await fetchData()

  // ── 보유 SKU 정규화 ─────────────────────────────────────────────────────────
  const held: Held[] = listings.map((l) => {
    const g = l.source_goods_no ? cateByGoods.get(l.source_goods_no) : undefined
    const title = l.registered_title ?? ''
    return {
      cate_cd: g?.cate_cd ?? '?',
      cate_label: g?.cate_label ?? '미분류',
      title,
      tokens: tokenize(title),
      price: l.list_price_krw,
    }
  })
  const totalHeld = held.length

  // 카테고리 분포
  const heldByCate = new Map<string, { label: string; count: number }>()
  for (const h of held) {
    const cur = heldByCate.get(h.cate_cd) ?? { label: h.cate_label, count: 0 }
    cur.count++
    heldByCate.set(h.cate_cd, cur)
  }
  const cateDist = [...heldByCate.entries()]
    .map(([cd, v]) => ({ cd, ...v }))
    .sort((a, b) => b.count - a.count)

  // 가격대 분포
  const priceDist = PRICE_BANDS.map((b) => ({
    label: b.label,
    count: held.filter((h) => priceBand(h.price) === b.label).length,
  }))

  // 시즌 분포 (편중·공백 진단)
  const seasonCount = (cd: string) => SEASON_BY_CATE[cd] ?? '연중'
  const seasonDist = SEASONS.map((s) => ({
    season: s,
    count: held.filter((h) => seasonCount(h.cate_cd) === s).length,
  }))
  const seasonTotal = seasonDist.reduce((s, x) => s + x.count, 0) || 1
  // 비중 낮은(공백) 시즌 = 다음 등록을 채우면 분산↑
  const underSeasons = new Set<string>(
    seasonDist.filter((s) => s.count / seasonTotal < 0.18).map((s) => s.season as string),
  )

  // ── 한계 다양성 기여도 ──────────────────────────────────────────────────────
  const heldTokensByCate = new Map<string, Set<string>[]>()
  for (const h of held) {
    const arr = heldTokensByCate.get(h.cate_cd) ?? []
    arr.push(h.tokens)
    heldTokensByCate.set(h.cate_cd, arr)
  }

  const scored = candidates.map((c) => {
    const cd = c.cate_cd ?? '?'
    const heldCount = heldByCate.get(cd)?.count ?? 0
    const share = totalHeld ? heldCount / totalHeld : 0

    const factors: { label: string; mult: number; tone: 'up' | 'down' }[] = []
    let mult = 1.0

    // (1) 카테고리 카니발리제이션 / 빈칸 가산
    if (heldCount === 0) {
      mult *= 1.6
      factors.push({ label: '빈 카테고리 진입 ×1.6', mult: 1.6, tone: 'up' })
    } else {
      const m = clamp(1 - share * 1.5, 0.25, 1.0)
      mult *= m
      if (m < 0.95)
        factors.push({
          label: `보유 ${heldCount}개 중복 ×${m.toFixed(2)}`,
          mult: m,
          tone: 'down',
        })
    }

    // (2) 상품명 토큰 중복 = 직접 카니발 (동의어 클러스터 프록시)
    const candTokens = tokenize(c.title)
    let maxOverlap = 0
    for (const ht of heldTokensByCate.get(cd) ?? []) maxOverlap = Math.max(maxOverlap, jaccard(candTokens, ht))
    if (maxOverlap >= 0.34) {
      mult *= 0.5
      factors.push({ label: `유사상품 중복(${Math.round(maxOverlap * 100)}%) ×0.5`, mult: 0.5, tone: 'down' })
    }

    // (3) 비수기/공백 시즌 채움 가산
    const season = seasonCount(cd)
    if (underSeasons.has(season)) {
      mult *= 1.25
      factors.push({ label: `공백 시즌(${season}) 채움 ×1.25`, mult: 1.25, tone: 'up' })
    }

    // (4) 가격대 다양화 — 보유 0인 가격대면 소폭 가산
    const band = priceBand(c.price_krw)
    if ((priceDist.find((p) => p.label === band)?.count ?? 0) === 0 && totalHeld > 0) {
      mult *= 1.1
      factors.push({ label: `빈 가격대(${band}) ×1.1`, mult: 1.1, tone: 'up' })
    }

    const marginal = Number(c.final_score) * mult
    return { ...c, season, band, mult, marginal, factors, maxOverlap }
  })
  scored.sort((a, b) => b.marginal - a.marginal)

  const maxCate = Math.max(1, ...cateDist.map((c) => c.count))
  const maxSeason = Math.max(1, ...seasonDist.map((s) => s.count))
  const maxPrice = Math.max(1, ...priceDist.map((p) => p.count))

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🧺 발굴 포트폴리오 매니저</h1>
          <p className="text-sm text-gray-500 mt-1">
            보유 {totalHeld}개 SKU 대비 <strong>한계 다양성 기여도</strong> — 다음 등록 1건을 어디에 쓰면 분산이 좋아지는지
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {totalHeld === 0 && (
        <div className="rounded border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
          아직 등록된 ggsan SKU 가 없습니다(coupang_listings). 등록 후 포트폴리오 갭이 채워집니다 — 현재는 후보의 standalone 점수만 표시.
        </div>
      )}

      {/* ── 포트폴리오 갭 뷰 ── */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* 카테고리 */}
        <div className="rounded border border-gray-200 p-4">
          <div className="text-sm font-semibold mb-3">카테고리 분포</div>
          {cateDist.length === 0 ? (
            <div className="text-xs text-gray-400">데이터 없음</div>
          ) : (
            <div className="space-y-1.5">
              {cateDist.map((c) => (
                <div key={c.cd} className="flex items-center gap-2 text-xs">
                  <div className="w-20 truncate text-gray-600" title={c.label}>{c.label}</div>
                  <div className="flex-1 bg-gray-100 rounded h-4 overflow-hidden">
                    <div className="h-full bg-emerald-400" style={{ width: `${(c.count / maxCate) * 100}%` }} />
                  </div>
                  <div className="w-6 text-right font-mono text-gray-500">{c.count}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 시즌 */}
        <div className="rounded border border-gray-200 p-4">
          <div className="text-sm font-semibold mb-3">수요 시즌 편중 <span className="text-[10px] text-gray-400">(휴리스틱 v0)</span></div>
          <div className="space-y-1.5">
            {seasonDist.map((s) => {
              const gap = underSeasons.has(s.season)
              return (
                <div key={s.season} className="flex items-center gap-2 text-xs">
                  <div className="w-16 text-gray-600">{s.season}</div>
                  <div className="flex-1 bg-gray-100 rounded h-4 overflow-hidden">
                    <div className={`h-full ${gap ? 'bg-rose-300' : 'bg-indigo-400'}`} style={{ width: `${(s.count / maxSeason) * 100}%` }} />
                  </div>
                  <div className="w-6 text-right font-mono text-gray-500">{s.count}</div>
                  {gap && <span className="text-[9px] text-rose-600">공백</span>}
                </div>
              )
            })}
          </div>
        </div>

        {/* 가격대 */}
        <div className="rounded border border-gray-200 p-4">
          <div className="text-sm font-semibold mb-3">가격대 분포</div>
          <div className="space-y-1.5">
            {priceDist.map((p) => (
              <div key={p.label} className="flex items-center gap-2 text-xs">
                <div className="w-16 text-gray-600">{p.label}</div>
                <div className="flex-1 bg-gray-100 rounded h-4 overflow-hidden">
                  <div className="h-full bg-amber-400" style={{ width: `${(p.count / maxPrice) * 100}%` }} />
                </div>
                <div className="w-6 text-right font-mono text-gray-500">{p.count}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {rpcError && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          추천 RPC 에러: <code className="font-mono text-xs">{rpcError}</code> — supabase/ggsan_recommend_rpc.sql 적용 필요.
        </div>
      )}

      {/* ── 한계 기여도 랭킹 ── */}
      <section className="space-y-2">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">한계 다양성 기여도 랭킹</h2>
          <div className="text-xs text-gray-500">marginal = final_score × 다양성 배수</div>
        </div>
        {scored.length === 0 ? (
          <div className="rounded border border-dashed border-gray-300 p-10 text-center text-gray-400 text-sm">
            후보 없음 — recommend 보드 데이터 누적 후 다시 방문.
          </div>
        ) : (
          <div className="space-y-2">
            {scored.slice(0, 60).map((c, i) => {
              const boosted = c.mult > 1.001
              const dragged = c.mult < 0.999
              return (
                <div
                  key={c.goods_no}
                  className={`rounded border p-3 flex items-start gap-3 ${
                    boosted ? 'border-emerald-200 bg-emerald-50/40' : dragged ? 'border-gray-200 bg-gray-50/60' : 'border-gray-200'
                  }`}
                >
                  <div className="w-7 text-center text-sm font-mono text-gray-400 pt-0.5">{i + 1}</div>
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="text-sm font-medium leading-snug truncate" title={c.title}>{c.title}</div>
                    <div className="text-xs text-gray-500">
                      {c.cate_label ?? c.cate_cd} · {c.season} · {c.band} · {c.goods_no}
                    </div>
                    <div className="flex flex-wrap gap-1.5 pt-0.5">
                      {c.factors.map((f, j) => (
                        <span
                          key={j}
                          className={`text-[10px] px-1.5 py-0.5 rounded ${
                            f.tone === 'up' ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-700'
                          }`}
                        >
                          {f.label}
                        </span>
                      ))}
                      {c.factors.length === 0 && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">중립 ×1.0</span>
                      )}
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className={`text-2xl font-bold font-mono ${boosted ? 'text-emerald-700' : dragged ? 'text-gray-400' : 'text-gray-700'}`}>
                      {c.marginal.toFixed(1)}
                    </div>
                    <div className="text-[10px] text-gray-400 font-mono">
                      {Number(c.final_score).toFixed(1)} × {c.mult.toFixed(2)}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* 공식 */}
      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 한계 다양성 기여도 공식</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          marginal = final_score × Π(배수)
          <br />
          • 빈 카테고리 ×1.6 · 보유 중복 ×clamp(1 − share×1.5, 0.25, 1.0)
          <br />
          • 상품명 토큰 Jaccard ≥ 0.34(유사상품) ×0.5 — 동의어 클러스터 프록시
          <br />
          • 공백 시즌 채움 ×1.25 · 빈 가격대 ×1.1
        </code>
        <div className="pt-1 text-gray-400">
          v0: 시즌은 카테고리 휴리스틱. 추후 jimscanner_trends_scores 시계열 계절성 + signal_cluster_map 동의어군으로 대체 예정.
        </div>
      </section>
    </div>
  )
}
