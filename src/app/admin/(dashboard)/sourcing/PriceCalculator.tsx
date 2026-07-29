'use client'

import { useMemo, useState } from 'react'
import {
  BOX_COST, RG_LOGI, RG_MIN_PRICE, RG_TIERS, VAT,
  breakEvenPrice, marginAt, priceForRate, suggestTier, type CostInput, type RgTier,
} from '@/lib/sourcing/price-calc'

const won = (n: number | null | undefined) => (n == null ? '—' : Number(n).toLocaleString('ko-KR'))
const PRESET_N = [1, 2, 3, 5, 10]
const MAX_N = 50                    // 직접입력 상한 — 이 이상은 로켓그로스 1건 포장으로 비현실적
const TARGETS = [20, 25, 30, 40]
const DISCOUNTS = [0, 5, 10, 15]

type Props = {
  landed: number          // 개당 실단가(도매가 + 입고배송비/개)
  fee: number             // 판매수수료율
  baseTier: RgTier        // 1개 기준 로켓그로스 물류 티어
  unitMarket: number      // 개당 시장가(진입가 P25 ÷ 리스팅 매입수량)
  moq?: number | null
}

/**
 * 상품별 판매가 계산기 — "N개씩 팔 때 목표 마진을 남기려면 얼마를 받아야 하는가".
 * 시장가(개당 P25) 대비 실현 가능한지까지 같이 보여준다. 권장가가 시장가보다 높으면 그 마진율은 현실에서 안 나온다.
 */
export default function PriceCalculator({ landed, fee, baseTier, unitMarket, moq }: Props) {
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState(30)
  const [disc, setDisc] = useState(10)          // 묶음 개당 할인율(2개 이상) — 묶음은 개당가를 낮춰야 팔린다
  const [tierSel, setTierSel] = useState<'auto' | RgTier>('auto')
  const [promo, setPromo] = useState(false)     // 신규 90일 물류비 0
  const [customN, setCustomN] = useState('')

  const rows = useMemo(() => {
    // 직접입력은 "3.7" "abc" "999" 같은 값이 그대로 계산에 흘러들지 않게 정수 1~50 만 채택한다
    const extra = Math.trunc(Number(customN))
    const useExtra = customN.trim() !== '' && Number.isInteger(extra) && extra >= 1 && extra <= MAX_N && !PRESET_N.includes(extra)
    const ns = [...PRESET_N, ...(useExtra ? [extra] : [])].sort((a, b) => a - b)
    return ns.map((n) => {
      const tier: RgTier = tierSel === 'auto' ? suggestTier(baseTier, n) : tierSel
      const cost: CostInput = { landed, qty: n, fee, logi: promo ? 0 : RG_LOGI[tier] }
      const rec = priceForRate(target / 100, cost)
      const be = breakEvenPrice(cost)
      // 묶음 시장가 = 개당 시장가 × N × (1 − 묶음할인). 1개는 할인 없음.
      const market = Math.max(RG_MIN_PRICE, Math.round((unitMarket * n * (n > 1 ? 1 - disc / 100 : 1)) / 100) * 100)
      const at = marginAt(market, cost)
      return {
        n, tier, rec, be, market, ...at,
        perUnit: rec != null && n > 0 ? Math.round(rec / n) : null,
        feasible: rec != null && rec <= market,       // 목표 마진율을 시장가 안에서 달성 가능한가
      }
    })
  }, [landed, fee, baseTier, unitMarket, target, disc, tierSel, promo, customN])

  // 추천 = 시장가로 팔아서 목표 마진율이 나오는 '가장 작은' 묶음.
  // 마진액 최대로 잡으면 개당 시장가가 일정하다는 가정 탓에 항상 최대 묶음이 뽑혀 정보가 없다.
  // 작은 묶음일수록 판매 단가가 낮아 회전이 빠르고 재고 자금이 덜 묶인다 — 물류비가 고정비라
  // 저가품은 1개 판매가 적자이고 N개부터 흑자로 도는데, 그 전환점을 찍어주는 것이 이 계산기의 핵심이다.
  const best = useMemo(() => {
    const ok = rows.filter((r) => r.margin > 0 && r.rate >= target).sort((a, b) => a.n - b.n)
    if (ok.length) return { ...ok[0], meets: true }
    const pos = rows.filter((r) => r.margin > 0).sort((a, b) => b.rate - a.rate)
    return pos.length ? { ...pos[0], meets: false } : null
  }, [rows, target])

  if (!(landed > 0) || !(unitMarket > 0)) return null

  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50/60">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 text-[12px] font-bold text-gray-700 hover:text-black"
      >
        <span>💰 판매가 계산기</span>
        <span className={`font-semibold ${best?.meets ? 'text-emerald-700' : 'text-gray-400'}`}>
          {best == null
            ? '전 구성 적자'
            : best.meets
              ? `${best.n}개 ${won(best.market)}원 → ${best.rate}%`
              : `최선 ${best.n}개 ${best.rate}% (목표 미달)`} {open ? '▲' : '▼'}
        </span>
      </button>

      {open && (
        <div className="px-2.5 pb-2.5 space-y-2">
          {/* 컨트롤 */}
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-[10px] text-gray-400 mr-0.5">목표 마진율</span>
            {TARGETS.map((t) => (
              <Chip key={t} on={target === t} onClick={() => setTarget(t)}>{t}%</Chip>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-[10px] text-gray-400 mr-0.5">묶음 할인</span>
            {DISCOUNTS.map((d) => (
              <Chip key={d} on={disc === d} onClick={() => setDisc(d)}>{d}%</Chip>
            ))}
            <span className="text-[10px] text-gray-400 ml-1.5 mr-0.5">물류</span>
            <select
              value={tierSel}
              onChange={(e) => setTierSel(e.target.value as 'auto' | RgTier)}
              className="rounded border border-gray-300 bg-white px-1 py-0.5 text-[11px] font-semibold text-gray-700"
            >
              <option value="auto">자동(부피추정)</option>
              {RG_TIERS.map((t) => <option key={t} value={t}>{t} {RG_LOGI[t]}원</option>)}
            </select>
            <Chip on={promo} onClick={() => setPromo((v) => !v)}>🚀 90일</Chip>
          </div>

          {/* 결과 표 */}
          <div className="overflow-x-auto">
            <table className="w-full text-[11px] tabular-nums">
              <thead>
                <tr className="text-gray-400 text-left">
                  <th className="font-semibold py-1 pr-1">구성</th>
                  <th className="font-semibold py-1 px-1 text-right">권장가({target}%)</th>
                  <th className="font-semibold py-1 px-1 text-right">개당</th>
                  <th className="font-semibold py-1 px-1 text-right">손익분기</th>
                  <th className="font-semibold py-1 pl-1 text-right">시장가 판매 시</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.n} className={`border-t border-gray-200 ${best?.n === r.n ? 'bg-emerald-50' : ''}`}>
                    <td className="py-1 pr-1 font-bold text-gray-700 whitespace-nowrap">
                      {r.n}개{best?.n === r.n && <span className={`ml-1 ${best.meets ? 'text-emerald-600' : 'text-amber-600'}`}>{best.meets ? '추천' : '최선'}</span>}
                    </td>
                    <td className={`py-1 px-1 text-right font-bold ${r.feasible ? 'text-emerald-700' : 'text-amber-600'}`}>
                      {r.rec == null ? '불가' : won(r.rec)}
                      {r.rec != null && !r.feasible && <span title="시장가보다 비쌈 — 이 마진율은 현실적으로 안 나옴"> ⚠</span>}
                    </td>
                    <td className="py-1 px-1 text-right text-gray-500">{won(r.perUnit)}</td>
                    <td className="py-1 px-1 text-right text-gray-500">{won(r.be)}</td>
                    <td className="py-1 pl-1 text-right whitespace-nowrap">
                      <b className={r.margin > 0 ? 'text-gray-900' : 'text-rose-600'}>{r.margin > 0 ? '+' : ''}{won(r.margin)}</b>
                      <span className="text-gray-400"> ({r.rate}%)</span>
                      <div className="text-[10px] text-gray-400 leading-tight">가격 {won(r.market)}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 직접 입력 + 근거 */}
          <div className="flex items-center gap-1.5">
            <label className="text-[10px] text-gray-400">직접</label>
            <input
              type="number" min={1} max={MAX_N} step={1} value={customN} placeholder="예: 4"
              onChange={(e) => setCustomN(e.target.value)}
              className="w-16 rounded border border-gray-300 bg-white px-1.5 py-0.5 text-[11px] tabular-nums"
            />
            <span className="text-[10px] text-gray-400">개 묶음 추가</span>
            {moq != null && moq > 1 && <span className="ml-auto text-[10px] text-amber-600 font-semibold">도매 MOQ {moq}개</span>}
          </div>
          <p className="text-[10px] text-gray-400 leading-relaxed">
            원가 = 실단가 {won(landed)}원 × 개수 + 물류비{promo ? ' 0(90일 프로모션)' : ''} + 판매수수료 {(fee * 100).toFixed(1)}% + 박스 {won(BOX_COST)}원
            {' '}(수수료·물류 부가세 {Math.round((VAT - 1) * 100)}% 포함). 시장가는 개당 진입가 {won(unitMarket)}원 기준
            {disc > 0 ? `, 묶음은 개당 ${disc}% 할인 가정` : ''}. 최소 판매가 {won(RG_MIN_PRICE)}원.
            <br />추천은 <b className="text-gray-500">목표 마진율이 나오는 가장 작은 묶음</b>입니다 — 묶음이 클수록 마진액은 커 보이지만 판매 단가가 올라 회전이 느려지고 재고 자금이 묶입니다.
          </p>
        </div>
      )}
    </div>
  )
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold border transition ${on ? 'bg-emerald-600 border-emerald-600 text-white' : 'border-gray-300 bg-white text-gray-500 hover:border-emerald-400'}`}
    >{children}</button>
  )
}
