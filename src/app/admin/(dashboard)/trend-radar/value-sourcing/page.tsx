import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// 신규 테이블/조인 — generated 타입 미반영. `npm run gen:types` 후 캐스팅 제거.
/* eslint-disable @typescript-eslint/no-explicit-any */

interface SpecRow {
  goods_no: string
  ingredient: string
  ingredient_raw: string | null
  mg_per_serving: number | null
  servings: number | null
  servings_per_day: number | null
  days_supply: number | null
  unit: string | null
  parse_confidence: number | null
  // joined product
  title: string
  price_krw: number | null
  cate_label: string | null
  cate_cd: string | null
  detail_url: string | null
  image_url: string | null
  status: string | null
  market_median: number | null
}

interface ValueRow extends SpecRow {
  total_mg: number | null
  won_per_mg: number | null // 함량당 도매원가 (₩/mg) — 낮을수록 가성비
  market_won_per_mg: number | null
  advantage_pct: number | null // 시장가 대비 도매가 우위 % (+면 ggsan 저렴)
}

interface IngredientGroup {
  ingredient: string
  rows: ValueRow[]
  bestWonPerMg: number | null
  demand: number // 검색수요 매칭 건수
  marketBeatCount: number // 시장가 대비 우위 제품 수
}

// 데모/검색수요 매칭용 원료 동의어 (룰)
const INGREDIENT_SYNONYMS: Record<string, string[]> = {
  루테인: ['루테인', 'lutein', '눈영양제', '아이케어'],
  밀크씨슬: ['밀크씨슬', '실리마린', 'milk thistle', '간영양제'],
  MSM: ['msm', '엠에스엠', '식이유황'],
  프로바이오틱스: ['프로바이오틱스', '유산균', 'probiotics', '락토'],
  콜라겐: ['콜라겐', 'collagen', '저분자콜라겐'],
  멜라토닌: ['멜라토닌', 'melatonin', '수면영양제'],
  오메가3: ['오메가3', 'omega', 'rTG', 'epa', 'dha'],
  비타민D: ['비타민d', 'vitamin d', '비타민디'],
  마그네슘: ['마그네슘', 'magnesium'],
  아연: ['아연', 'zinc'],
}

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? parseFloat(v) : (v as number)
  return Number.isFinite(n) ? n : null
}

async function fetchData(opts: { days: number; ingredient: string }) {
  const sb = createAdminClient() as any

  const specRes = await sb
    .from('jimscanner_ggsan_ingredient_specs')
    .select(
      'goods_no, ingredient, ingredient_raw, mg_per_serving, servings, servings_per_day, days_supply, unit, parse_confidence, ' +
        'jimscanner_ggsan_products!inner(title, price_krw, cate_label, cate_cd, detail_url, image_url, status, raw_payload)',
    )
    .limit(2000)

  if (specRes.error) {
    return { groups: [] as IngredientGroup[], totalSpecs: 0, error: specRes.error.message as string }
  }

  const cutoff = new Date(Date.now() - opts.days * 24 * 60 * 60 * 1000).toISOString()
  const kwRes = await sb
    .from('jimscanner_trends_keywords')
    .select('keyword')
    .gte('collected_at', cutoff)
    .limit(8000)
  const keywords: string[] = (kwRes.data ?? []).map((r: any) => String(r.keyword ?? '').toLowerCase())

  function demandFor(ingredient: string): number {
    const syns = (INGREDIENT_SYNONYMS[ingredient] ?? [ingredient]).map((s) => s.toLowerCase())
    let c = 0
    for (const kw of keywords) if (syns.some((s) => kw.includes(s))) c++
    return c
  }

  // spec → value row
  const rows: ValueRow[] = (specRes.data ?? []).map((s: any): ValueRow => {
    const prod = s.jimscanner_ggsan_products ?? {}
    const price = num(prod.price_krw)
    const mg = num(s.mg_per_serving)
    const servings = num(s.servings)
    const totalMg = mg != null && servings != null ? mg * servings : null
    const marketMedian = num(prod?.raw_payload?.market_price?.median)
    const wonPerMg = price != null && totalMg && totalMg > 0 ? price / totalMg : null
    const marketWonPerMg = marketMedian != null && totalMg && totalMg > 0 ? marketMedian / totalMg : null
    const advantagePct =
      marketMedian != null && marketMedian > 0 && price != null
        ? ((marketMedian - price) / marketMedian) * 100
        : null
    return {
      goods_no: s.goods_no,
      ingredient: s.ingredient,
      ingredient_raw: s.ingredient_raw,
      mg_per_serving: mg,
      servings,
      servings_per_day: num(s.servings_per_day),
      days_supply: num(s.days_supply),
      unit: s.unit,
      parse_confidence: num(s.parse_confidence),
      title: prod.title ?? '(제목 없음)',
      price_krw: price,
      cate_label: prod.cate_label ?? null,
      cate_cd: prod.cate_cd ?? null,
      detail_url: prod.detail_url ?? null,
      image_url: prod.image_url ?? null,
      status: prod.status ?? null,
      market_median: marketMedian,
      total_mg: totalMg,
      won_per_mg: wonPerMg,
      market_won_per_mg: marketWonPerMg,
      advantage_pct: advantagePct,
    }
  })

  // 그룹핑
  const byIng = new Map<string, ValueRow[]>()
  for (const r of rows) {
    if (opts.ingredient && r.ingredient !== opts.ingredient) continue
    if (!byIng.has(r.ingredient)) byIng.set(r.ingredient, [])
    byIng.get(r.ingredient)!.push(r)
  }

  const groups: IngredientGroup[] = [...byIng.entries()].map(([ingredient, grpRows]) => {
    // 함량단가 오름차순 (싼 게 위) — null 은 뒤로
    grpRows.sort((a, b) => {
      if (a.won_per_mg == null) return 1
      if (b.won_per_mg == null) return -1
      return a.won_per_mg - b.won_per_mg
    })
    const withCost = grpRows.filter((r) => r.won_per_mg != null)
    return {
      ingredient,
      rows: grpRows,
      bestWonPerMg: withCost.length > 0 ? withCost[0].won_per_mg : null,
      demand: demandFor(ingredient),
      marketBeatCount: grpRows.filter((r) => (r.advantage_pct ?? 0) > 0).length,
    }
  })

  // 정렬: 검색수요 높은 원료 우선, 동률이면 가성비 좋은(작은) 순
  groups.sort((a, b) => {
    if (b.demand !== a.demand) return b.demand - a.demand
    return (a.bestWonPerMg ?? Infinity) - (b.bestWonPerMg ?? Infinity)
  })

  return { groups, totalSpecs: rows.length, error: null as string | null }
}

const DAYS_OPTIONS = [
  { v: 7, label: '7일' },
  { v: 14, label: '14일' },
  { v: 30, label: '30일 (기본)' },
  { v: 60, label: '60일' },
] as const

function fmtWon(n: number | null): string {
  if (n == null) return '—'
  return n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(2)
}

export default async function ValueSourcingPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; ingredient?: string }>
}) {
  const sp = await searchParams
  const days = parseInt(sp.days ?? '30', 10)
  const validDays = DAYS_OPTIONS.some((d) => d.v === days) ? days : 30
  const ingredient = sp.ingredient ?? ''

  const { groups, totalSpecs, error } = await fetchData({ days: validDays, ingredient })

  const totalProducts = new Set(groups.flatMap((g) => g.rows.map((r) => r.goods_no))).size
  const totalBeat = groups.reduce((s, g) => s + g.marketBeatCount, 0)
  const hotIngredients = groups.filter((g) => g.demand > 0).length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">💊 함량당 가성비 소싱 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            Dose-Normalized Value · 원료별 <strong>함량당 도매원가(₩/mg)</strong> × 시장가 벤치마크 × 검색수요 교집합
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <div className="rounded border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
        <strong>핵심 지표</strong> · <code className="font-mono">₩/mg = 도매가 ÷ (1회함량 mg × 입수량)</code> — 같은 원료끼리만
        비교 가능. 시장가(median)는 쿠팡/다나와 수집분(<code>raw_payload.market_price.median</code>)을 동일 패키지 기준으로 대비.
        함량 스펙은 <code>jimscanner_ggsan_ingredient_specs</code>(룰 파서: scripts/ggsan-parse-ingredient-specs.mjs)에서 적재.
      </div>

      {/* 필터 */}
      <div className="rounded border border-gray-200 px-4 py-3 flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">검색수요 기간</span>
          {DAYS_OPTIONS.map((d) => {
            const params = new URLSearchParams()
            params.set('days', String(d.v))
            if (ingredient) params.set('ingredient', ingredient)
            return (
              <Link
                key={d.v}
                href={`/admin/trend-radar/value-sourcing?${params.toString()}`}
                className={`px-2 py-1 text-xs rounded ${validDays === d.v ? 'bg-amber-100 text-amber-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
              >
                {d.label}
              </Link>
            )
          })}
        </div>
        {ingredient && (
          <Link
            href={`/admin/trend-radar/value-sourcing?days=${validDays}`}
            className="px-3 py-1 text-xs rounded bg-black text-white font-semibold"
          >
            ✕ {ingredient} 필터 해제
          </Link>
        )}
      </div>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="원료 그룹" value={groups.length} />
        <Kpi label="스펙 적재 제품" value={totalProducts} />
        <Kpi label="🔥 검색수요 있는 원료" value={hotIngredients} highlight={hotIngredients > 0} />
        <Kpi label="시장가 대비 우위 제품" value={totalBeat} highlight={totalBeat > 0} />
      </section>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          쿼리 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            테이블 <code>jimscanner_ggsan_ingredient_specs</code> 가 DB에 미적용일 수 있음 — supabase/ggsan_ingredient_specs.sql
            적용 후 scripts/ggsan-parse-ingredient-specs.mjs 로 적재 필요.
          </p>
        </div>
      )}

      {!error && groups.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">함량 스펙 데이터 없음</div>
          <div className="text-xs text-gray-400">
            {totalSpecs === 0
              ? 'jimscanner_ggsan_ingredient_specs 가 비어있음. 마이그레이션 적용 후 파서 실행: node scripts/ggsan-parse-ingredient-specs.mjs'
              : '선택한 원료 필터에 해당하는 제품 없음.'}
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map((g) => (
            <section key={g.ingredient} className="rounded border border-gray-200 overflow-hidden">
              {/* 원료 헤더 */}
              <div className="flex items-center justify-between gap-3 bg-gray-50 px-4 py-2.5 border-b border-gray-200">
                <div className="flex items-center gap-3">
                  <Link
                    href={`/admin/trend-radar/value-sourcing?days=${validDays}&ingredient=${encodeURIComponent(g.ingredient)}`}
                    className="text-base font-bold hover:underline"
                  >
                    {g.ingredient}
                  </Link>
                  <span className="text-xs text-gray-500">{g.rows.length}개 제품</span>
                  {g.demand > 0 && (
                    <span className="bg-blue-100 text-blue-800 text-xs px-2 py-0.5 rounded">
                      🔍 검색수요 {g.demand}건 / {validDays}일
                    </span>
                  )}
                  {g.marketBeatCount > 0 && (
                    <span className="bg-emerald-100 text-emerald-800 text-xs px-2 py-0.5 rounded">
                      💰 시장가 우위 {g.marketBeatCount}건
                    </span>
                  )}
                </div>
                {g.bestWonPerMg != null && (
                  <div className="text-right">
                    <div className="text-[10px] text-gray-500">최저 함량단가</div>
                    <div className="font-mono font-bold text-amber-700">{fmtWon(g.bestWonPerMg)} ₩/mg</div>
                  </div>
                )}
              </div>

              {/* 제품 테이블 */}
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[11px] text-gray-500 border-b border-gray-100">
                      <th className="px-3 py-2 font-medium">#</th>
                      <th className="px-3 py-2 font-medium">제품</th>
                      <th className="px-3 py-2 font-medium text-right">함량 스펙</th>
                      <th className="px-3 py-2 font-medium text-right">도매가</th>
                      <th className="px-3 py-2 font-medium text-right">₩/mg</th>
                      <th className="px-3 py-2 font-medium text-right">시장가(median)</th>
                      <th className="px-3 py-2 font-medium text-right">시장가 대비</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.rows.map((r, i) => {
                      const isBest = g.bestWonPerMg != null && r.won_per_mg === g.bestWonPerMg
                      const beats = (r.advantage_pct ?? 0) > 0
                      return (
                        <tr
                          key={r.goods_no}
                          className={`border-b border-gray-50 ${isBest ? 'bg-amber-50/60' : ''}`}
                        >
                          <td className="px-3 py-2 text-gray-400 font-mono align-top">{i + 1}</td>
                          <td className="px-3 py-2 align-top">
                            <a
                              href={r.detail_url ?? '#'}
                              target="_blank"
                              rel="noopener"
                              className="font-medium hover:underline leading-snug block max-w-md truncate"
                              title={r.title}
                            >
                              {r.title}
                            </a>
                            <div className="text-[11px] text-gray-400">
                              {r.cate_label ?? r.cate_cd} · {r.goods_no}
                              {isBest && <span className="ml-1 text-amber-700 font-semibold">· 가성비 1위</span>}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-right align-top font-mono text-xs text-gray-600 whitespace-nowrap">
                            {r.mg_per_serving != null ? `${r.mg_per_serving}${r.unit ?? 'mg'}` : '—'}
                            {r.servings != null && ` × ${r.servings}`}
                            {r.total_mg != null && (
                              <div className="text-[10px] text-gray-400">총 {r.total_mg.toLocaleString()}mg</div>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right align-top font-medium whitespace-nowrap">
                            {r.price_krw != null ? `${r.price_krw.toLocaleString()}원` : '—'}
                          </td>
                          <td className="px-3 py-2 text-right align-top font-mono font-bold whitespace-nowrap">
                            <span className={isBest ? 'text-amber-700' : ''}>{fmtWon(r.won_per_mg)}</span>
                          </td>
                          <td className="px-3 py-2 text-right align-top text-gray-500 whitespace-nowrap">
                            {r.market_median != null ? `${r.market_median.toLocaleString()}원` : '—'}
                          </td>
                          <td className="px-3 py-2 text-right align-top whitespace-nowrap">
                            {r.advantage_pct != null ? (
                              <span
                                className={`px-2 py-0.5 rounded text-xs font-semibold ${
                                  beats ? 'bg-emerald-100 text-emerald-800' : 'bg-red-50 text-red-700'
                                }`}
                              >
                                {beats ? '▼' : '▲'} {Math.abs(r.advantage_pct).toFixed(0)}%
                              </span>
                            ) : (
                              <span className="text-gray-300 text-xs">시장가 X</span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </div>
      )}

      {/* 공식 설명 */}
      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 Dose-Normalized Value 공식</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          won_per_mg = 도매가 ÷ (mg_per_serving × servings)  — 낮을수록 함량당 가성비 우수
          <br />
          market_won_per_mg = 시장가median ÷ (mg_per_serving × servings)
          <br />
          advantage_pct = (시장가median − 도매가) ÷ 시장가median × 100  — +면 ggsan 저렴
        </code>
        <div className="pt-2">
          <strong>한계/후속:</strong> 함량 스펙은 룰 파서 1차분 — 복합제·억CFU(유산균)·IU 단위는 LLM 보강 필요. servings_per_day 미상 시
          days_supply 추정 부정확. 시장가 median 미수집 제품은 벤치마크 공란.
        </div>
      </section>
    </div>
  )
}

function Kpi({ label, value, highlight = false }: { label: string; value: number | string; highlight?: boolean }) {
  return (
    <div className={`rounded border p-3 ${highlight ? 'border-emerald-300 bg-emerald-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${highlight ? 'text-emerald-700' : ''}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}
