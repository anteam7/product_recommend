'use client'
import Link from 'next/link'
import { useMemo, useState } from 'react'

export interface MatrixRow {
  id: string
  name: string
  category: string
  trend_score: number
  commerce_score: number
  final_score: number
  import_demand_score: number
  manifest_count_90d: number
  manifest_count_30d: number
  single_item_ratio: number
  top_category_tag: string | null
  top_brand_raw: string | null
  countries: string[]
}

const CATEGORY_COLORS: Record<string, string> = {
  health: '#10b981',
  living: '#f59e0b',
  digital: '#3b82f6',
  community: '#a78bfa',
  shopping_tv: '#ef4444',
  all: '#6b7280',
}

const W = 720
const H = 480
const PAD = 56

export default function ImportValidationMatrix({ rows }: { rows: MatrixRow[] }) {
  const [hover, setHover] = useState<MatrixRow | null>(null)

  const xScale = (v: number) => PAD + (Math.min(100, Math.max(0, v)) / 100) * (W - 2 * PAD)
  const yScale = (v: number) => H - PAD - (Math.min(100, Math.max(0, v)) / 100) * (H - 2 * PAD)
  const rScale = (count: number) => 4 + Math.min(18, Math.sqrt(count) * 1.6)

  // 사분면 분류
  const quadrants = useMemo(() => {
    const q = { hh: 0, hl: 0, lh: 0, ll: 0 }
    for (const r of rows) {
      const hiTrend = r.trend_score >= 50
      const hiImport = r.import_demand_score >= 50
      if (hiTrend && hiImport) q.hh++
      else if (hiTrend && !hiImport) q.hl++
      else if (!hiTrend && hiImport) q.lh++
      else q.ll++
    }
    return q
  }, [rows])

  // 우상단 후보 (real demand validated)
  const validated = useMemo(
    () =>
      rows
        .filter((r) => r.trend_score >= 50 && r.import_demand_score >= 50)
        .sort((a, b) => b.import_demand_score + b.trend_score - (a.import_demand_score + a.trend_score))
        .slice(0, 15),
    [rows],
  )

  // 좌상단 (트렌드만 강하고 직구는 없는 — 헛 트렌드 의심)
  const hype = useMemo(
    () =>
      rows
        .filter((r) => r.trend_score >= 60 && r.import_demand_score < 30)
        .sort((a, b) => b.trend_score - a.trend_score)
        .slice(0, 10),
    [rows],
  )

  // 우하단 (직구는 일어나는데 트렌드 신호 약함 — sleeper hit 후보)
  const sleepers = useMemo(
    () =>
      rows
        .filter((r) => r.import_demand_score >= 50 && r.trend_score < 30)
        .sort((a, b) => b.import_demand_score - a.import_demand_score)
        .slice(0, 10),
    [rows],
  )

  return (
    <div className="space-y-6">
      <div className="rounded border border-gray-200 p-4">
        <div className="relative">
          <svg width={W} height={H} className="block mx-auto" style={{ overflow: 'visible' }}>
            {/* 우상단 (validated) 하이라이트 */}
            <rect
              x={xScale(50)}
              y={yScale(100)}
              width={xScale(100) - xScale(50)}
              height={yScale(50) - yScale(100)}
              fill="#f0fdf4"
            />
            {/* 좌상단 (hype) */}
            <rect
              x={xScale(0)}
              y={yScale(100)}
              width={xScale(50) - xScale(0)}
              height={yScale(50) - yScale(100)}
              fill="#fef2f2"
            />

            {/* grid */}
            {[0, 25, 50, 75, 100].map((v) => (
              <g key={'gx' + v}>
                <line
                  x1={xScale(v)}
                  y1={PAD}
                  x2={xScale(v)}
                  y2={H - PAD}
                  stroke="#e5e7eb"
                  strokeDasharray={v % 50 === 0 ? '' : '2,3'}
                />
                <text x={xScale(v)} y={H - PAD + 16} fontSize="10" fill="#9ca3af" textAnchor="middle">
                  {v}
                </text>
              </g>
            ))}
            {[0, 25, 50, 75, 100].map((v) => (
              <g key={'gy' + v}>
                <line
                  x1={PAD}
                  y1={yScale(v)}
                  x2={W - PAD}
                  y2={yScale(v)}
                  stroke="#e5e7eb"
                  strokeDasharray={v % 50 === 0 ? '' : '2,3'}
                />
                <text x={PAD - 8} y={yScale(v) + 4} fontSize="10" fill="#9ca3af" textAnchor="end">
                  {v}
                </text>
              </g>
            ))}

            <text x={W / 2} y={H - 10} fontSize="11" fill="#6b7280" textAnchor="middle">
              import_demand_score (→ 직구 실송장 많음)
            </text>
            <text
              x={18}
              y={H / 2}
              fontSize="11"
              fill="#6b7280"
              textAnchor="middle"
              transform={`rotate(-90 18 ${H / 2})`}
            >
              trend_score (↑ 관심 시그널 강함)
            </text>

            {/* 사분면 라벨 */}
            <text x={xScale(75)} y={yScale(95)} fontSize="11" fill="#10b981" fontWeight="bold" textAnchor="middle">
              ✓ 검증됨 (관심 + 실제 결제)
            </text>
            <text x={xScale(25)} y={yScale(95)} fontSize="11" fill="#ef4444" fontWeight="bold" textAnchor="middle">
              ⚠ 헛 트렌드 의심 (관심만)
            </text>
            <text x={xScale(75)} y={yScale(10)} fontSize="11" fill="#6b7280" textAnchor="middle">
              🌙 sleeper (직구만)
            </text>

            {/* 점들 */}
            {rows.map((r) => (
              <a key={r.id} href={`/admin/trend-radar/products/${r.id}`}>
                <circle
                  cx={xScale(r.import_demand_score)}
                  cy={yScale(r.trend_score)}
                  r={rScale(r.manifest_count_90d)}
                  fill={CATEGORY_COLORS[r.category] ?? '#6b7280'}
                  fillOpacity={0.55}
                  stroke={CATEGORY_COLORS[r.category] ?? '#6b7280'}
                  strokeOpacity={0.9}
                  onMouseEnter={() => setHover(r)}
                  onMouseLeave={() => setHover(null)}
                  style={{ cursor: 'pointer' }}
                />
              </a>
            ))}
          </svg>

          {hover && (
            <div className="absolute top-2 right-2 rounded bg-black/85 text-white text-xs px-3 py-2 max-w-xs">
              <div className="font-semibold">{hover.name}</div>
              <div>category: {hover.category}</div>
              <div>
                trend: {hover.trend_score.toFixed(0)} · import_demand:{' '}
                {hover.import_demand_score.toFixed(0)}
              </div>
              <div>
                90d 송장: {hover.manifest_count_90d} (30d: {hover.manifest_count_30d}) · 단일 비중{' '}
                {(hover.single_item_ratio * 100).toFixed(0)}%
              </div>
              {hover.top_category_tag ? <div>top tag: {hover.top_category_tag}</div> : null}
              {hover.top_brand_raw ? <div>top brand: {hover.top_brand_raw}</div> : null}
              {hover.countries.length > 0 ? <div>국가: {hover.countries.join(', ')}</div> : null}
            </div>
          )}
        </div>

        <div className="mt-4 flex flex-wrap gap-3 text-xs">
          {Object.entries(CATEGORY_COLORS).map(([cat, color]) => (
            <span key={cat} className="flex items-center gap-1">
              <span className="inline-block w-3 h-3 rounded-full" style={{ background: color, opacity: 0.6 }} />
              {cat}
            </span>
          ))}
        </div>

        <div className="mt-3 grid grid-cols-4 gap-2 text-xs">
          <div className="rounded bg-emerald-50 p-2">
            <div className="text-emerald-700 font-semibold">✓ 검증</div>
            <div className="text-emerald-900 text-lg">{quadrants.hh}</div>
          </div>
          <div className="rounded bg-red-50 p-2">
            <div className="text-red-700 font-semibold">⚠ 헛 트렌드</div>
            <div className="text-red-900 text-lg">{quadrants.hl}</div>
          </div>
          <div className="rounded bg-gray-50 p-2">
            <div className="text-gray-600 font-semibold">🌙 sleeper</div>
            <div className="text-gray-900 text-lg">{quadrants.lh}</div>
          </div>
          <div className="rounded bg-gray-50 p-2">
            <div className="text-gray-500 font-semibold">노이즈</div>
            <div className="text-gray-700 text-lg">{quadrants.ll}</div>
          </div>
        </div>
      </div>

      <section className="grid md:grid-cols-3 gap-4">
        <div className="rounded border border-emerald-200 bg-emerald-50/30 p-3">
          <h3 className="text-sm font-semibold mb-2 text-emerald-800">✓ 검증된 후보 (trend≥50 + import≥50)</h3>
          <div className="space-y-1 text-sm">
            {validated.length === 0 ? (
              <div className="text-gray-400 text-xs">아직 후보 없음.</div>
            ) : (
              validated.map((r) => (
                <Link
                  key={r.id}
                  href={`/admin/trend-radar/products/${r.id}`}
                  className="block px-2 py-1 rounded hover:bg-white"
                >
                  <span className="font-mono text-emerald-700 mr-2 text-xs">
                    {r.trend_score.toFixed(0)}/{r.import_demand_score.toFixed(0)}
                  </span>
                  {r.name}
                  <span className="text-gray-400 text-xs ml-1">· {r.manifest_count_90d}건</span>
                </Link>
              ))
            )}
          </div>
        </div>

        <div className="rounded border border-red-200 bg-red-50/30 p-3">
          <h3 className="text-sm font-semibold mb-2 text-red-800">⚠ 헛 트렌드 의심 (trend≥60, import&lt;30)</h3>
          <p className="text-xs text-red-700 mb-2">검색은 뜨지만 실제 직구는 안 일어남.</p>
          <div className="space-y-1 text-sm">
            {hype.length === 0 ? (
              <div className="text-gray-400 text-xs">없음.</div>
            ) : (
              hype.map((r) => (
                <Link
                  key={r.id}
                  href={`/admin/trend-radar/products/${r.id}`}
                  className="block px-2 py-1 rounded hover:bg-white"
                >
                  <span className="font-mono text-red-700 mr-2 text-xs">
                    {r.trend_score.toFixed(0)}/{r.import_demand_score.toFixed(0)}
                  </span>
                  {r.name}
                </Link>
              ))
            )}
          </div>
        </div>

        <div className="rounded border border-gray-200 p-3">
          <h3 className="text-sm font-semibold mb-2">🌙 Sleeper (import≥50, trend&lt;30)</h3>
          <p className="text-xs text-gray-500 mb-2">조용히 직구로 잘 팔리는 카테고리.</p>
          <div className="space-y-1 text-sm">
            {sleepers.length === 0 ? (
              <div className="text-gray-400 text-xs">없음.</div>
            ) : (
              sleepers.map((r) => (
                <Link
                  key={r.id}
                  href={`/admin/trend-radar/products/${r.id}`}
                  className="block px-2 py-1 rounded hover:bg-white"
                >
                  <span className="font-mono text-gray-600 mr-2 text-xs">
                    {r.trend_score.toFixed(0)}/{r.import_demand_score.toFixed(0)}
                  </span>
                  {r.name}
                  <span className="text-gray-400 text-xs ml-1">· {r.manifest_count_90d}건</span>
                </Link>
              ))
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
