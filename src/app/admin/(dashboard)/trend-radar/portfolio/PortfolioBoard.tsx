'use client'

import { useMemo, useState, useTransition } from 'react'
import { savePortfolio } from './actions'

// 후보 1개 (서버에서 latest score + product + supplier 조인 후 평탄화)
export interface Candidate {
  id: string
  name: string
  cluster: string // category_top — 동조상승 테마 군집 프록시
  supplier: string // 대표 도매처 source — 도매처 의존 프록시
  finalScore: number // 기대수익 프록시
  competition: number // 0~100 (높을수록 경쟁 약함)
  marginScore: number // 실효마진 프록시 0~1 (카테고리수수료·반품보정 후)
  aliasCount: number // 별칭 수 — 등록공수 추정 입력
  needsImageFix: boolean // 이미지 보정 필요 (이미지 URL 부재)
  regulated: boolean // 건기식 등 인증/규제 카테고리
}

// 선택 결과 (한계기여 시각화용)
interface Pick {
  c: Candidate
  marginalValue: number // 상관 페널티 반영 후 이 슬롯이 더한 실제 가치
  rawValue: number // 페널티 전 기대값
  estAdSpend: number // 추정 광고비 (won)
  effort: number // 등록공수 (1.0 = 기준)
  clusterDiscount: number
  supplierDiscount: number
}

// 후보 1개의 노력비용(등록공수) 추정 — 1.0 기준, 클수록 손이 많이 감
function effortOf(c: Candidate): number {
  let e = 1
  e += Math.min(c.aliasCount, 8) * 0.06 // 별칭 많음 = 명명/정규화 공수
  if (c.regulated) e += 0.5 // 인증/규제 카테고리 = 식품유형·claim 검토 공수
  if (c.needsImageFix) e += 0.35 // 이미지 보정 필요
  return Math.round(e * 100) / 100
}

// 후보 1개의 기대 광고비 추정 — 경쟁이 셀수록(=competition 낮을수록) 광고비 큼
function adSpendOf(c: Candidate, unit: number): number {
  const compFactor = 1 + (100 - c.competition) / 100 // 1.0 ~ 2.0
  return Math.round(unit * compFactor)
}

// 그리디 베팅 사이징: 슬롯 N + 광고예산 B 제약 하에서
// (상관 페널티 반영 한계기여 / 노력비용) 이 가장 큰 후보를 순차 선택.
function selectPortfolio(
  cands: Candidate[],
  slots: number,
  budget: number,
  corrPenalty: number,
  adUnit: number,
): { picks: Pick[]; leftover: number } {
  const remaining = [...cands]
  const picks: Pick[] = []
  const clusterCount = new Map<string, number>()
  const supplierCount = new Map<string, number>()
  let budgetLeft = budget

  while (picks.length < slots && remaining.length > 0) {
    let bestIdx = -1
    let bestScore = -Infinity
    let bestPick: Pick | null = null

    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i]
      const adSpend = adSpendOf(c, adUnit)
      if (adSpend > budgetLeft) continue // 예산 초과 후보 스킵

      // 기대값 = final_score(수익 프록시) × 실효마진
      const rawValue = c.finalScore * (0.4 + 0.6 * c.marginScore)
      // 상관 페널티: 같은 클러스터/도매처가 이미 담길수록 분산 점수 감점
      const clusterDiscount = Math.pow(corrPenalty, clusterCount.get(c.cluster) ?? 0)
      const supplierDiscount = Math.pow(corrPenalty, supplierCount.get(c.supplier) ?? 0)
      const marginalValue = rawValue * clusterDiscount * supplierDiscount
      const effort = effortOf(c)
      // 슬롯당 한계기여 = 노력비용 대비 가치
      const efficiency = marginalValue / effort

      if (efficiency > bestScore) {
        bestScore = efficiency
        bestIdx = i
        bestPick = { c, marginalValue, rawValue, estAdSpend: adSpend, effort, clusterDiscount, supplierDiscount }
      }
    }

    if (bestIdx < 0 || !bestPick) break // 남은 후보가 모두 예산 초과
    picks.push(bestPick)
    budgetLeft -= bestPick.estAdSpend
    clusterCount.set(bestPick.c.cluster, (clusterCount.get(bestPick.c.cluster) ?? 0) + 1)
    supplierCount.set(bestPick.c.supplier, (supplierCount.get(bestPick.c.supplier) ?? 0) + 1)
    remaining.splice(bestIdx, 1)
  }

  return { picks, leftover: budgetLeft }
}

const won = (n: number) => `${Math.round(n).toLocaleString()}원`

export default function PortfolioBoard({ candidates }: { candidates: Candidate[] }) {
  const [slots, setSlots] = useState(5)
  const [budget, setBudget] = useState(500_000)
  const [corr, setCorr] = useState(0.6)
  const [adUnit, setAdUnit] = useState(60_000) // 후보당 기준 광고비
  const [pending, startTransition] = useTransition()
  const [savedId, setSavedId] = useState<string | null>(null)
  const [saveErr, setSaveErr] = useState<string | null>(null)

  const { picks, leftover } = useMemo(
    () => selectPortfolio(candidates, slots, budget, corr, adUnit),
    [candidates, slots, budget, corr, adUnit],
  )

  const totalValue = picks.reduce((s, p) => s + p.marginalValue, 0)
  const totalSpend = picks.reduce((s, p) => s + p.estAdSpend, 0)
  const totalRaw = picks.reduce((s, p) => s + p.rawValue, 0)
  const diversification = totalRaw > 0 ? totalValue / totalRaw : 1 // 1 = 페널티 없음, 낮을수록 몰빵
  const maxMarginal = Math.max(1, ...picks.map((p) => p.marginalValue))
  const clusters = new Set(picks.map((p) => p.c.cluster)).size
  const suppliers = new Set(picks.map((p) => p.c.supplier)).size

  function onSave() {
    setSaveErr(null)
    setSavedId(null)
    startTransition(async () => {
      const res = await savePortfolio({
        slots,
        adBudget: budget,
        corrPenalty: corr,
        picks: picks.map((p) => ({
          productId: p.c.id,
          name: p.c.name,
          cluster: p.c.cluster,
          supplier: p.c.supplier,
          marginalValue: Math.round(p.marginalValue * 100) / 100,
          rawValue: Math.round(p.rawValue * 100) / 100,
          estAdSpend: p.estAdSpend,
          effort: p.effort,
        })),
      })
      if (res.ok) setSavedId(res.id)
      else setSaveErr(res.error)
    })
  }

  return (
    <div className="space-y-6">
      {/* 제약 슬라이더 */}
      <div className="rounded border border-gray-200 px-4 py-4 grid grid-cols-1 md:grid-cols-4 gap-5">
        <Slider
          label="주간 등록 슬롯 (N)"
          value={slots}
          min={1}
          max={12}
          step={1}
          onChange={setSlots}
          display={`${slots}개`}
        />
        <Slider
          label="광고예산 한도"
          value={budget}
          min={100_000}
          max={3_000_000}
          step={50_000}
          onChange={setBudget}
          display={won(budget)}
        />
        <Slider
          label="상관 페널티 (몰빵 감점)"
          value={corr}
          min={0.3}
          max={1}
          step={0.05}
          onChange={setCorr}
          display={corr >= 0.99 ? '없음(1.0)' : corr.toFixed(2)}
        />
        <Slider
          label="후보당 기준 광고비"
          value={adUnit}
          min={20_000}
          max={200_000}
          step={10_000}
          onChange={setAdUnit}
          display={won(adUnit)}
        />
      </div>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Kpi label="선택 슬롯" value={`${picks.length}/${slots}`} />
        <Kpi label="한계기여 합" value={totalValue.toFixed(1)} />
        <Kpi
          label="추정 광고비"
          value={won(totalSpend)}
          sub={`잔여 ${won(leftover)}`}
        />
        <Kpi
          label="분산도"
          value={`${Math.round(diversification * 100)}%`}
          sub={diversification < 0.7 ? '⚠ 몰빵 경향' : '양호'}
          highlight={diversification < 0.7}
        />
        <Kpi label="클러스터·도매처" value={`${clusters} · ${suppliers}`} sub="다양성" />
      </section>

      {/* 저장 */}
      <div className="flex items-center gap-3">
        <button
          onClick={onSave}
          disabled={pending || picks.length === 0}
          className="rounded bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          {pending ? '저장 중…' : '이번 주 베팅 저장'}
        </button>
        {savedId && <span className="text-xs text-green-700">✓ 저장됨 ({savedId.slice(0, 8)})</span>}
        {saveErr && <span className="text-xs text-red-700">저장 실패: {saveErr}</span>}
      </div>

      {/* 선택 결과 — 한계기여 시각화 */}
      {picks.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          제약(슬롯·예산)에 맞는 후보가 없음. 예산을 늘리거나 후보 데이터 누적을 기다리세요.
        </div>
      ) : (
        <div className="space-y-2">
          {picks.map((p, i) => (
            <div
              key={p.c.id}
              className="rounded border border-gray-200 p-3 hover:bg-gray-50 transition-colors"
            >
              <div className="flex items-start gap-3">
                <div className="w-7 text-center text-sm font-mono text-gray-400 pt-1">{i + 1}</div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium leading-snug truncate" title={p.c.name}>
                    {p.c.name}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1.5 text-[11px]">
                    <Tag>🧩 {p.c.cluster}</Tag>
                    <Tag>🏭 {p.c.supplier}</Tag>
                    <Tag>공수 ×{p.effort.toFixed(2)}</Tag>
                    {p.clusterDiscount < 0.999 && (
                      <Tag tone="amber">클러스터 ×{p.clusterDiscount.toFixed(2)}</Tag>
                    )}
                    {p.supplierDiscount < 0.999 && (
                      <Tag tone="amber">도매처 ×{p.supplierDiscount.toFixed(2)}</Tag>
                    )}
                    {p.c.regulated && <Tag tone="red">규제</Tag>}
                    {p.c.needsImageFix && <Tag tone="red">이미지보정</Tag>}
                  </div>
                  {/* 한계기여 막대 */}
                  <div className="mt-2 h-2 w-full rounded bg-gray-100 overflow-hidden">
                    <div
                      className="h-full bg-emerald-500"
                      style={{ width: `${(p.marginalValue / maxMarginal) * 100}%` }}
                    />
                  </div>
                </div>
                <div className="text-right flex-shrink-0">
                  <div className="text-lg font-bold font-mono text-emerald-700">
                    +{p.marginalValue.toFixed(1)}
                  </div>
                  <div className="text-[10px] text-gray-400 font-mono">
                    raw {p.rawValue.toFixed(1)}
                  </div>
                  <div className="text-[11px] text-gray-500 mt-0.5">{won(p.estAdSpend)}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 공식 */}
      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 베팅 사이징 공식 (그리디)</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          rawValue = final_score × (0.4 + 0.6 × 실효마진)
          <br />
          marginalValue = rawValue × corr^(같은클러스터수) × corr^(같은도매처수)
          <br />
          effort = 1 + alias×0.06 + 규제0.5 + 이미지보정0.35
          <br />
          광고비 = 기준광고비 × (1 + (100−competition)/100)
          <br />
          매 슬롯: argmax(marginalValue / effort) 중 예산 잔여 ≥ 광고비 인 후보 선택
        </code>
      </section>
    </div>
  )
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  display,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  display: string
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-xs text-gray-500">{label}</span>
        <span className="text-sm font-semibold font-mono">{display}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-2 w-full accent-black"
      />
    </div>
  )
}

function Kpi({
  label,
  value,
  sub,
  highlight = false,
}: {
  label: string
  value: string
  sub?: string
  highlight?: boolean
}) {
  return (
    <div className={`rounded border p-3 ${highlight ? 'border-amber-300 bg-amber-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-xl font-bold mt-1 ${highlight ? 'text-amber-700' : ''}`}>{value}</div>
      {sub && <div className="text-[10px] text-gray-400 mt-0.5">{sub}</div>}
    </div>
  )
}

function Tag({ children, tone = 'gray' }: { children: React.ReactNode; tone?: 'gray' | 'amber' | 'red' }) {
  const cls =
    tone === 'amber'
      ? 'bg-amber-100 text-amber-800'
      : tone === 'red'
        ? 'bg-red-100 text-red-700'
        : 'bg-gray-100 text-gray-600'
  return <span className={`px-1.5 py-0.5 rounded ${cls}`}>{children}</span>
}
