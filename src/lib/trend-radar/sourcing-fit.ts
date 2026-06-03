/**
 * 발굴↔소싱 카테고리 정합 매트릭스 — 집계 로직 (서버 전용)
 *
 * 두 분포를 공통 카테고리 축으로 결합한다:
 *   (X) 발굴 수요: jimscanner_trends_products + 최신 scores.final_score → demand_index
 *   (Y) 소싱 공급: jimscanner_ggsan_products(cate_cd) → supply_index (재고수 / imminent)
 *
 * 정규화 매핑은 코드 내장 CANON 정적 매핑이 기본.
 * 운영자가 jimscanner_trends_category_map 에 row 를 넣으면 그걸 덮어쓴다.
 *
 * 4사분면:
 *   ① focus      수요高·공급高 = 집중
 *   ② sourcing_gap 수요高·공급ZERO = 소싱갭(공급처 발굴/스킵)
 *   ③ idle_supply 수요無·공급高 = 유휴재고(시드 추가 신호)
 *   ④ ignore     低·低 = 무시
 */
import { createAdminClient } from '@/lib/auth/admin-supabase'

export interface CanonCategory {
  key: string
  label: string
  top: 'health' | 'living' | 'digital' | null
  midKeywords: string[]
  ggsanCodes: string[]
}

/** 코드 내장 기본 정규화 매핑 (ggsan = 건강기능식품 22 카테고리 중심). */
export const CANON: CanonCategory[] = [
  { key: 'gut',         label: '장건강',       top: 'health', midKeywords: ['장', '유산균', '프로바이오', 'probiotic', 'gut'], ggsanCodes: ['001'] },
  { key: 'eye',         label: '눈건강',       top: 'health', midKeywords: ['눈', '루테인', '아이', 'eye', 'lutein'], ggsanCodes: ['002'] },
  { key: 'liver',       label: '간건강',       top: 'health', midKeywords: ['간', '밀크씨슬', '간건강', 'liver'], ggsanCodes: ['003'] },
  { key: 'blood',       label: '혈행건강',     top: 'health', midKeywords: ['혈행', '오메가', '혈압', '혈관', 'omega'], ggsanCodes: ['005'] },
  { key: 'joint',       label: '관절건강',     top: 'health', midKeywords: ['관절', '콜라겐', '연골', 'joint', 'collagen'], ggsanCodes: ['006'] },
  { key: 'immune',      label: '면역건강',     top: 'health', midKeywords: ['면역', '비타민', '홍삼', '아연', 'immune', 'vitamin'], ggsanCodes: ['007'] },
  { key: 'fat',         label: '체지방',       top: 'health', midKeywords: ['체지방', '다이어트', '가르시니아', '슬림', 'diet'], ggsanCodes: ['008'] },
  { key: 'supp_etc',    label: '건기식기타',   top: 'health', midKeywords: ['수면', '멜라토닌', '피로', '활력', 'sleep', 'melatonin'], ggsanCodes: ['009', '004'] },
  { key: 'traditional', label: '전통건강식품', top: 'health', midKeywords: ['홍삼', '녹용', '전통', '한방'], ggsanCodes: ['010'] },
  { key: 'prostate',    label: '전립선건강',   top: 'health', midKeywords: ['전립선', '쏘팔메토', 'prostate'], ggsanCodes: ['011'] },
  { key: 'powder',      label: '식품분말',     top: 'health', midKeywords: ['분말', '단백질', '프로틴', '쉐이크', 'protein'], ggsanCodes: ['012'] },
  { key: 'processed',   label: '가공식품',     top: 'health', midKeywords: ['가공식품', '간식', '식품'], ggsanCodes: ['013'] },
  { key: 'fresh',       label: '신선식품',     top: 'health', midKeywords: ['신선', '생물', '냉장'], ggsanCodes: ['014'] },
  { key: 'pet',         label: '반려동물',     top: null,     midKeywords: ['반려', '펫', '강아지', '고양이', '댕댕', 'pet'], ggsanCodes: ['018'] },
]

export type Quadrant = 'focus' | 'sourcing_gap' | 'idle_supply' | 'ignore'

export interface MatrixCell {
  key: string
  label: string
  top: string | null
  demandIndex: number   // 발굴 수요 (final_score 합)
  demandCount: number   // 발굴 상품 수
  supplyCount: number   // 소싱 가능 상품 수 (ggsan)
  imminentCount: number // 임박특가 수
  quadrant: Quadrant
}

export interface SourcingFitResult {
  cells: MatrixCell[]
  demandThreshold: number
  supplyThreshold: number
  totals: {
    demandProducts: number
    supplyProducts: number
    sourcingGapDemand: number   // 소싱 불가 수요 합 (헛발굴)
    idleSupply: number          // 수요 미발굴 공급 수 (유휴재고)
  }
}

interface ScoreRow {
  product_id: string
  final_score: number
  computed_at: string
}

/** category_top + mid + name 텍스트를 CANON 키로 분류. 미매칭이면 unmapped:<top>. */
function classifyDemand(
  canon: CanonCategory[],
  top: string | null,
  mid: string | null,
  name: string | null,
): string {
  const hay = `${mid ?? ''} ${name ?? ''}`.toLowerCase()
  for (const c of canon) {
    if (c.top && top && c.top !== top) continue
    if (c.midKeywords.some((kw) => hay.includes(kw.toLowerCase()))) return c.key
  }
  return `unmapped:${top ?? 'etc'}`
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

const TOP_LABELS: Record<string, string> = { health: '건강', living: '리빙', digital: '디지털', etc: '기타' }

/** 매트릭스 전체를 집계해 반환. 페이지·API 라우트 공용. */
export async function buildSourcingFitMatrix(): Promise<SourcingFitResult> {
  const sb = createAdminClient()

  // 운영자 오버라이드 매핑 (마이그레이션 후 존재 가정 · 없으면 정적 CANON)
  let canon = CANON
  try {
    const { data: mapRows } = await (sb as any)
      .from('jimscanner_trends_category_map')
      .select('canon_key, label, category_top, mid_keywords, ggsan_cate_cds, sort_order')
      .order('sort_order', { ascending: true })
    if (mapRows && mapRows.length > 0) {
      canon = (mapRows as any[]).map((r) => ({
        key: r.canon_key,
        label: r.label,
        top: r.category_top ?? null,
        midKeywords: r.mid_keywords ?? [],
        ggsanCodes: r.ggsan_cate_cds ?? [],
      }))
    }
  } catch {
    // 테이블 미생성 — 정적 CANON 사용
  }

  // ── (X) 발굴 수요: 최신 score 만 골라 product 카테고리에 매핑 ──
  const { data: scores } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, final_score, computed_at')
    .order('computed_at', { ascending: false })
    .limit(3000)

  const seen = new Set<string>()
  const latest: ScoreRow[] = []
  for (const s of (scores ?? []) as ScoreRow[]) {
    if (seen.has(s.product_id)) continue
    seen.add(s.product_id)
    latest.push(s)
  }

  const demand = new Map<string, { index: number; count: number }>()
  let demandProducts = 0
  if (latest.length > 0) {
    const ids = latest.map((s) => s.product_id)
    const { data: prods } = await sb
      .from('jimscanner_trends_products')
      .select('id, canonical_name, category_top, category_mid')
      .in('id', ids)
    const byId = new Map((prods ?? []).map((p: any) => [p.id, p]))
    for (const s of latest) {
      const p: any = byId.get(s.product_id) ?? {}
      const key = classifyDemand(canon, p.category_top ?? null, p.category_mid ?? null, p.canonical_name ?? null)
      const cur = demand.get(key) ?? { index: 0, count: 0 }
      cur.index += Number(s.final_score) || 0
      cur.count += 1
      demand.set(key, cur)
      demandProducts += 1
    }
  }

  // ── (Y) 소싱 공급: ggsan cate_cd 별 카운트 (CANON 코드별 병렬 head count) ──
  const supply = new Map<string, { count: number; imminent: number }>()
  const codeToKey = new Map<string, string>()
  for (const c of canon) for (const code of c.ggsanCodes) codeToKey.set(code, c.key)

  const codeCounts = await Promise.all(
    Array.from(codeToKey.keys()).map(async (code) => {
      const [{ count: total }, { count: imm }] = await Promise.all([
        sb.from('jimscanner_ggsan_products').select('*', { count: 'exact', head: true }).eq('cate_cd', code),
        sb
          .from('jimscanner_ggsan_products')
          .select('*', { count: 'exact', head: true })
          .eq('cate_cd', code)
          .eq('is_imminent', true),
      ])
      return { code, total: total ?? 0, imminent: imm ?? 0 }
    }),
  )
  let supplyProducts = 0
  for (const { code, total, imminent } of codeCounts) {
    const key = codeToKey.get(code)!
    const cur = supply.get(key) ?? { count: 0, imminent: 0 }
    cur.count += total
    cur.imminent += imminent
    supply.set(key, cur)
    supplyProducts += total
  }

  // ── 셀 결합 ──
  const allKeys = new Set<string>([...demand.keys(), ...supply.keys()])
  const labelOf = (key: string): { label: string; top: string | null } => {
    const c = canon.find((x) => x.key === key)
    if (c) return { label: c.label, top: c.top }
    if (key.startsWith('unmapped:')) {
      const top = key.slice('unmapped:'.length)
      return { label: `미매핑 · ${TOP_LABELS[top] ?? top}`, top }
    }
    return { label: key, top: null }
  }

  const rawCells = Array.from(allKeys).map((key) => {
    const d = demand.get(key) ?? { index: 0, count: 0 }
    const s = supply.get(key) ?? { count: 0, imminent: 0 }
    const { label, top } = labelOf(key)
    return {
      key,
      label,
      top,
      demandIndex: Math.round(d.index),
      demandCount: d.count,
      supplyCount: s.count,
      imminentCount: s.imminent,
    }
  })

  // ── 사분면 임계값: nonzero 값들의 중앙값 ──
  const demandThreshold = median(rawCells.filter((c) => c.demandIndex > 0).map((c) => c.demandIndex))
  const supplyThreshold = median(rawCells.filter((c) => c.supplyCount > 0).map((c) => c.supplyCount))

  const cells: MatrixCell[] = rawCells.map((c) => {
    const dHigh = c.demandIndex > demandThreshold && c.demandIndex > 0
    const sHigh = c.supplyCount > supplyThreshold && c.supplyCount > 0
    const sZero = c.supplyCount === 0
    const dZero = c.demandIndex === 0
    let quadrant: Quadrant
    if (sZero && c.demandIndex > 0) quadrant = 'sourcing_gap'
    else if (dZero && c.supplyCount > 0) quadrant = 'idle_supply'
    else if (dHigh && sHigh) quadrant = 'focus'
    else quadrant = 'ignore'
    return { ...c, quadrant }
  })

  // 정렬: 소싱갭(수요 큰 것) → 집중 → 유휴재고 → 무시
  const order: Record<Quadrant, number> = { sourcing_gap: 0, focus: 1, idle_supply: 2, ignore: 3 }
  cells.sort((a, b) => {
    if (order[a.quadrant] !== order[b.quadrant]) return order[a.quadrant] - order[b.quadrant]
    return b.demandIndex + b.supplyCount - (a.demandIndex + a.supplyCount)
  })

  const sourcingGapDemand = cells
    .filter((c) => c.quadrant === 'sourcing_gap')
    .reduce((acc, c) => acc + c.demandIndex, 0)
  const idleSupply = cells
    .filter((c) => c.quadrant === 'idle_supply')
    .reduce((acc, c) => acc + c.supplyCount, 0)

  return {
    cells,
    demandThreshold,
    supplyThreshold,
    totals: { demandProducts, supplyProducts, sourcingGapDemand, idleSupply },
  }
}

export interface DrilldownProduct {
  id: string
  name: string
  detail: string | null
  score: number | null
}

export interface CellDrilldown {
  key: string
  label: string
  trends: DrilldownProduct[]   // 이 카테고리로 발굴된 상위 상품
  ggsan: DrilldownProduct[]    // 이 카테고리에서 소싱 가능한 상위 ggsan 재고
}

/** 셀 클릭 시 해당 카테고리의 상위 발굴 상품 / ggsan 재고를 반환. */
export async function getCellDrilldown(key: string): Promise<CellDrilldown> {
  const sb = createAdminClient()
  const c = CANON.find((x) => x.key === key)
  const label = c?.label ?? (key.startsWith('unmapped:') ? `미매핑 · ${TOP_LABELS[key.slice(9)] ?? key.slice(9)}` : key)

  // 발굴 상품: 최신 score → product 매핑 → 이 key 로 분류된 것 상위 30
  const { data: scores } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, final_score, computed_at')
    .order('computed_at', { ascending: false })
    .limit(3000)
  const seen = new Set<string>()
  const latest: { product_id: string; final_score: number }[] = []
  for (const s of (scores ?? []) as ScoreRow[]) {
    if (seen.has(s.product_id)) continue
    seen.add(s.product_id)
    latest.push({ product_id: s.product_id, final_score: Number(s.final_score) || 0 })
  }
  const trends: DrilldownProduct[] = []
  if (latest.length > 0) {
    const ids = latest.map((s) => s.product_id)
    const { data: prods } = await sb
      .from('jimscanner_trends_products')
      .select('id, canonical_name, category_top, category_mid')
      .in('id', ids)
    const byId = new Map((prods ?? []).map((p: any) => [p.id, p]))
    const scoreById = new Map(latest.map((s) => [s.product_id, s.final_score]))
    for (const id of ids) {
      const p: any = byId.get(id)
      if (!p) continue
      const cls = classifyDemand(CANON, p.category_top ?? null, p.category_mid ?? null, p.canonical_name ?? null)
      if (cls !== key) continue
      trends.push({
        id,
        name: p.canonical_name ?? '?',
        detail: p.category_mid ?? p.category_top ?? null,
        score: scoreById.get(id) ?? null,
      })
    }
    trends.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  }

  // ggsan 재고: 이 canon 의 cate_cd 들에서 상위 30 (임박 우선 → 최신)
  let ggsan: DrilldownProduct[] = []
  if (c && c.ggsanCodes.length > 0) {
    const { data } = await sb
      .from('jimscanner_ggsan_products')
      .select('goods_no, title, cate_label, price_krw, is_imminent, detail_url, last_changed_at')
      .in('cate_cd', c.ggsanCodes)
      .order('is_imminent', { ascending: false })
      .order('last_changed_at', { ascending: false })
      .limit(30)
    ggsan = (data ?? []).map((g: any) => ({
      id: g.goods_no,
      name: g.title,
      detail: g.price_krw ? `${Number(g.price_krw).toLocaleString()}원${g.is_imminent ? ' · 임박' : ''}` : g.cate_label,
      score: null,
    }))
  }

  return { key, label, trends: trends.slice(0, 30), ggsan }
}
