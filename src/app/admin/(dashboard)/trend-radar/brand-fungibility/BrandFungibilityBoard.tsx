'use client'
import Link from 'next/link'
import { useState } from 'react'
import type { FungibilityRow } from './page'

const CATEGORY_COLORS: Record<string, string> = {
  health: '#10b981',
  living: '#f59e0b',
  digital: '#3b82f6',
  community: '#a78bfa',
  shopping_tv: '#ef4444',
  all: '#6b7280',
}

export default function BrandFungibilityBoard({ rows }: { rows: FungibilityRow[] }) {
  const [hover, setHover] = useState<FungibilityRow | null>(null)
  const W = 720
  const H = 480
  const PAD = 50

  // x = 브랜드 종속도(0~1) → %, 왼쪽일수록 제네릭(중립). y = final_score 0~100.
  const xScale = (ratio: number) => PAD + ratio * (W - 2 * PAD)
  const yScale = (v: number) => H - PAD - (v / 100) * (H - 2 * PAD)
  const rScale = (v: number) => Math.max(3, Math.sqrt(Math.max(1, v) / Math.PI) * 1.8)

  // 제네릭 광맥: 종속도 낮음(≤0.25) × final 높음. ggsan 동등품 가산 정렬.
  const goldmine = rows
    .filter((r) => r.brand_dependency_ratio <= 0.25)
    .sort(
      (a, b) =>
        b.final_score * (1 - b.brand_dependency_ratio) -
        a.final_score * (1 - a.brand_dependency_ratio),
    )

  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="relative">
        <svg width={W} height={H} className="block mx-auto" style={{ overflow: 'visible' }}>
          {/* 좌상단 = 제네릭 광맥(종속도↓ · final↑) 배경 */}
          <rect
            x={xScale(0)}
            y={yScale(100)}
            width={xScale(0.25) - xScale(0)}
            height={yScale(50) - yScale(100)}
            fill="#f0fdf4"
          />

          {/* grid: x = ratio(%) */}
          {[0, 0.25, 0.5, 0.75, 1].map((v) => (
            <g key={'gx' + v}>
              <line
                x1={xScale(v)}
                y1={PAD}
                x2={xScale(v)}
                y2={H - PAD}
                stroke="#e5e7eb"
                strokeDasharray={v === 0 || v === 0.5 || v === 1 ? '' : '2,3'}
              />
              <text x={xScale(v)} y={H - PAD + 16} fontSize="10" fill="#9ca3af" textAnchor="middle">
                {Math.round(v * 100)}%
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

          {/* 축 라벨 */}
          <text x={W / 2} y={H - 10} fontSize="11" fill="#6b7280" textAnchor="middle">
            ← 브랜드 종속도 (왼쪽 = 제네릭·위탁 최적)
          </text>
          <text x={15} y={H / 2} fontSize="11" fill="#6b7280" textAnchor="middle" transform={`rotate(-90 15 ${H / 2})`}>
            final score (↑ 발굴 가치 강함)
          </text>

          {/* 사분면 라벨 */}
          <text x={xScale(0.12)} y={yScale(95)} fontSize="11" fill="#10b981" fontWeight="bold" textAnchor="middle">
            💎 제네릭 수요 광맥
          </text>
          <text x={xScale(0.85)} y={yScale(95)} fontSize="10" fill="#ef4444" textAnchor="middle">
            ⚠ 브랜드 종속 (소싱 불가)
          </text>

          {/* 점들 — 크기 = ggsan 동등품 개수(즉시 소싱 가능성) */}
          {rows.map((r) => (
            <a key={r.product_id} href={`/admin/trend-radar/products/${r.product_id}`}>
              <circle
                cx={xScale(r.brand_dependency_ratio)}
                cy={yScale(r.final_score)}
                r={rScale(r.ggsan_match_count * 30)}
                fill={CATEGORY_COLORS[r.category_top] ?? '#6b7280'}
                fillOpacity={0.55}
                stroke={CATEGORY_COLORS[r.category_top] ?? '#6b7280'}
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
            <div className="font-semibold">{hover.canonical_name}</div>
            <div>{hover.brand ? `brand: ${hover.brand}` : 'brand 없음'} · {hover.category_top}</div>
            <div>
              종속도 {Math.round(hover.brand_dependency_ratio * 100)}% ({hover.brand_dep_count}/{hover.alias_total}) ·
              final {hover.final_score}
            </div>
            <div>ggsan 동등품 {hover.ggsan_match_count}개</div>
          </div>
        )}
      </div>

      {/* 범례 */}
      <div className="mt-4 flex flex-wrap gap-3 text-xs">
        {Object.entries(CATEGORY_COLORS).map(([cat, color]) => (
          <span key={cat} className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded-full" style={{ background: color, opacity: 0.6 }} />
            {cat}
          </span>
        ))}
        <span className="text-gray-400">· 점 크기 = ggsan 동등품 개수</span>
      </div>

      {/* 제네릭 광맥 리스트 */}
      <div className="mt-6 border-t border-gray-200 pt-4">
        <h3 className="text-sm font-semibold mb-2">
          💎 제네릭 수요 광맥 <span className="text-xs font-normal text-gray-500">(종속도 ≤ 25% · final 높은 순)</span>
        </h3>
        {goldmine.length === 0 ? (
          <div className="text-gray-400 text-xs">아직 광맥 후보 없음. score·alias 누적 후 자연 등장.</div>
        ) : (
          <div className="space-y-1 text-sm">
            <div className="grid grid-cols-12 text-xs text-gray-500 px-2 py-1">
              <div className="col-span-5">상품명</div>
              <div className="col-span-2">브랜드</div>
              <div className="col-span-1 text-right">종속도</div>
              <div className="col-span-1 text-right">final</div>
              <div className="col-span-1 text-right">alias</div>
              <div className="col-span-2 text-right">ggsan 동등품</div>
            </div>
            {goldmine.slice(0, 30).map((r) => (
              <Link
                key={r.product_id}
                href={`/admin/trend-radar/products/${r.product_id}`}
                className="grid grid-cols-12 px-2 py-1 rounded hover:bg-gray-50 items-center"
              >
                <div className="col-span-5 truncate">{r.canonical_name}</div>
                <div className="col-span-2 text-xs text-gray-500 truncate">{r.brand ?? '—'}</div>
                <div className="col-span-1 text-right font-mono text-emerald-600">
                  {Math.round(r.brand_dependency_ratio * 100)}%
                </div>
                <div className="col-span-1 text-right font-mono font-bold">{r.final_score}</div>
                <div className="col-span-1 text-right text-xs text-gray-500">{r.alias_total}</div>
                <div className="col-span-2 text-right text-xs">
                  {r.ggsan_match_count > 0 ? (
                    <span className="text-emerald-700 font-semibold">{r.ggsan_match_count}개 즉시소싱</span>
                  ) : (
                    <span className="text-gray-400">없음</span>
                  )}
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
