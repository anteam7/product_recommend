'use client'
import Link from 'next/link'
import { useState } from 'react'

interface BoardRow {
  product_id: string
  canonical_name: string
  category_top: string
  marketplace_count: number
  sku_count: number
  review_total_latest: number
  review_delta: number
  days_span: number
  review_per_day: number
  rating_avg: number | null
  est_sales_low: number
  est_sales_high: number
  ggsan_goods_no: string | null
  ggsan_title: string | null
  ggsan_price_krw: number | null
  observed_first: string
  observed_last: string
}

const CATEGORY_COLORS: Record<string, string> = {
  health: '#10b981',
  living: '#f59e0b',
  digital: '#3b82f6',
  all: '#6b7280',
}

// 사분면 좌표화를 위한 점 형태
interface Point extends BoardRow {
  x: number // 소싱가 점수 (0~100, 높을수록 저렴 = 마진 여력↑)
  y: number // 추정 판매 점수 (0~100)
}

export default function ReviewVelocityBoard({ rows }: { rows: BoardRow[] }) {
  const [hover, setHover] = useState<Point | null>(null)

  // 정규화: 추정 판매(상한)와 소싱가를 0~100 으로
  const maxSales = Math.max(...rows.map((r) => Number(r.est_sales_high) || 0), 1)
  const sourcedPrices = rows.map((r) => Number(r.ggsan_price_krw) || 0).filter((p) => p > 0)
  const maxPrice = Math.max(...sourcedPrices, 1)
  const minPrice = sourcedPrices.length > 0 ? Math.min(...sourcedPrices) : 0

  const points: Point[] = rows.map((r) => {
    const salesScore = Math.min(100, (Number(r.est_sales_high) / maxSales) * 100)
    // 저렴할수록 높은 점수. 소싱 매칭 없으면 0 (왼쪽 끝).
    const price = Number(r.ggsan_price_krw) || 0
    const sourceScore =
      price > 0 && maxPrice > minPrice ? ((maxPrice - price) / (maxPrice - minPrice)) * 100 : price > 0 ? 50 : 0
    return { ...r, x: sourceScore, y: salesScore }
  })

  const W = 720
  const H = 480
  const PAD = 50
  const xScale = (v: number) => PAD + (v / 100) * (W - 2 * PAD)
  const yScale = (v: number) => H - PAD - (v / 100) * (H - 2 * PAD)

  const winners = points
    .filter((p) => p.y >= 50 && p.x >= 50)
    .sort((a, b) => Number(b.est_sales_high) - Number(a.est_sales_high))

  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="relative">
        <svg width={W} height={H} className="block mx-auto" style={{ overflow: 'visible' }}>
          {/* 우상단 위너 사분면 배경 */}
          <rect
            x={xScale(50)}
            y={yScale(100)}
            width={xScale(100) - xScale(50)}
            height={yScale(50) - yScale(100)}
            fill="#ecfdf5"
          />

          {[0, 25, 50, 75, 100].map((v) => (
            <g key={'gx' + v}>
              <line x1={xScale(v)} y1={PAD} x2={xScale(v)} y2={H - PAD} stroke="#e5e7eb" strokeDasharray={v % 50 === 0 ? '' : '2,3'} />
              <text x={xScale(v)} y={H - PAD + 16} fontSize="10" fill="#9ca3af" textAnchor="middle">
                {v}
              </text>
            </g>
          ))}
          {[0, 25, 50, 75, 100].map((v) => (
            <g key={'gy' + v}>
              <line x1={PAD} y1={yScale(v)} x2={W - PAD} y2={yScale(v)} stroke="#e5e7eb" strokeDasharray={v % 50 === 0 ? '' : '2,3'} />
              <text x={PAD - 8} y={yScale(v) + 4} fontSize="10" fill="#9ca3af" textAnchor="end">
                {v}
              </text>
            </g>
          ))}

          <text x={W / 2} y={H - 10} fontSize="11" fill="#6b7280" textAnchor="middle">
            ggsan 소싱가 (→ 저렴 = 마진 여력↑)
          </text>
          <text x={15} y={H / 2} fontSize="11" fill="#6b7280" textAnchor="middle" transform={`rotate(-90 15 ${H / 2})`}>
            추정 실판매 (↑ 검증된 수요)
          </text>
          <text x={xScale(75)} y={yScale(95)} fontSize="11" fill="#10b981" fontWeight="bold" textAnchor="middle">
            🏆 위너 (실판매↑·소싱가↓)
          </text>

          {points.map((p) => (
            <circle
              key={p.product_id}
              cx={xScale(p.x)}
              cy={yScale(p.y)}
              r={Math.max(5, Math.min(22, Math.sqrt(Number(p.review_per_day) + 1) * 4))}
              fill={CATEGORY_COLORS[p.category_top] ?? '#6b7280'}
              fillOpacity={0.55}
              stroke={CATEGORY_COLORS[p.category_top] ?? '#6b7280'}
              strokeOpacity={0.9}
              onMouseEnter={() => setHover(p)}
              onMouseLeave={() => setHover(null)}
              style={{ cursor: 'pointer' }}
            />
          ))}
        </svg>

        {hover && (
          <div className="absolute top-2 right-2 rounded bg-black/85 text-white text-xs px-3 py-2 max-w-xs space-y-0.5">
            <div className="font-semibold">{hover.canonical_name}</div>
            <div>리뷰 +{Number(hover.review_delta).toFixed(0)} / {Number(hover.days_span).toFixed(1)}일 = {Number(hover.review_per_day).toFixed(2)}/일</div>
            <div>추정 일판매: {Number(hover.est_sales_low).toFixed(0)}~{Number(hover.est_sales_high).toFixed(0)}개</div>
            <div>SKU {hover.sku_count} · 마켓 {hover.marketplace_count}{hover.rating_avg ? ` · ★${Number(hover.rating_avg).toFixed(1)}` : ''}</div>
            {hover.ggsan_price_krw ? (
              <div>소싱: {Number(hover.ggsan_price_krw).toLocaleString()}원</div>
            ) : (
              <div className="text-amber-300">ggsan 소싱 미매칭</div>
            )}
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

      {/* 위너 랭킹 */}
      <div className="mt-6 border-t border-gray-200 pt-4">
        <h3 className="text-sm font-semibold mb-2">🏆 위너 (추정 판매↑ + 소싱가↓)</h3>
        {winners.length === 0 ? (
          <div className="text-gray-400 text-xs">아직 우상단 후보 없음. 소싱 매칭 + 리뷰 누적 후 등장.</div>
        ) : (
          <div className="space-y-1 text-sm">
            {winners.slice(0, 12).map((p, i) => (
              <Link
                key={p.product_id}
                href={`/admin/trend-radar/products/${p.product_id}`}
                className="flex items-center gap-3 px-2 py-1.5 rounded hover:bg-gray-50"
              >
                <span className="w-6 text-center text-xs font-mono text-gray-400">{i + 1}</span>
                <span className="flex-1 min-w-0 truncate">{p.canonical_name}</span>
                <span className="text-xs text-emerald-700 font-mono">
                  ~{Number(p.est_sales_low).toFixed(0)}–{Number(p.est_sales_high).toFixed(0)}개/일
                </span>
                <span className="text-xs text-gray-500 font-mono w-20 text-right">
                  {p.ggsan_price_krw ? `${Number(p.ggsan_price_krw).toLocaleString()}원` : '소싱X'}
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* 전체 테이블 */}
      <div className="mt-6 border-t border-gray-200 pt-4 overflow-x-auto">
        <h3 className="text-sm font-semibold mb-2">전체 ({rows.length})</h3>
        <table className="w-full text-xs">
          <thead className="text-gray-500 border-b border-gray-200">
            <tr>
              <th className="text-left py-1 px-2">상품</th>
              <th className="text-right py-1 px-2">Δ리뷰</th>
              <th className="text-right py-1 px-2">/일</th>
              <th className="text-right py-1 px-2">추정 판매/일</th>
              <th className="text-right py-1 px-2">SKU</th>
              <th className="text-right py-1 px-2">소싱가</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.product_id} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="py-1 px-2">
                  <Link href={`/admin/trend-radar/products/${p.product_id}`} className="hover:underline">
                    {p.canonical_name}
                  </Link>
                </td>
                <td className="text-right py-1 px-2 font-mono">+{Number(p.review_delta).toFixed(0)}</td>
                <td className="text-right py-1 px-2 font-mono">{Number(p.review_per_day).toFixed(2)}</td>
                <td className="text-right py-1 px-2 font-mono text-emerald-700">
                  {Number(p.est_sales_low).toFixed(0)}~{Number(p.est_sales_high).toFixed(0)}
                </td>
                <td className="text-right py-1 px-2 font-mono text-gray-500">{p.sku_count}</td>
                <td className="text-right py-1 px-2 font-mono">
                  {p.ggsan_price_krw ? `${Number(p.ggsan_price_krw).toLocaleString()}` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
