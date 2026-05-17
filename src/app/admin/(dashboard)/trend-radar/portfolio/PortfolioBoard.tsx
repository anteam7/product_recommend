'use client'
import { useMemo, useState } from 'react'

export interface Asset {
  key: string
  name: string
  category: string
  pinned: boolean
  finalScore: number
  expectedMargin: number      // 원
  expectedDemand: number      // 0..100
  variance: number            // score variance
  capital: number             // 원 (도매가 × MOQ)
  ggsanGoodsNo: string | null
  ggsanPriceKrw: number | null
}

const BUDGETS = [
  { label: '10만원', value: 100_000 },
  { label: '30만원', value: 300_000 },
  { label: '50만원', value: 500_000 },
  { label: '100만원', value: 1_000_000 },
  { label: '300만원', value: 3_000_000 },
] as const

const RISK_LEVELS = [
  { label: '극보수', value: 4.0 },
  { label: '보수', value: 2.0 },
  { label: '중립', value: 1.0 },
  { label: '공격', value: 0.5 },
  { label: '극공격', value: 0.1 },
] as const

interface Picked {
  asset: Asset
  weight: number       // 0..1
  units: number        // 자본 / (capital/MOQ) 환산. 여기선 단위=비중 시각화 용도
}

interface Portfolio {
  picks: Picked[]
  totalReturn: number   // 기대 마진 합
  totalRisk: number     // sqrt(분산합)
  totalCapital: number
}

/**
 * 단순 Markowitz-lite (uncorrelated):
 *   utility = sum_i w_i * return_i  -  lambda * sum_i w_i^2 * variance_i
 *   capital constraint: sum_i w_i * capital_i <= budget
 *   no-shorting: 0 <= w_i <= 1
 *   해석: 자산간 상관 0 가정 → variance term 이 diagonal 만 남음 →
 *         continuous greedy 로 폐쇄식 weight 도출 가능.
 *
 * 절차:
 *   1) 각 자산의 "한계 효율" eff_i = (return_i - lambda * variance_i) / capital_i 계산
 *   2) eff > 0 인 자산만 후보로
 *   3) capital 비례 weight 정규화 → budget 까지 채움
 */
function optimizePortfolio(
  assets: Asset[],
  budget: number,
  riskAversion: number,
): Portfolio {
  // 기대 수익 = expectedMargin × (expectedDemand/100) — 자본 1단위당이 아니라 자산 1단위당
  const scored = assets.map((a) => {
    const ret = a.expectedMargin * (a.expectedDemand / 100)
    const varScaled = (a.variance / 100) * a.expectedMargin // 분산을 원^2 차원으로 거칠게 환산
    const eff = (ret - riskAversion * varScaled) / Math.max(1, a.capital)
    return { a, ret, varScaled, eff }
  })

  const positive = scored.filter((s) => s.eff > 0).sort((a, b) => b.eff - a.eff)
  if (positive.length === 0) {
    return { picks: [], totalReturn: 0, totalRisk: 0, totalCapital: 0 }
  }

  // greedy fill — 자본 효율순으로 자산을 fully include, 마지막 자산은 fractional weight
  const picks: Picked[] = []
  let spent = 0
  for (const s of positive) {
    if (spent >= budget) break
    const room = budget - spent
    const w = Math.min(1, room / s.a.capital)
    if (w < 0.01) continue
    picks.push({ asset: s.a, weight: w, units: w })
    spent += w * s.a.capital
  }

  const totalReturn = picks.reduce(
    (acc, p) => acc + p.weight * p.asset.expectedMargin * (p.asset.expectedDemand / 100),
    0,
  )
  const variancePortfolio = picks.reduce(
    (acc, p) => acc + p.weight * p.weight * p.asset.variance,
    0,
  )
  return {
    picks,
    totalReturn,
    totalRisk: Math.sqrt(variancePortfolio),
    totalCapital: spent,
  }
}

/**
 * Efficient frontier: lambda 를 sweep 하면서 (risk, return) 점을 모음.
 */
function frontier(assets: Asset[], budget: number): Array<{ risk: number; ret: number; lambda: number }> {
  const out: Array<{ risk: number; ret: number; lambda: number }> = []
  const lambdas = [0.05, 0.1, 0.2, 0.5, 1, 2, 3, 5, 8, 12, 20]
  for (const l of lambdas) {
    const p = optimizePortfolio(assets, budget, l)
    if (p.picks.length === 0) continue
    out.push({ risk: p.totalRisk, ret: p.totalReturn, lambda: l })
  }
  return out
}

export default function PortfolioBoard({ assets }: { assets: Asset[] }) {
  const [budget, setBudget] = useState<number>(BUDGETS[2].value)
  const [riskIdx, setRiskIdx] = useState<number>(2)

  const lambda = RISK_LEVELS[riskIdx].value
  const portfolio = useMemo(() => optimizePortfolio(assets, budget, lambda), [assets, budget, lambda])
  const fr = useMemo(() => frontier(assets, budget), [assets, budget])

  const pickedSet = useMemo(() => new Set(portfolio.picks.map((p) => p.asset.key)), [portfolio])

  // ─── SVG 좌표 ───
  const W = 720
  const H = 440
  const PAD = 60

  const maxRet = Math.max(
    1,
    ...assets.map((a) => a.expectedMargin * (a.expectedDemand / 100)),
    ...fr.map((f) => f.ret),
  )
  const maxRisk = Math.max(
    1,
    ...assets.map((a) => Math.sqrt(a.variance)),
    ...fr.map((f) => f.risk),
  )

  const xScale = (risk: number) => PAD + (risk / maxRisk) * (W - 2 * PAD)
  const yScale = (ret: number) => H - PAD - (ret / maxRet) * (H - 2 * PAD)

  const frontierPath = fr
    .slice()
    .sort((a, b) => a.risk - b.risk)
    .map((f, i) => `${i === 0 ? 'M' : 'L'} ${xScale(f.risk).toFixed(1)} ${yScale(f.ret).toFixed(1)}`)
    .join(' ')

  return (
    <div className="space-y-6">
      {/* 컨트롤 */}
      <section className="rounded border border-gray-200 p-4 bg-gray-50/50">
        <div className="grid md:grid-cols-2 gap-6">
          <div>
            <div className="text-xs text-gray-500 mb-2">총 자본 budget</div>
            <div className="flex flex-wrap gap-2">
              {BUDGETS.map((b) => (
                <button
                  key={b.value}
                  onClick={() => setBudget(b.value)}
                  className={`px-3 py-1.5 text-sm rounded border ${
                    budget === b.value
                      ? 'bg-black text-white border-black'
                      : 'bg-white border-gray-300 hover:border-black'
                  }`}
                >
                  {b.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="text-xs text-gray-500 mb-2">
              리스크 허용도 (λ={lambda})
            </div>
            <input
              type="range"
              min={0}
              max={RISK_LEVELS.length - 1}
              step={1}
              value={riskIdx}
              onChange={(e) => setRiskIdx(Number(e.target.value))}
              className="w-full"
            />
            <div className="flex justify-between text-xs text-gray-500 mt-1">
              {RISK_LEVELS.map((r, i) => (
                <span key={r.label} className={i === riskIdx ? 'font-bold text-black' : ''}>
                  {r.label}
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* 요약 KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="선택 자산" value={`${portfolio.picks.length}개`} hint={`/ 후보 ${assets.length}`} />
        <Kpi label="투입 자본" value={`${formatKRW(portfolio.totalCapital)}원`} hint={`/ ${formatKRW(budget)}원`} />
        <Kpi label="기대 마진" value={`${formatKRW(portfolio.totalReturn)}원`} hint="월 환산 (수요×마진)" />
        <Kpi label="포트폴리오 리스크" value={portfolio.totalRisk.toFixed(1)} hint="score std 가중합" />
      </section>

      {/* Scatter + Frontier */}
      <section className="rounded border border-gray-200 p-4">
        <h2 className="text-sm font-semibold mb-2">
          기대 마진 vs 리스크 (분산)
          <span className="text-xs text-gray-500 ml-2">
            굵은 점 = 최적 조합 / 곡선 = efficient frontier (λ sweep)
          </span>
        </h2>
        <svg width={W} height={H} className="block mx-auto" style={{ overflow: 'visible' }}>
          {/* grid */}
          {[0, 0.25, 0.5, 0.75, 1].map((t) => (
            <g key={'gx' + t}>
              <line x1={PAD + t * (W - 2 * PAD)} y1={PAD} x2={PAD + t * (W - 2 * PAD)} y2={H - PAD} stroke="#e5e7eb" />
              <line x1={PAD} y1={H - PAD - t * (H - 2 * PAD)} x2={W - PAD} y2={H - PAD - t * (H - 2 * PAD)} stroke="#e5e7eb" />
            </g>
          ))}

          {/* 축 */}
          <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} stroke="#9ca3af" />
          <line x1={PAD} y1={PAD} x2={PAD} y2={H - PAD} stroke="#9ca3af" />
          <text x={W / 2} y={H - 18} fontSize="11" fill="#6b7280" textAnchor="middle">
            ← 안전 ·  Risk (score std)  · 위험 →
          </text>
          <text x={16} y={H / 2} fontSize="11" fill="#6b7280" textAnchor="middle" transform={`rotate(-90 16 ${H / 2})`}>
            기대 마진 (원)
          </text>

          {/* 프론티어 곡선 */}
          {fr.length > 1 && (
            <path d={frontierPath} fill="none" stroke="#10b981" strokeWidth={2.5} strokeDasharray="4,3" />
          )}

          {/* 자산 점 */}
          {assets.map((a) => {
            const ret = a.expectedMargin * (a.expectedDemand / 100)
            const risk = Math.sqrt(a.variance)
            const cx = xScale(risk)
            const cy = yScale(ret)
            const isPicked = pickedSet.has(a.key)
            return (
              <g key={a.key}>
                <circle
                  cx={cx}
                  cy={cy}
                  r={isPicked ? 9 : 4}
                  fill={a.pinned ? '#ef4444' : '#3b82f6'}
                  fillOpacity={isPicked ? 0.85 : 0.35}
                  stroke={isPicked ? '#000' : 'none'}
                  strokeWidth={isPicked ? 1.5 : 0}
                />
                {isPicked && (
                  <text x={cx + 12} y={cy + 4} fontSize="10" fill="#111" className="pointer-events-none">
                    {truncate(a.name, 14)}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
        <div className="text-xs text-gray-500 mt-2 flex gap-4 justify-center">
          <span><span className="inline-block w-2 h-2 rounded-full bg-red-500 align-middle mr-1" />pinned</span>
          <span><span className="inline-block w-2 h-2 rounded-full bg-blue-500 align-middle mr-1" />후보</span>
          <span><span className="inline-block w-3 h-3 rounded-full bg-blue-500 align-middle mr-1 border border-black" />최적 조합</span>
          <span><span className="inline-block w-4 h-1 bg-emerald-500 align-middle mr-1" />efficient frontier</span>
        </div>
      </section>

      {/* 선택 자산 테이블 */}
      <section className="rounded border border-gray-200">
        <div className="grid grid-cols-12 text-xs text-gray-500 px-3 py-2 border-b border-gray-200 bg-gray-50">
          <div className="col-span-1">#</div>
          <div className="col-span-4">상품명</div>
          <div className="col-span-1 text-right">weight</div>
          <div className="col-span-2 text-right">자본 (원)</div>
          <div className="col-span-2 text-right">기대마진 (원)</div>
          <div className="col-span-1 text-right">수요</div>
          <div className="col-span-1 text-right">σ</div>
        </div>
        {portfolio.picks.length === 0 ? (
          <div className="px-3 py-6 text-center text-sm text-gray-500">
            현재 λ 하에서 양의 효율 후보가 없음. 리스크 허용도를 ↑ 해보세요.
          </div>
        ) : (
          portfolio.picks.map((p, i) => (
            <div key={p.asset.key} className="grid grid-cols-12 px-3 py-2 text-sm border-b border-gray-100 last:border-b-0">
              <div className="col-span-1 text-gray-400 font-mono">{i + 1}</div>
              <div className="col-span-4">
                <div className="font-medium flex items-center gap-1">
                  {p.asset.pinned && <span title="pinned" className="text-red-500">📌</span>}
                  {p.asset.name}
                </div>
                <div className="text-xs text-gray-500">{p.asset.category}</div>
              </div>
              <div className="col-span-1 text-right font-mono font-bold">
                {(p.weight * 100).toFixed(0)}%
              </div>
              <div className="col-span-2 text-right font-mono text-gray-700">
                {formatKRW(p.weight * p.asset.capital)}
              </div>
              <div className="col-span-2 text-right font-mono text-emerald-700">
                {formatKRW(p.weight * p.asset.expectedMargin * (p.asset.expectedDemand / 100))}
              </div>
              <div className="col-span-1 text-right font-mono text-gray-600">
                {p.asset.expectedDemand.toFixed(0)}
              </div>
              <div className="col-span-1 text-right font-mono text-gray-600">
                {Math.sqrt(p.asset.variance).toFixed(1)}
              </div>
            </div>
          ))
        )}
      </section>

      <p className="text-xs text-gray-400">
        가정: 자산간 상관 0 · 자본 제약 하 mean-variance utility · MOQ 10 · 마크업 0.8 ·
        score variance 를 분산 proxy 로 사용. 정밀화 v1: cannibalization 매트릭스, 실수요 적용.
      </p>
    </div>
  )
}

function Kpi({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded border border-gray-200 p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-xl font-bold mt-0.5">{value}</div>
      <div className="text-xs text-gray-400 mt-0.5">{hint}</div>
    </div>
  )
}

function formatKRW(n: number) {
  return Math.round(n).toLocaleString('ko-KR')
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}
