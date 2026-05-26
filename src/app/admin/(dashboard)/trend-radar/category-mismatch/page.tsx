import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// ─────────────────────────────────────────────────────────────
// 행 (ggsan cate_cd) — 22 카테고리
// ─────────────────────────────────────────────────────────────
const GGSAN_CATEGORIES: { code: string; label: string }[] = [
  { code: '001', label: '장건강' },
  { code: '002', label: '눈건강' },
  { code: '003', label: '간건강' },
  { code: '005', label: '혈행건강' },
  { code: '006', label: '관절건강' },
  { code: '007', label: '면역건강' },
  { code: '008', label: '체지방' },
  { code: '009', label: '건강기능식품기타' },
  { code: '010', label: '전통건강식품' },
  { code: '011', label: '전립선건강' },
  { code: '012', label: '식품분말' },
  { code: '013', label: '가공식품기타' },
  { code: '014', label: '신선식품' },
  { code: '015', label: '오프라인전용' },
  { code: '018', label: '반려동물용품' },
  { code: '019', label: '고객사은품' },
  { code: '020', label: '임박특가' },
  { code: '021', label: '카테고리21' },
  { code: '022', label: '카테고리22' },
]

interface KeywordRow {
  keyword: string
  category_top: string | null
  classified_category: string | null
  pinned: boolean
  collected_at: string
}

interface GgsanRow {
  goods_no: string
  title: string
  cate_cd: string | null
  cate_label: string | null
  price_krw: number | null
  is_imminent: boolean
  first_seen_at: string
  last_seen_at: string
}

interface BridgeRow {
  trend_category: string
  trend_category_kind: 'category_top' | 'classified_category'
  ggsan_cate_cd: string
  weight: number
}

interface CellAgg {
  cate_cd: string
  demandRaw: number       // 트렌드 등장빈도 가중합 (핀율 보정)
  supplyRaw: number       // 활성 SKU + 30일 신규 비율
  activeSkus: number
  recentSkus: number
  keywordHits: number
  pinnedHits: number
}

// 표준점수 (z-score) 계산
function zScore(value: number, mean: number, std: number) {
  if (std === 0) return 0
  return (value - mean) / std
}

function meanAndStd(values: number[]): { mean: number; std: number } {
  if (values.length === 0) return { mean: 0, std: 0 }
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance =
    values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length
  return { mean, std: Math.sqrt(variance) }
}

async function fetchAll() {
  const sb = createAdminClient()
  const since30 = new Date(Date.now() - 30 * 86400_000).toISOString()

  const [keywordsRes, ggsanRes, bridgeRes] = await Promise.all([
    sb
      .from('jimscanner_trends_keywords')
      .select('keyword, category_top, classified_category, pinned, collected_at')
      .gte('collected_at', since30)
      .limit(20000),
    sb
      .from('jimscanner_ggsan_products')
      .select('goods_no, title, cate_cd, cate_label, price_krw, is_imminent, first_seen_at, last_seen_at')
      .limit(10000),
    // 마이그레이션 적용 전엔 테이블이 없을 수 있어 silent fallback.
    (sb as any)
      .from('jimscanner_trends_category_bridge')
      .select('trend_category, trend_category_kind, ggsan_cate_cd, weight')
      .limit(5000),
  ])

  const keywords = (keywordsRes.data ?? []) as KeywordRow[]
  const ggsan = (ggsanRes.data ?? []) as GgsanRow[]
  const bridge = (bridgeRes.data ?? []) as BridgeRow[]

  return { keywords, ggsan, bridge }
}

function buildMatrix(
  keywords: KeywordRow[],
  ggsan: GgsanRow[],
  bridge: BridgeRow[],
): { cells: Map<string, CellAgg>; demandByGgsan: Map<string, number>; supplyByGgsan: Map<string, number> } {
  const cells = new Map<string, CellAgg>()
  for (const c of GGSAN_CATEGORIES) {
    cells.set(c.code, {
      cate_cd: c.code,
      demandRaw: 0,
      supplyRaw: 0,
      activeSkus: 0,
      recentSkus: 0,
      keywordHits: 0,
      pinnedHits: 0,
    })
  }

  // bridge lookup: (kind, trend_category) → [(cate_cd, weight)]
  const bridgeLookup = new Map<string, { cate_cd: string; weight: number }[]>()
  for (const b of bridge) {
    const key = `${b.trend_category_kind}::${b.trend_category}`
    const arr = bridgeLookup.get(key) ?? []
    arr.push({ cate_cd: b.ggsan_cate_cd, weight: Number(b.weight) || 1 })
    bridgeLookup.set(key, arr)
  }

  // 수요지수 — 키워드별 등장 + 핀율 가중
  // 핀이 true 면 가중 1.5, 아니면 1.0
  for (const k of keywords) {
    const w = k.pinned ? 1.5 : 1.0
    const candidates: { kind: 'category_top' | 'classified_category'; val: string | null }[] = [
      { kind: 'category_top', val: k.category_top },
      { kind: 'classified_category', val: k.classified_category },
    ]
    // 중복 더하기 방지 — 매핑된 ggsan cate_cd 셋
    const matched = new Map<string, number>()
    for (const c of candidates) {
      if (!c.val) continue
      const arr = bridgeLookup.get(`${c.kind}::${c.val}`)
      if (!arr) continue
      for (const m of arr) {
        const prev = matched.get(m.cate_cd) ?? 0
        // 두 차원에서 매칭되면 최대값 사용 (이중계산 X)
        matched.set(m.cate_cd, Math.max(prev, m.weight))
      }
    }
    for (const [cate_cd, wt] of matched) {
      const cell = cells.get(cate_cd)
      if (!cell) continue
      cell.demandRaw += w * wt
      cell.keywordHits += 1
      if (k.pinned) cell.pinnedHits += 1
    }
  }

  // 공급지수 — 활성 SKU + 30일 신규 비율
  const since30Ms = Date.now() - 30 * 86400_000
  for (const g of ggsan) {
    if (!g.cate_cd) continue
    const cell = cells.get(g.cate_cd)
    if (!cell) continue
    cell.activeSkus += 1
    const firstSeen = g.first_seen_at ? new Date(g.first_seen_at).getTime() : 0
    if (firstSeen >= since30Ms) cell.recentSkus += 1
  }
  for (const cell of cells.values()) {
    // 신규비율 보정 (오래된 카탈로그라도 신규가 많으면 공급력↑)
    const recentRatio = cell.activeSkus > 0 ? cell.recentSkus / cell.activeSkus : 0
    cell.supplyRaw = cell.activeSkus * (1 + recentRatio)
  }

  const demandByGgsan = new Map<string, number>()
  const supplyByGgsan = new Map<string, number>()
  for (const cell of cells.values()) {
    demandByGgsan.set(cell.cate_cd, cell.demandRaw)
    supplyByGgsan.set(cell.cate_cd, cell.supplyRaw)
  }

  return { cells, demandByGgsan, supplyByGgsan }
}

// 게이지 색상 — whitespace = 수요 강·공급 약 → 빨강. 정상 = 회색. 공급과잉 = 파랑.
function gaugeColor(z: number): { bg: string; text: string; label: string } {
  if (z >= 1.5) return { bg: 'bg-red-600', text: 'text-white', label: '🔥 whitespace' }
  if (z >= 0.8) return { bg: 'bg-red-400', text: 'text-white', label: '수요>공급' }
  if (z >= 0.3) return { bg: 'bg-amber-300', text: 'text-gray-900', label: '소폭 수요우위' }
  if (z >= -0.3) return { bg: 'bg-gray-200', text: 'text-gray-700', label: '균형' }
  if (z >= -0.8) return { bg: 'bg-sky-300', text: 'text-gray-900', label: '소폭 공급우위' }
  if (z >= -1.5) return { bg: 'bg-sky-500', text: 'text-white', label: '공급>수요' }
  return { bg: 'bg-blue-700', text: 'text-white', label: '공급과잉' }
}

export default async function CategoryMismatchPage({
  searchParams,
}: {
  searchParams: Promise<{ cate?: string }>
}) {
  const sp = await searchParams
  const focusCate = sp.cate ?? ''

  const { keywords, ggsan, bridge } = await fetchAll()
  const { cells, demandByGgsan, supplyByGgsan } = buildMatrix(keywords, ggsan, bridge)

  // z-score 분포
  const demandValues = [...demandByGgsan.values()]
  const supplyValues = [...supplyByGgsan.values()]
  const dStat = meanAndStd(demandValues)
  const sStat = meanAndStd(supplyValues)

  type Row = {
    cate_cd: string
    label: string
    demand: number
    supply: number
    zDemand: number
    zSupply: number
    gap: number
    activeSkus: number
    recentSkus: number
    keywordHits: number
    pinnedHits: number
  }

  const rows: Row[] = GGSAN_CATEGORIES.map((c) => {
    const cell = cells.get(c.code)!
    const zDemand = zScore(cell.demandRaw, dStat.mean, dStat.std)
    const zSupply = zScore(cell.supplyRaw, sStat.mean, sStat.std)
    return {
      cate_cd: c.code,
      label: c.label,
      demand: cell.demandRaw,
      supply: cell.supplyRaw,
      zDemand,
      zSupply,
      gap: zDemand - zSupply,
      activeSkus: cell.activeSkus,
      recentSkus: cell.recentSkus,
      keywordHits: cell.keywordHits,
      pinnedHits: cell.pinnedHits,
    }
  })

  // gap 내림차순 정렬 (whitespace 후보 위로)
  rows.sort((a, b) => b.gap - a.gap)

  // KPI
  const whitespaceCount = rows.filter((r) => r.gap >= 0.8).length
  const oversupplyCount = rows.filter((r) => r.gap <= -0.8).length
  const totalKeywords = keywords.length
  const pinnedKeywords = keywords.filter((k) => k.pinned).length

  // Drill-down
  let drillKeywords: { keyword: string; pinned: boolean; hits: number }[] = []
  let drillSkus: GgsanRow[] = []
  if (focusCate) {
    // bridge 로 해당 ggsan cate 와 매칭되는 trend categories 모음
    const matchingTrendCats = new Set<string>()
    for (const b of bridge) {
      if (b.ggsan_cate_cd === focusCate) {
        matchingTrendCats.add(`${b.trend_category_kind}::${b.trend_category}`)
      }
    }
    const kwMap = new Map<string, { keyword: string; pinned: boolean; hits: number }>()
    for (const k of keywords) {
      const matched =
        (k.category_top && matchingTrendCats.has(`category_top::${k.category_top}`)) ||
        (k.classified_category && matchingTrendCats.has(`classified_category::${k.classified_category}`))
      if (!matched) continue
      const prev = kwMap.get(k.keyword)
      if (prev) {
        prev.hits += 1
        if (k.pinned) prev.pinned = true
      } else {
        kwMap.set(k.keyword, { keyword: k.keyword, pinned: k.pinned, hits: 1 })
      }
    }
    drillKeywords = [...kwMap.values()]
      .sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (b.hits - a.hits))
      .slice(0, 10)

    drillSkus = ggsan
      .filter((g) => g.cate_cd === focusCate)
      .sort((a, b) => (b.last_seen_at || '').localeCompare(a.last_seen_at || ''))
      .slice(0, 10)
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">카테고리 미스매치 히트맵</h1>
          <p className="text-sm text-gray-500 mt-1">
            ggsan 22 카테고리 × 트렌드 카테고리 매핑 — 30일 수요 vs 공급 z-score 차이로 whitespace 발굴
          </p>
        </div>
        <div className="text-xs text-gray-500">
          {bridge.length}개 브릿지 매핑 ·{' '}
          <span className="font-mono">jimscanner_trends_category_bridge</span>
        </div>
      </header>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard label="🔥 whitespace" value={whitespaceCount} hint="수요≫공급 (gap ≥ 0.8σ)" />
        <KpiCard label="공급과잉" value={oversupplyCount} hint="공급≫수요 (gap ≤ -0.8σ)" />
        <KpiCard label="30일 키워드" value={totalKeywords} hint={`핀: ${pinnedKeywords}`} />
        <KpiCard label="활성 SKU" value={ggsan.length} hint={`30일 신규 비율 반영`} />
      </section>

      {/* 매트릭스 (히트맵 row 시리즈) */}
      <section className="rounded border border-gray-200 overflow-hidden">
        <div className="grid grid-cols-12 px-3 py-2 text-xs font-semibold text-gray-500 bg-gray-50 border-b border-gray-200">
          <div className="col-span-2">ggsan 카테고리</div>
          <div className="col-span-1 text-right">수요</div>
          <div className="col-span-1 text-right">공급</div>
          <div className="col-span-1 text-right">z-수요</div>
          <div className="col-span-1 text-right">z-공급</div>
          <div className="col-span-2 text-right">gap (z-수요 − z-공급)</div>
          <div className="col-span-1 text-right">활성 SKU</div>
          <div className="col-span-1 text-right">30일 신규</div>
          <div className="col-span-1 text-right">키워드</div>
          <div className="col-span-1 text-right">핀</div>
        </div>
        {rows.map((r) => {
          const g = gaugeColor(r.gap)
          const active = focusCate === r.cate_cd
          return (
            <Link
              key={r.cate_cd}
              href={`/admin/trend-radar/category-mismatch?cate=${r.cate_cd}`}
              scroll={false}
              className={`grid grid-cols-12 px-3 py-2 text-sm border-b border-gray-100 hover:bg-amber-50 ${
                active ? 'bg-amber-100' : ''
              }`}
            >
              <div className="col-span-2 font-medium">
                <span className="text-gray-400 font-mono text-xs mr-1">{r.cate_cd}</span>
                {r.label}
              </div>
              <div className="col-span-1 text-right font-mono">{r.demand.toFixed(1)}</div>
              <div className="col-span-1 text-right font-mono">{r.supply.toFixed(1)}</div>
              <div className="col-span-1 text-right font-mono text-gray-500">{r.zDemand.toFixed(2)}</div>
              <div className="col-span-1 text-right font-mono text-gray-500">{r.zSupply.toFixed(2)}</div>
              <div className="col-span-2 text-right">
                <span
                  className={`inline-block px-2 py-0.5 rounded text-xs font-semibold ${g.bg} ${g.text}`}
                  title={g.label}
                >
                  {r.gap.toFixed(2)} · {g.label}
                </span>
              </div>
              <div className="col-span-1 text-right font-mono text-gray-600">{r.activeSkus}</div>
              <div className="col-span-1 text-right font-mono text-gray-600">{r.recentSkus}</div>
              <div className="col-span-1 text-right font-mono text-gray-600">{r.keywordHits}</div>
              <div className="col-span-1 text-right font-mono text-gray-600">{r.pinnedHits}</div>
            </Link>
          )
        })}
      </section>

      {/* 드릴다운 */}
      {focusCate ? (
        <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="rounded border border-gray-200 p-4">
            <h2 className="text-sm font-semibold mb-3">
              📈 매핑된 트렌드 키워드 Top 10{' '}
              <span className="text-xs font-normal text-gray-500 ml-1">
                (ggsan {focusCate} ↔ bridge)
              </span>
            </h2>
            {drillKeywords.length === 0 ? (
              <div className="text-sm text-gray-500 py-4 text-center">매칭 키워드 없음</div>
            ) : (
              <ul className="space-y-1">
                {drillKeywords.map((k, i) => (
                  <li key={k.keyword} className="grid grid-cols-12 px-2 py-1 text-sm rounded hover:bg-gray-50">
                    <span className="col-span-1 text-gray-400 font-mono">{i + 1}</span>
                    <span className="col-span-9 truncate">
                      {k.pinned && <span className="text-amber-500 mr-1">📌</span>}
                      {k.keyword}
                    </span>
                    <span className="col-span-2 text-right font-mono text-gray-500">{k.hits}회</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="rounded border border-gray-200 p-4">
            <h2 className="text-sm font-semibold mb-3">
              🏪 ggsan SKU Top 10{' '}
              <span className="text-xs font-normal text-gray-500 ml-1">
                (cate_cd={focusCate}, 최근 갱신)
              </span>
            </h2>
            {drillSkus.length === 0 ? (
              <div className="text-sm text-gray-500 py-4 text-center">활성 SKU 없음</div>
            ) : (
              <ul className="space-y-1">
                {drillSkus.map((s, i) => (
                  <li key={s.goods_no} className="grid grid-cols-12 px-2 py-1 text-sm rounded hover:bg-gray-50">
                    <span className="col-span-1 text-gray-400 font-mono">{i + 1}</span>
                    <span className="col-span-9 truncate">
                      {s.is_imminent && <span className="text-red-600 mr-1">⚡</span>}
                      {s.title}
                    </span>
                    <span className="col-span-2 text-right font-mono text-gray-500">
                      {s.price_krw ? `${s.price_krw.toLocaleString()}원` : '—'}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      ) : (
        <div className="rounded border border-dashed border-gray-300 p-6 text-center text-sm text-gray-500">
          행을 클릭하면 매칭 키워드 / SKU 드릴다운이 나타납니다.
        </div>
      )}

      {/* 푸터 — 룰 편집 가이드 */}
      <footer className="text-xs text-gray-500 pt-2 border-t border-gray-200">
        매핑 룰은{' '}
        <code className="bg-gray-100 px-1 rounded">supabase/trends_v4_category_bridge.sql</code>{' '}
        의 <code className="bg-gray-100 px-1 rounded">jimscanner_trends_category_bridge</code> 테이블에서 관리.
        weight 컬럼으로 부분 매칭 가능 (0~1). LLM 분류 또는 운영자가 직접 row 추가/수정.
      </footer>
    </div>
  )
}

function KpiCard({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-3xl font-bold mt-1">{value.toLocaleString()}</div>
      <div className="text-xs text-gray-400 mt-1">{hint}</div>
    </div>
  )
}
