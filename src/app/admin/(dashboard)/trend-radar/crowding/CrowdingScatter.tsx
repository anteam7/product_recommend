'use client'
import Link from 'next/link'
import { useState } from 'react'

export interface CrowdRow {
  id: string
  name: string
  category: string
  compSlope: number    // 일당 competition_score 변화 (경쟁 가속도)
  trendSlope: number   // 일당 trend_score 변화 (수요 가속도)
  compLatest: number
  trendLatest: number
  final: number
  nPoints: number
}

// 슬롭 도메인: 일당 ±DOMAIN 점으로 클램프 (대부분 -8..+8 안)
const DOMAIN = 8

// 사분면 분류 — slope 0 기준 (경쟁 평탄 임계 EPS 로 노이즈 흡수)
const EPS = 0.3
type Quad = 'breakout' | 'closing' | 'saturated' | 'fading'

function classify(r: CrowdRow): Quad {
  const demandUp = r.trendSlope > EPS
  const compUp = r.compSlope > EPS
  if (demandUp && !compUp) return 'breakout'
  if (demandUp && compUp) return 'closing'
  if (!demandUp && compUp) return 'saturated'
  return 'fading'
}

const QUAD_META: Record<Quad, { label: string; color: string; bg: string; desc: string }> = {
  breakout:  { label: '🌊 블루오션 브레이크아웃', color: '#10b981', bg: '#ecfdf5', desc: '수요↑ · 경쟁 평탄 → 깊게 소싱' },
  closing:   { label: '⏳ 닫히는 창',            color: '#f59e0b', bg: '#fffbeb', desc: '수요↑ · 경쟁 급증 → 지금 들어가거나 스킵' },
  saturated: { label: '🛑 포화',                color: '#ef4444', bg: '#fef2f2', desc: '수요 평탄 · 경쟁↑ → 회피' },
  fading:    { label: '💤 소멸',                color: '#9ca3af', bg: '#f9fafb', desc: '수요 평탄 · 경쟁 평탄/↓' },
}

export default function CrowdingScatter({ rows }: { rows: CrowdRow[] }) {
  const [hover, setHover] = useState<CrowdRow | null>(null)
  const W = 720
  const H = 480
  const PAD = 50

  const clamp = (v: number) => Math.max(-DOMAIN, Math.min(DOMAIN, v))
  // slope -DOMAIN..DOMAIN → SVG 좌표 (0 = 중앙)
  const xScale = (v: number) => PAD + ((clamp(v) + DOMAIN) / (2 * DOMAIN)) * (W - 2 * PAD)
  const yScale = (v: number) => H - PAD - ((clamp(v) + DOMAIN) / (2 * DOMAIN)) * (H - 2 * PAD)
  const rScale = (final: number) => Math.max(5, Math.sqrt(Math.max(final, 10)) * 1.4)

  const cx0 = xScale(0)
  const cy0 = yScale(0)

  const counts = rows.reduce(
    (acc, r) => { acc[classify(r)]++; return acc },
    { breakout: 0, closing: 0, saturated: 0, fading: 0 } as Record<Quad, number>,
  )

  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="relative">
        <svg width={W} height={H} className="block mx-auto" style={{ overflow: 'visible' }}>
          {/* 사분면 배경: 좌상=breakout, 우상=closing, 우하=saturated, 좌하=fading */}
          <rect x={PAD}  y={PAD}  width={cx0 - PAD}     height={cy0 - PAD}     fill={QUAD_META.breakout.bg} />
          <rect x={cx0}  y={PAD}  width={W - PAD - cx0} height={cy0 - PAD}     fill={QUAD_META.closing.bg} />
          <rect x={cx0}  y={cy0}  width={W - PAD - cx0} height={H - PAD - cy0} fill={QUAD_META.saturated.bg} />
          <rect x={PAD}  y={cy0}  width={cx0 - PAD}     height={H - PAD - cy0} fill={QUAD_META.fading.bg} />

          {/* 중앙 0축 */}
          <line x1={cx0} y1={PAD} x2={cx0} y2={H - PAD} stroke="#9ca3af" strokeWidth={1.5} />
          <line x1={PAD} y1={cy0} x2={W - PAD} y2={cy0} stroke="#9ca3af" strokeWidth={1.5} />

          {/* 눈금 */}
          {[-DOMAIN, -DOMAIN / 2, 0, DOMAIN / 2, DOMAIN].map((v) => (
            <text key={'tx' + v} x={xScale(v)} y={H - PAD + 16} fontSize="10" fill="#9ca3af" textAnchor="middle">
              {v > 0 ? `+${v}` : v}
            </text>
          ))}
          {[-DOMAIN, -DOMAIN / 2, 0, DOMAIN / 2, DOMAIN].map((v) => (
            <text key={'ty' + v} x={PAD - 8} y={yScale(v) + 4} fontSize="10" fill="#9ca3af" textAnchor="end">
              {v > 0 ? `+${v}` : v}
            </text>
          ))}

          {/* 축 라벨 */}
          <text x={W / 2} y={H - 10} fontSize="11" fill="#6b7280" textAnchor="middle">
            경쟁 가속도 d(competition)/dt — 일당 점수 변화 (→ 빠르게 혼잡)
          </text>
          <text x={15} y={H / 2} fontSize="11" fill="#6b7280" textAnchor="middle" transform={`rotate(-90 15 ${H / 2})`}>
            수요 가속도 d(trend)/dt (↑ 가속)
          </text>

          {/* 사분면 라벨 */}
          <text x={(PAD + cx0) / 2} y={PAD + 16} fontSize="11" fill={QUAD_META.breakout.color} fontWeight="bold" textAnchor="middle">
            {QUAD_META.breakout.label}
          </text>
          <text x={(cx0 + W - PAD) / 2} y={PAD + 16} fontSize="11" fill={QUAD_META.closing.color} fontWeight="bold" textAnchor="middle">
            {QUAD_META.closing.label}
          </text>
          <text x={(cx0 + W - PAD) / 2} y={H - PAD - 8} fontSize="11" fill={QUAD_META.saturated.color} fontWeight="bold" textAnchor="middle">
            {QUAD_META.saturated.label}
          </text>
          <text x={(PAD + cx0) / 2} y={H - PAD - 8} fontSize="11" fill={QUAD_META.fading.color} fontWeight="bold" textAnchor="middle">
            {QUAD_META.fading.label}
          </text>

          {/* 점들 */}
          {rows.map((r) => {
            const q = classify(r)
            return (
              <a key={r.id} href={`/admin/trend-radar/products/${r.id}`}>
                <circle
                  cx={xScale(r.compSlope)}
                  cy={yScale(r.trendSlope)}
                  r={rScale(r.final)}
                  fill={QUAD_META[q].color}
                  fillOpacity={0.5}
                  stroke={QUAD_META[q].color}
                  strokeOpacity={0.9}
                  onMouseEnter={() => setHover(r)}
                  onMouseLeave={() => setHover(null)}
                  style={{ cursor: 'pointer' }}
                />
              </a>
            )
          })}
        </svg>

        {hover && (
          <div className="absolute top-2 right-2 rounded bg-black/85 text-white text-xs px-3 py-2 max-w-xs">
            <div className="font-semibold">{hover.name}</div>
            <div>{QUAD_META[classify(hover)].label}</div>
            <div>
              경쟁 가속 {hover.compSlope >= 0 ? '+' : ''}{hover.compSlope.toFixed(2)}/일 · 수요 가속{' '}
              {hover.trendSlope >= 0 ? '+' : ''}{hover.trendSlope.toFixed(2)}/일
            </div>
            <div>competition {Math.round(hover.compLatest)} · trend {Math.round(hover.trendLatest)} · final {Math.round(hover.final)}</div>
            <div className="text-gray-300">표본 {hover.nPoints}점</div>
          </div>
        )}
      </div>

      {/* 사분면 범례 + 카운트 */}
      <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
        {(Object.keys(QUAD_META) as Quad[]).map((q) => (
          <div key={q} className="rounded border border-gray-200 px-3 py-2" style={{ background: QUAD_META[q].bg }}>
            <div className="flex items-center justify-between">
              <span className="font-semibold" style={{ color: QUAD_META[q].color }}>{QUAD_META[q].label}</span>
              <span className="font-mono font-bold">{counts[q]}</span>
            </div>
            <div className="text-gray-500 mt-0.5">{QUAD_META[q].desc}</div>
          </div>
        ))}
      </div>

      {/* 닫히는 창 드릴다운 — 가장 행동 시급한 사분면 */}
      <div className="mt-6 border-t border-gray-200 pt-4">
        <h3 className="text-sm font-semibold mb-2">⏳ 닫히는 창 — 경쟁 혼잡 가속 Top (지금 결정)</h3>
        <div className="space-y-1 text-sm">
          {rows
            .filter((r) => classify(r) === 'closing')
            .sort((a, b) => b.compSlope - a.compSlope)
            .slice(0, 10)
            .map((r) => (
              <Link
                key={r.id}
                href={`/admin/trend-radar/products/${r.id}`}
                className="grid grid-cols-12 px-2 py-1 rounded hover:bg-gray-50"
              >
                <span className="col-span-6 truncate">{r.name}</span>
                <span className="col-span-2 text-right font-mono text-amber-700">경쟁 +{r.compSlope.toFixed(2)}/일</span>
                <span className="col-span-2 text-right font-mono text-emerald-700">수요 +{r.trendSlope.toFixed(2)}/일</span>
                <span className="col-span-2 text-right font-mono text-gray-500">final {Math.round(r.final)}</span>
              </Link>
            ))}
          {rows.filter((r) => classify(r) === 'closing').length === 0 && (
            <div className="text-gray-400 text-xs">아직 닫히는 창 후보 없음. 7일 누적(최소 3 recompute) 후 등장.</div>
          )}
        </div>
      </div>
    </div>
  )
}
