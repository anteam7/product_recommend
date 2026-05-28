import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface CategoryRow {
  category: string
  sku_count: number
  modifier_count: number
}
interface DimRow {
  attr_dim: string
  value_count: number
  total_demand: number
}
interface MatrixCell {
  dim_a: string
  val_a: string
  dim_b: string
  val_b: string
  demand_a: number
  demand_b: number
  demand_score: number
  supply_count: number
  is_whitespace: boolean
  sample_supply_skus: string[] | null
}

const CATEGORY_LABEL: Record<string, string> = {
  water_bottle: '보온병',
  tumbler: '텀블러',
  omega3: '오메가3',
  probiotics: '유산균',
  collagen: '콜라겐',
  storage: '수납용품',
  kitchen_tool: '주방도구',
  air_purifier: '공기청정기',
  humidifier: '가습기',
  fan: '선풍기/서큘레이터',
}

const DIM_LABEL: Record<string, string> = {
  volume: '용량',
  size: '사이즈',
  color: '색상',
  material: '재질',
  feature: '핵심기능',
}

async function fetchCategories(): Promise<CategoryRow[]> {
  const sb = createAdminClient()
  const { data, error } = await (sb as any).rpc('jimscanner_spec_whitespace_categories')
  if (error || !data) return []
  return data as CategoryRow[]
}

async function fetchDims(category: string): Promise<DimRow[]> {
  const sb = createAdminClient()
  const { data, error } = await (sb as any).rpc('jimscanner_spec_whitespace_dims', {
    p_category: category,
  })
  if (error || !data) return []
  return data as DimRow[]
}

async function fetchMatrix(opts: {
  category: string
  dimA: string
  dimB: string
  topN: number
  minDemand: number
  maxSupply: number
}): Promise<MatrixCell[]> {
  const sb = createAdminClient()
  const { data, error } = await (sb as any).rpc('jimscanner_spec_whitespace_matrix', {
    p_category: opts.category,
    p_dim_a: opts.dimA,
    p_dim_b: opts.dimB,
    p_top_n: opts.topN,
    p_min_demand: opts.minDemand,
    p_max_supply: opts.maxSupply,
  })
  if (error || !data) return []
  return data as MatrixCell[]
}

export default async function SpecWhitespacePage({
  searchParams,
}: {
  searchParams: Promise<{
    category?: string
    dim_a?: string
    dim_b?: string
    top?: string
    min?: string
    max?: string
  }>
}) {
  const sp = await searchParams
  const categories = await fetchCategories()

  const category = sp.category || categories[0]?.category || 'water_bottle'

  const dims = await fetchDims(category)
  const dimA = sp.dim_a || dims[0]?.attr_dim || 'volume'
  const dimB = sp.dim_b || dims.find((d) => d.attr_dim !== dimA)?.attr_dim || 'color'
  const topN = Math.max(2, Math.min(12, Number(sp.top) || 8))
  const minDemand = Math.max(0, Number(sp.min) || 3)
  const maxSupply = Math.max(0, Number(sp.max) || 0)

  const cells =
    dims.length === 0
      ? []
      : await fetchMatrix({ category, dimA, dimB, topN, minDemand, maxSupply })

  // 2D pivot
  const valsA: string[] = []
  const valsB: string[] = []
  const cellMap = new Map<string, MatrixCell>()
  for (const c of cells) {
    if (!valsA.includes(c.val_a)) valsA.push(c.val_a)
    if (!valsB.includes(c.val_b)) valsB.push(c.val_b)
    cellMap.set(`${c.val_a}::${c.val_b}`, c)
  }

  const totalCells = cells.length
  const whitespaceCount = cells.filter((c) => c.is_whitespace).length

  // 색상 강도용 demand max
  const maxDemand = cells.reduce((m, c) => Math.max(m, c.demand_score), 0)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">SKU 사양 빈 공간 매트릭스</h1>
          <p className="text-sm text-gray-500 mt-1">
            카테고리별 사양 차원(용량·색상·재질·기능) cartesian product 매트릭스 · 검색 수요는
            있는데 공급 SKU 가 없는 빈 셀을 발굴 → ggsan 옵션 추가로 즉시 진입.
          </p>
        </div>
        <Link
          href="/admin/trend-radar"
          className="text-sm text-gray-700 hover:text-black underline"
        >
          ← 트렌드 레이더
        </Link>
      </header>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard label="카테고리" value={categories.length} hint="추출된 카테고리" />
        <KpiCard label="dim 수" value={dims.length} hint={CATEGORY_LABEL[category] || category} />
        <KpiCard label="매트릭스 셀" value={totalCells} hint={`top ${topN} × top ${topN}`} />
        <KpiCard
          label="whitespace 셀"
          value={whitespaceCount}
          hint={`demand≥${minDemand} · supply≤${maxSupply}`}
        />
      </section>

      {/* 컨트롤 */}
      <form className="flex flex-wrap items-end gap-3 rounded border border-gray-200 p-4 bg-gray-50/50">
        <ControlSelect
          name="category"
          label="카테고리"
          value={category}
          options={categories.map((c) => ({
            v: c.category,
            label: `${CATEGORY_LABEL[c.category] || c.category} (SKU ${c.sku_count} · mod ${c.modifier_count})`,
          }))}
        />
        <ControlSelect
          name="dim_a"
          label="X축 (행)"
          value={dimA}
          options={dims.map((d) => ({
            v: d.attr_dim,
            label: `${DIM_LABEL[d.attr_dim] || d.attr_dim} (${d.value_count})`,
          }))}
        />
        <ControlSelect
          name="dim_b"
          label="Y축 (열)"
          value={dimB}
          options={dims.map((d) => ({
            v: d.attr_dim,
            label: `${DIM_LABEL[d.attr_dim] || d.attr_dim} (${d.value_count})`,
          }))}
        />
        <ControlNumber name="top" label="top N" value={topN} min={2} max={12} />
        <ControlNumber name="min" label="min 수요" value={minDemand} min={0} max={1000} />
        <ControlNumber name="max" label="max 공급" value={maxSupply} min={0} max={100} />
        <button
          type="submit"
          className="px-4 py-2 bg-black text-white text-sm rounded hover:bg-gray-800"
        >
          매트릭스 갱신
        </button>
      </form>

      {/* 매트릭스 */}
      {cells.length === 0 ? (
        <EmptyState category={category} />
      ) : (
        <section className="space-y-3">
          <div className="text-xs text-gray-500">
            셀 표기 = <span className="font-mono">demand / supply</span> · 빨강 = whitespace
            (수요≥{minDemand} 인데 공급≤{maxSupply}) · 농도 = 결합 수요 기하평균
          </div>
          <div className="overflow-x-auto">
            <table className="border-collapse">
              <thead>
                <tr>
                  <th className="bg-gray-50 border border-gray-200 p-2 text-xs text-gray-500 text-left">
                    {DIM_LABEL[dimA] || dimA} \ {DIM_LABEL[dimB] || dimB}
                  </th>
                  {valsB.map((vb) => (
                    <th
                      key={vb}
                      className="bg-gray-50 border border-gray-200 p-2 text-xs font-medium whitespace-nowrap"
                    >
                      {vb}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {valsA.map((va) => (
                  <tr key={va}>
                    <th className="bg-gray-50 border border-gray-200 p-2 text-xs font-medium text-left whitespace-nowrap">
                      {va}
                    </th>
                    {valsB.map((vb) => {
                      const c = cellMap.get(`${va}::${vb}`)
                      if (!c)
                        return (
                          <td
                            key={vb}
                            className="border border-gray-200 p-2 text-xs text-gray-300 text-center"
                          >
                            —
                          </td>
                        )
                      return <Cell key={vb} cell={c} maxDemand={maxDemand} />
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 상위 whitespace 리스트 */}
          <div className="mt-6">
            <h2 className="text-sm font-semibold text-gray-700 mb-2">
              🎯 whitespace 후보 ({whitespaceCount})
            </h2>
            {whitespaceCount === 0 ? (
              <div className="text-sm text-gray-500 rounded border border-dashed border-gray-300 p-4">
                현재 임계값에서는 빈 셀 없음. min 수요를 낮추거나 max 공급을 늘려보세요.
              </div>
            ) : (
              <div className="grid gap-2">
                {cells
                  .filter((c) => c.is_whitespace)
                  .slice(0, 20)
                  .map((c, i) => (
                    <div
                      key={`${c.val_a}-${c.val_b}-${i}`}
                      className="grid grid-cols-12 px-3 py-2 rounded border border-red-200 bg-red-50/30 text-sm"
                    >
                      <div className="col-span-1 font-mono text-gray-400">{i + 1}</div>
                      <div className="col-span-4 font-medium">
                        {c.val_a} · {c.val_b}
                      </div>
                      <div className="col-span-2 text-right font-mono">
                        수요 {c.demand_score.toFixed(1)}
                      </div>
                      <div className="col-span-2 text-right font-mono">
                        ({c.demand_a} × {c.demand_b})
                      </div>
                      <div className="col-span-1 text-right font-mono text-red-700">
                        공급 {c.supply_count}
                      </div>
                      <div className="col-span-2 text-right text-xs text-gray-500 truncate">
                        {(c.sample_supply_skus || []).slice(0, 2).join(', ') || '—'}
                      </div>
                    </div>
                  ))}
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  )
}

function Cell({ cell, maxDemand }: { cell: MatrixCell; maxDemand: number }) {
  const intensity = maxDemand > 0 ? cell.demand_score / maxDemand : 0
  const bg = cell.is_whitespace
    ? `rgba(239, 68, 68, ${0.15 + intensity * 0.55})`
    : `rgba(59, 130, 246, ${0.05 + intensity * 0.35})`
  const title = `demand=${cell.demand_score.toFixed(1)} (${cell.demand_a}×${cell.demand_b}) · supply=${cell.supply_count}${cell.is_whitespace ? ' [WHITESPACE]' : ''}`
  return (
    <td
      className="border border-gray-200 p-2 text-xs text-center align-middle whitespace-nowrap"
      style={{ background: bg }}
      title={title}
    >
      <div className="font-mono">
        {cell.demand_score.toFixed(0)} <span className="text-gray-400">/</span>{' '}
        <span className={cell.is_whitespace ? 'font-bold text-red-700' : ''}>
          {cell.supply_count}
        </span>
      </div>
    </td>
  )
}

function KpiCard({
  label,
  value,
  hint,
}: {
  label: string
  value: number
  hint: string | number
}) {
  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-3xl font-bold mt-1">{value.toLocaleString()}</div>
      <div className="text-xs text-gray-400 mt-1">{hint}</div>
    </div>
  )
}

function ControlSelect({
  name,
  label,
  value,
  options,
}: {
  name: string
  label: string
  value: string
  options: { v: string; label: string }[]
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-gray-500">{label}</span>
      <select
        name={name}
        defaultValue={value}
        className="border border-gray-300 rounded px-2 py-1 text-sm bg-white min-w-[10rem]"
      >
        {options.length === 0 ? (
          <option value="">(없음)</option>
        ) : (
          options.map((o) => (
            <option key={o.v} value={o.v}>
              {o.label}
            </option>
          ))
        )}
      </select>
    </label>
  )
}

function ControlNumber({
  name,
  label,
  value,
  min,
  max,
}: {
  name: string
  label: string
  value: number
  min: number
  max: number
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-gray-500">{label}</span>
      <input
        type="number"
        name={name}
        defaultValue={value}
        min={min}
        max={max}
        className="border border-gray-300 rounded px-2 py-1 text-sm bg-white w-24"
      />
    </label>
  )
}

function EmptyState({ category }: { category: string }) {
  return (
    <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
      <p className="text-base font-medium">아직 데이터 없음</p>
      <p className="text-sm mt-2">
        카테고리 <code className="px-1 bg-gray-100 rounded">{category}</code> 에 SKU 사양 추출
        결과가 없습니다.
        <br />
        로컬에서 빌더를 1회 실행하세요:
      </p>
      <code className="inline-block mt-3 px-3 py-1 bg-gray-100 rounded text-xs">
        node --env-file=.env.local scripts/build-spec-whitespace.mjs
      </code>
    </div>
  )
}
