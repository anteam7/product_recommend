import Link from 'next/link'
import {
  buildSourcingFitMatrix,
  getCellDrilldown,
  type MatrixCell,
  type Quadrant,
} from '@/lib/trend-radar/sourcing-fit'

export const dynamic = 'force-dynamic'

const QUADRANT_META: Record<Quadrant, { label: string; hint: string; cls: string; dot: string }> = {
  sourcing_gap: {
    label: '② 소싱갭',
    hint: '수요 있는데 ggsan 공급 ZERO — 공급처 발굴 or 발굴 스킵',
    cls: 'bg-rose-50 border-rose-300',
    dot: 'bg-rose-500',
  },
  focus: {
    label: '① 집중',
    hint: '수요高·공급高 — 지금 바로 등록 밀어붙일 영역',
    cls: 'bg-emerald-50 border-emerald-300',
    dot: 'bg-emerald-500',
  },
  idle_supply: {
    label: '③ 유휴재고',
    hint: '공급 있는데 발굴 수요 無 — 트렌드 시드 추가 신호',
    cls: 'bg-amber-50 border-amber-300',
    dot: 'bg-amber-500',
  },
  ignore: {
    label: '④ 무시',
    hint: '低·低 — 우선순위 낮음',
    cls: 'bg-gray-50 border-gray-200',
    dot: 'bg-gray-300',
  },
}

const ORDER: Quadrant[] = ['sourcing_gap', 'focus', 'idle_supply', 'ignore']

function CellCard({ cell, active }: { cell: MatrixCell; active: boolean }) {
  const meta = QUADRANT_META[cell.quadrant]
  return (
    <Link
      href={`/admin/trend-radar/sourcing-fit?cell=${encodeURIComponent(cell.key)}`}
      scroll={false}
      className={`block rounded border p-3 transition-all hover:shadow-sm ${meta.cls} ${
        active ? 'ring-2 ring-black' : ''
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-gray-900 truncate" title={cell.label}>
          {cell.label}
        </span>
        <span className={`h-2 w-2 rounded-full shrink-0 ${meta.dot}`} />
      </div>
      <div className="mt-2 flex items-end justify-between gap-2 text-xs">
        <div>
          <div className="text-gray-400">발굴 수요</div>
          <div className="font-bold text-gray-800">
            {cell.demandIndex.toLocaleString()}
            <span className="ml-1 font-normal text-gray-400">({cell.demandCount})</span>
          </div>
        </div>
        <div className="text-right">
          <div className="text-gray-400">소싱 공급</div>
          <div className="font-bold text-gray-800">
            {cell.supplyCount.toLocaleString()}
            {cell.imminentCount > 0 && (
              <span className="ml-1 font-normal text-red-500">임박{cell.imminentCount}</span>
            )}
          </div>
        </div>
      </div>
    </Link>
  )
}

export default async function SourcingFitPage({
  searchParams,
}: {
  searchParams: Promise<{ cell?: string }>
}) {
  const sp = await searchParams
  const activeCell = sp.cell ?? ''

  const [matrix, drill] = await Promise.all([
    buildSourcingFitMatrix(),
    activeCell ? getCellDrilldown(activeCell) : Promise.resolve(null),
  ])

  const byQuadrant = (q: Quadrant) => matrix.cells.filter((c) => c.quadrant === q)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">발굴 ↔ 소싱 정합 매트릭스</h1>
          <p className="text-sm text-gray-500 mt-1">
            발굴 수요(트렌드)와 소싱 공급(ggsan)을 같은 카테고리 축으로 교차 — 헛발굴(소싱 불가)·유휴공급(수요 미발굴)을 한눈에
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 요약 카드 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="rounded border border-gray-200 p-3">
          <div className="text-xs text-gray-400">발굴 상품</div>
          <div className="text-xl font-bold">{matrix.totals.demandProducts.toLocaleString()}</div>
        </div>
        <div className="rounded border border-gray-200 p-3">
          <div className="text-xs text-gray-400">소싱 가능(ggsan)</div>
          <div className="text-xl font-bold">{matrix.totals.supplyProducts.toLocaleString()}</div>
        </div>
        <div className="rounded border border-rose-200 bg-rose-50 p-3">
          <div className="text-xs text-rose-500">헛발굴 수요(소싱갭)</div>
          <div className="text-xl font-bold text-rose-700">{matrix.totals.sourcingGapDemand.toLocaleString()}</div>
        </div>
        <div className="rounded border border-amber-200 bg-amber-50 p-3">
          <div className="text-xs text-amber-600">유휴공급(수요無)</div>
          <div className="text-xl font-bold text-amber-700">{matrix.totals.idleSupply.toLocaleString()}</div>
        </div>
      </div>

      {matrix.cells.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 집계할 데이터 없음. 트렌드 score / ggsan 카탈로그 누적 후 다시 방문.
        </div>
      ) : (
        <div className="space-y-5">
          {ORDER.map((q) => {
            const cells = byQuadrant(q)
            if (cells.length === 0) return null
            const meta = QUADRANT_META[q]
            return (
              <section key={q}>
                <div className="flex items-baseline gap-2 mb-2">
                  <span className={`h-2.5 w-2.5 rounded-full ${meta.dot}`} />
                  <h2 className="text-sm font-bold text-gray-800">{meta.label}</h2>
                  <span className="text-xs text-gray-400">{meta.hint}</span>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                  {cells.map((c) => (
                    <CellCard key={c.key} cell={c} active={c.key === activeCell} />
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      )}

      <p className="text-xs text-gray-400">
        임계값: 발굴 수요 &gt; {Math.round(matrix.demandThreshold).toLocaleString()} · 소싱 공급 &gt;{' '}
        {Math.round(matrix.supplyThreshold).toLocaleString()} (각 nonzero 중앙값)
      </p>

      {/* 드릴다운 */}
      {drill && (
        <section className="rounded border border-gray-300 bg-white p-4 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold">드릴다운 — {drill.label}</h2>
            <Link href="/admin/trend-radar/sourcing-fit" scroll={false} className="text-xs text-gray-500 hover:text-black underline">
              닫기 ✕
            </Link>
          </div>
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <h3 className="text-sm font-semibold text-gray-700 mb-2">
                발굴 상품 <span className="text-gray-400">({drill.trends.length})</span>
              </h3>
              {drill.trends.length === 0 ? (
                <p className="text-xs text-gray-400">이 카테고리로 발굴된 상품 없음</p>
              ) : (
                <ul className="space-y-1">
                  {drill.trends.map((p) => (
                    <li key={p.id} className="flex items-center justify-between text-sm border-b border-gray-100 py-1">
                      <Link href={`/admin/trend-radar/products/${p.id}`} className="truncate hover:underline" title={p.name}>
                        {p.name}
                      </Link>
                      <span className="ml-2 shrink-0 text-xs text-gray-500">
                        {p.score != null ? Math.round(p.score) : '·'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h3 className="text-sm font-semibold text-gray-700 mb-2">
                ggsan 소싱 재고 <span className="text-gray-400">({drill.ggsan.length})</span>
              </h3>
              {drill.ggsan.length === 0 ? (
                <p className="text-xs text-rose-500">
                  소싱 가능한 ggsan 재고 없음 — 공급처 발굴 또는 발굴 스킵 대상
                </p>
              ) : (
                <ul className="space-y-1">
                  {drill.ggsan.map((p) => (
                    <li key={p.id} className="flex items-center justify-between text-sm border-b border-gray-100 py-1">
                      <span className="truncate" title={p.name}>{p.name}</span>
                      <span className="ml-2 shrink-0 text-xs text-gray-500">{p.detail ?? ''}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>
      )}
    </div>
  )
}
