'use client'
import Link from 'next/link'
import { useMemo, useState } from 'react'

export interface MarketRow {
  id: string
  name: string
  category: string
  tam: number              // ₩/월
  somShare: number         // 0~100 (점유 추정 %)
  som: number              // ₩/월
  final: number            // 버블 크기
  searches: number
  conversion: number       // 0~1
  price: number
  competitors: number
}

const CATEGORY_COLORS: Record<string, string> = {
  health: '#10b981',
  living: '#f59e0b',
  digital: '#3b82f6',
  community: '#a78bfa',
  shopping_tv: '#ef4444',
  all: '#6b7280',
}

function won(n: number): string {
  if (!n || n <= 0) return '–'
  if (n >= 1e8) return `${(n / 1e8).toFixed(1)}억`
  if (n >= 1e4) return `${Math.round(n / 1e4).toLocaleString()}만`
  return Math.round(n).toLocaleString()
}

export default function MarketSizeScatter({ rows }: { rows: MarketRow[] }) {
  const [hover, setHover] = useState<MarketRow | null>(null)
  // 민감도: 전환율 배수 (±). TAM·SOM·share 는 전환율에 선형 비례하므로 클라이언트 재계산 가능.
  const [convMul, setConvMul] = useState(1)

  const W = 720
  const H = 480
  const PAD = 56

  // TAM 은 로그 스케일 (₩ 단위는 long-tail). 0 처리.
  const maxLogTam = useMemo(() => {
    const m = Math.max(1, ...rows.map((r) => r.tam * convMul))
    return Math.log10(m + 1)
  }, [rows, convMul])

  const xScale = (tam: number) => {
    const v = Math.log10(Math.max(0, tam) + 1) / (maxLogTam || 1)
    return PAD + v * (W - 2 * PAD)
  }
  // Y = SOM 점유 추정 % (0~100). share 는 전환율과 무관(비율)하므로 convMul 영향 없음.
  const yScale = (share: number) => H - PAD - (Math.min(100, share) / 100) * (H - 2 * PAD)
  const rScale = (final: number) => Math.max(4, Math.sqrt(Math.max(1, final) / Math.PI) * 1.6)

  // 사분면 경계: X = TAM 중앙값(로그), Y = 50% share
  const tamMid = useMemo(() => {
    const sorted = rows.map((r) => r.tam * convMul).sort((a, b) => a - b)
    return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0
  }, [rows, convMul])
  const xMid = xScale(tamMid)
  const yMid = yScale(50)

  return (
    <div className="rounded border border-gray-200 p-4">
      {/* 민감도 슬라이더 */}
      <div className="mb-4 flex items-center gap-3 text-xs">
        <span className="text-gray-500">전환율 민감도</span>
        <input
          type="range"
          min={0.5}
          max={2}
          step={0.1}
          value={convMul}
          onChange={(e) => setConvMul(parseFloat(e.target.value))}
          className="w-48"
        />
        <span className="font-mono text-gray-700">×{convMul.toFixed(1)}</span>
        <span className="text-gray-400">
          (base-rate 전환율을 {convMul < 1 ? '비관' : convMul > 1 ? '낙관' : '기준'}으로 조정 → TAM·SOM 비례 변동)
        </span>
      </div>

      <div className="relative">
        <svg width={W} height={H} className="block mx-auto" style={{ overflow: 'visible' }}>
          {/* 사분면 배경: 우상단 = 광맥 */}
          <rect x={xMid} y={PAD} width={W - PAD - xMid} height={yMid - PAD} fill="#f0fdf4" />
          {/* 우하단 = 레드오션 */}
          <rect x={xMid} y={yMid} width={W - PAD - xMid} height={H - PAD - yMid} fill="#fef2f2" />

          {/* 사분면 경계선 */}
          <line x1={xMid} y1={PAD} x2={xMid} y2={H - PAD} stroke="#d1d5db" strokeDasharray="4,4" />
          <line x1={PAD} y1={yMid} x2={W - PAD} y2={yMid} stroke="#d1d5db" strokeDasharray="4,4" />

          {/* 축 */}
          <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="#9ca3af" />
          <line x1={PAD} y1={PAD} x2={PAD} y2={H - PAD} stroke="#9ca3af" />

          {/* 축 라벨 */}
          <text x={W / 2} y={H - 12} fontSize="11" fill="#6b7280" textAnchor="middle">
            TAM (₩/월, log) →
          </text>
          <text x={16} y={H / 2} fontSize="11" fill="#6b7280" textAnchor="middle" transform={`rotate(-90 16 ${H / 2})`}>
            SOM 점유 추정 (%) ↑
          </text>

          {/* 사분면 라벨 */}
          <text x={(xMid + W - PAD) / 2} y={PAD + 16} fontSize="12" fill="#10b981" fontWeight="bold" textAnchor="middle">
            ⛏ 광맥 (큰 TAM · 높은 SOM)
          </text>
          <text x={(xMid + W - PAD) / 2} y={H - PAD - 8} fontSize="12" fill="#ef4444" fontWeight="bold" textAnchor="middle">
            🩸 레드오션 (큰 TAM · 낮은 SOM)
          </text>
          <text x={(PAD + xMid) / 2} y={PAD + 16} fontSize="11" fill="#6b7280" textAnchor="middle">
            🪨 니치 (작은 TAM · 높은 SOM)
          </text>
          <text x={(PAD + xMid) / 2} y={H - PAD - 8} fontSize="11" fill="#9ca3af" textAnchor="middle">
            🗑 무시 (작은 TAM · 낮은 SOM)
          </text>

          {/* 버블 */}
          {rows.map((r) => (
            <a key={r.id} href={`/admin/trend-radar/products/${r.id}`}>
              <circle
                cx={xScale(r.tam * convMul)}
                cy={yScale(r.somShare)}
                r={rScale(r.final)}
                fill={CATEGORY_COLORS[r.category] ?? '#6b7280'}
                fillOpacity={0.5}
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
          <div className="absolute top-2 right-2 rounded bg-black/85 text-white text-xs px-3 py-2 max-w-xs space-y-0.5">
            <div className="font-semibold">{hover.name}</div>
            <div>category: {hover.category}</div>
            <div>TAM: <b>{won(hover.tam * convMul)}원/월</b> · SOM: <b>{won(hover.som * convMul)}원/월</b> ({hover.somShare.toFixed(1)}%)</div>
            <div className="text-gray-300">
              검색 {Math.round(hover.searches).toLocaleString()}회 × 전환 {(hover.conversion * convMul * 100).toFixed(1)}% × {won(hover.price)}원
            </div>
            <div className="text-gray-300">경쟁 추정 {hover.competitors}곳 · final {hover.final}</div>
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
        <span className="text-gray-400 ml-auto">버블 크기 = final_score</span>
      </div>

      {/* 드릴다운 표 */}
      <div className="mt-6 border-t border-gray-200 pt-4 overflow-x-auto">
        <h3 className="text-sm font-semibold mb-2">시장규모 순위 (TAM 기준 · 근거 드릴다운)</h3>
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-gray-500 border-b border-gray-200">
              <th className="py-1 pr-2">상품</th>
              <th className="py-1 pr-2 text-right">TAM/월</th>
              <th className="py-1 pr-2 text-right">SOM/월</th>
              <th className="py-1 pr-2 text-right">점유%</th>
              <th className="py-1 pr-2 text-right">검색</th>
              <th className="py-1 pr-2 text-right">전환</th>
              <th className="py-1 pr-2 text-right">객단가</th>
              <th className="py-1 pr-2 text-right">경쟁</th>
            </tr>
          </thead>
          <tbody>
            {rows
              .slice()
              .sort((a, b) => b.tam - a.tam)
              .slice(0, 50)
              .map((r) => (
                <tr key={r.id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="py-1 pr-2">
                    <Link href={`/admin/trend-radar/products/${r.id}`} className="hover:underline">
                      {r.name}
                    </Link>
                  </td>
                  <td className="py-1 pr-2 text-right font-mono font-semibold">{won(r.tam * convMul)}</td>
                  <td className="py-1 pr-2 text-right font-mono text-emerald-700">{won(r.som * convMul)}</td>
                  <td className="py-1 pr-2 text-right font-mono">{r.somShare.toFixed(1)}%</td>
                  <td className="py-1 pr-2 text-right font-mono text-gray-500">{Math.round(r.searches).toLocaleString()}</td>
                  <td className="py-1 pr-2 text-right font-mono text-gray-500">{(r.conversion * convMul * 100).toFixed(1)}%</td>
                  <td className="py-1 pr-2 text-right font-mono text-gray-500">{won(r.price)}</td>
                  <td className="py-1 pr-2 text-right font-mono text-gray-500">{r.competitors}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
