'use client'
import Link from 'next/link'
import { useState } from 'react'

export interface T2MRow {
  product_id: string
  canonical_name: string
  category_top: string
  current_score: number
  peak_score: number
  days_since_peak: number
  half_life_days: number | null
  residual_life_days: number | null
  best_lead_time: number | null
  lead_is_assumed: boolean
  total_time_days: number
  arrival_residual_ratio: number | null
  verdict: 'ample' | 'safe' | 'late' | 'unknown'
}

const VERDICT_COLOR: Record<T2MRow['verdict'], string> = {
  ample: '#10b981',   // 여유
  safe: '#f59e0b',    // 안전
  late: '#ef4444',    // 늦음 (차단)
  unknown: '#9ca3af', // 리드타임 미상
}

const VERDICT_LABEL: Record<T2MRow['verdict'], string> = {
  ample: '여유',
  safe: '안전',
  late: '늦음',
  unknown: '미상',
}

// 잔존수명 open-ended(null = 상승/평탄)일 때 차트 상한
const RESIDUAL_CAP = 60

export default function TimeToMarketScatter({ rows }: { rows: T2MRow[] }) {
  const [hover, setHover] = useState<T2MRow | null>(null)
  const W = 720
  const H = 480
  const PAD = 56

  // x축 = 리드타임+등록(도착소요 일), y축 = 잔존수명(일)
  const maxLead = Math.max(14, ...rows.map((r) => r.total_time_days))
  const xScale = (v: number) => PAD + (Math.min(v, maxLead) / maxLead) * (W - 2 * PAD)
  const yScale = (v: number) => H - PAD - (Math.min(v, RESIDUAL_CAP) / RESIDUAL_CAP) * (H - 2 * PAD)

  // 대각선: 잔존수명 == 도착소요  (이 선 위쪽 = 도착 후에도 수요 남음 = 안전권)
  const diagPts = `${xScale(0)},${yScale(0)} ${xScale(maxLead)},${yScale(maxLead)}`

  const xTicks = [0, Math.round(maxLead / 4), Math.round(maxLead / 2), Math.round((maxLead * 3) / 4), maxLead]
  const yTicks = [0, 15, 30, 45, RESIDUAL_CAP]

  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="relative">
        <svg width={W} height={H} className="block mx-auto" style={{ overflow: 'visible' }}>
          {/* 차단 영역(대각선 아래 = 도착 전에 수요 꺼짐) 음영 */}
          <polygon
            points={`${xScale(0)},${yScale(0)} ${xScale(maxLead)},${yScale(maxLead)} ${xScale(maxLead)},${yScale(0)}`}
            fill="#fef2f2"
          />

          {/* grid */}
          {xTicks.map((v) => (
            <g key={'gx' + v}>
              <line x1={xScale(v)} y1={PAD} x2={xScale(v)} y2={H - PAD} stroke="#e5e7eb" strokeDasharray="2,3" />
              <text x={xScale(v)} y={H - PAD + 16} fontSize="10" fill="#9ca3af" textAnchor="middle">{v}</text>
            </g>
          ))}
          {yTicks.map((v) => (
            <g key={'gy' + v}>
              <line x1={PAD} y1={yScale(v)} x2={W - PAD} y2={yScale(v)} stroke="#e5e7eb" strokeDasharray="2,3" />
              <text x={PAD - 8} y={yScale(v) + 4} fontSize="10" fill="#9ca3af" textAnchor="end">
                {v === RESIDUAL_CAP ? `${v}+` : v}
              </text>
            </g>
          ))}

          {/* 도착가능 경계 대각선 */}
          <polyline points={diagPts} fill="none" stroke="#ef4444" strokeWidth={1.5} strokeDasharray="5,4" />
          <text x={xScale(maxLead) - 4} y={yScale(maxLead) - 6} fontSize="10" fill="#ef4444" textAnchor="end">
            잔존수명 = 도착소요 (경계)
          </text>

          {/* 축 라벨 */}
          <text x={W / 2} y={H - 8} fontSize="11" fill="#6b7280" textAnchor="middle">
            도착소요 = 도매 리드타임 + 등록 (일) →
          </text>
          <text x={14} y={H / 2} fontSize="11" fill="#6b7280" textAnchor="middle" transform={`rotate(-90 14 ${H / 2})`}>
            ↑ 잔존 가시수명 (일)
          </text>

          {/* 점들 */}
          {rows.map((r) => {
            const y = r.residual_life_days == null ? RESIDUAL_CAP : r.residual_life_days
            return (
              <a key={r.product_id} href={`/admin/trend-radar/products/${r.product_id}`}>
                <circle
                  cx={xScale(r.total_time_days)}
                  cy={yScale(y)}
                  r={Math.max(4, Math.sqrt(r.current_score) * 1.1)}
                  fill={VERDICT_COLOR[r.verdict]}
                  fillOpacity={0.55}
                  stroke={VERDICT_COLOR[r.verdict]}
                  strokeOpacity={0.9}
                  strokeDasharray={r.residual_life_days == null ? '2,2' : ''}
                  onMouseEnter={() => setHover(r)}
                  onMouseLeave={() => setHover(null)}
                  style={{ cursor: 'pointer' }}
                />
              </a>
            )
          })}
        </svg>

        {hover && (
          <div className="absolute top-2 right-2 rounded bg-black/85 text-white text-xs px-3 py-2 max-w-xs space-y-0.5">
            <div className="font-semibold">{hover.canonical_name}</div>
            <div>판정: {VERDICT_LABEL[hover.verdict]} · {hover.category_top}</div>
            <div>현재 {hover.current_score} (피크 {hover.peak_score}, {hover.days_since_peak}일 전)</div>
            <div>반감기 {hover.half_life_days ?? '상승중'} · 잔존수명 {hover.residual_life_days ?? '∞'}</div>
            <div>
              도착소요 {hover.total_time_days}일
              {hover.lead_is_assumed ? ' (리드타임 가정)' : ` (리드 ${hover.best_lead_time})`}
            </div>
            <div>도착 잔량 {hover.arrival_residual_ratio == null ? '—' : `${Math.round(hover.arrival_residual_ratio * 100)}%`}</div>
          </div>
        )}
      </div>

      {/* 범례 */}
      <div className="mt-4 flex flex-wrap gap-3 text-xs">
        {(['ample', 'safe', 'late', 'unknown'] as const).map((v) => (
          <span key={v} className="flex items-center gap-1">
            <span className="inline-block w-3 h-3 rounded-full" style={{ background: VERDICT_COLOR[v], opacity: 0.6 }} />
            {VERDICT_LABEL[v]}
          </span>
        ))}
        <span className="text-gray-400">· 점 크기 = 현재 수요 · 점선 테두리 = 아직 상승/평탄(반감기 미정)</span>
      </div>

      {/* 게이트 테이블 */}
      <div className="mt-6 border-t border-gray-200 pt-4">
        <h3 className="text-sm font-semibold mb-2">도착가능성 게이트 (늦음 우선)</h3>
        <div className="grid grid-cols-12 text-xs text-gray-500 px-2 py-1">
          <div className="col-span-4">상품명</div>
          <div className="col-span-1 text-right">현재</div>
          <div className="col-span-2 text-right">반감기</div>
          <div className="col-span-2 text-right">잔존수명</div>
          <div className="col-span-1 text-right">도착</div>
          <div className="col-span-1 text-right">잔량</div>
          <div className="col-span-1 text-right">판정</div>
        </div>
        <div className="space-y-0.5">
          {rows.map((r) => (
            <Link
              key={r.product_id}
              href={`/admin/trend-radar/products/${r.product_id}`}
              className="grid grid-cols-12 px-2 py-1.5 text-sm rounded hover:bg-gray-50 items-center"
            >
              <div className="col-span-4 truncate" title={r.canonical_name}>
                {r.canonical_name}
                <span className="text-xs text-gray-400 ml-1">{r.category_top}</span>
              </div>
              <div className="col-span-1 text-right font-mono">{r.current_score}</div>
              <div className="col-span-2 text-right font-mono text-gray-600">
                {r.half_life_days == null ? '상승중' : `${r.half_life_days}일`}
              </div>
              <div className="col-span-2 text-right font-mono text-gray-600">
                {r.residual_life_days == null ? '∞' : `${r.residual_life_days}일`}
              </div>
              <div className="col-span-1 text-right font-mono text-gray-500">
                {r.total_time_days}일{r.lead_is_assumed ? '*' : ''}
              </div>
              <div className="col-span-1 text-right font-mono text-gray-600">
                {r.arrival_residual_ratio == null ? '—' : `${Math.round(r.arrival_residual_ratio * 100)}%`}
              </div>
              <div className="col-span-1 text-right">
                <span
                  className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold text-white"
                  style={{ background: VERDICT_COLOR[r.verdict] }}
                >
                  {r.verdict === 'late' ? '⛔ 늦음' : VERDICT_LABEL[r.verdict]}
                </span>
              </div>
            </Link>
          ))}
        </div>
        <div className="text-xs text-gray-400 mt-3 pt-2 border-t border-gray-100">
          * = 도매 lead_time_days 미수집 → 가정 리드타임 사용. ⛔ 늦음 = 도착 전 수요 소멸(위탁 진입 차단 권고).
        </div>
      </div>
    </div>
  )
}
