'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import PriceCalculator from './PriceCalculator'
import { deriveLogi, parseSetQty, tierOfLogi, type RgTier } from '@/lib/sourcing/price-calc'

type Cand = {
  id: string
  name: string | null
  coupang_url: string | null
  coupang_image: string | null
  dome_url: string | null
  dome_title: string | null
  dome_image: string | null
  sell: number | null
  unit: number | null
  inbound: number | null
  landed: number | null
  margin: number | null
  rate: number | null
  margin_promo: number | null
  rate_promo: number | null
  commission: number | null
  moq: number | null
  inventory: number | null
  send_avg: string | null
  has_option: boolean | null
  review_count: number | null
  set_qty?: number | null   // publish 가 매입수량을 반영해 발행하면 채워진다(없으면 화면에서 보정)
}

const won = (n: number | null | undefined) => (n == null ? '—' : Number(n).toLocaleString('ko-KR'))
const tierOf = (r: number | null | undefined) => (r == null ? 'low' : r >= 40 ? 'hi' : r >= 30 ? 'mid' : 'low')
const tierLabel: Record<string, string> = { hi: '우수', mid: '양호', low: '박함' }
const chipCls: Record<string, string> = {
  hi: 'bg-emerald-100 text-emerald-700',
  mid: 'bg-cyan-100 text-cyan-700',
  low: 'bg-amber-100 text-amber-700',
}

type Sort = 'margin' | 'rate' | 'sell'

// 발행 스냅샷 보정 — publish 스크립트가 매입원가를 1개분만 잡아 "N개 묶음" 리스팅의 마진이 과대다.
// (예: "수납정리함, 8개"는 도매 300원×8=2,400원이 원가인데 300원으로 계산돼 +11,288원 흑자로 표시)
// 화면에서는 실제 매입수량을 곱해 다시 계산한 값을 쓴다. 물류비는 정상/프로모션 마진 차이에서 역산.
type Row = Cand & {
  qty: number; unitMarket: number; logi: number | null; rgTier: RgTier
  fixMargin: number; fixRate: number; fixPromo: number; fixPromoRate: number
}
function enrich(c: Cand): Row {
  // set_qty 가 발행에 포함돼 있으면 스냅샷이 이미 매입수량을 반영한 것 → 보정하면 이중 차감이 된다
  const published = c.set_qty != null && c.set_qty > 0
  const qty = published ? c.set_qty! : parseSetQty(c.name)
  const landed = c.landed ?? 0
  const extra = published ? 0 : landed * (qty - 1)       // 누락됐던 추가 매입원가
  const sell = c.sell ?? 0
  const fixMargin = (c.margin ?? 0) - extra
  const fixPromo = (c.margin_promo ?? 0) - extra
  const logi = deriveLogi(c.margin, c.margin_promo)
  return {
    ...c, qty, logi, rgTier: tierOfLogi(logi),
    unitMarket: qty > 0 ? Math.round(sell / qty) : sell,
    fixMargin, fixRate: sell > 0 ? Math.round((fixMargin / sell) * 100) : 0,
    fixPromo, fixPromoRate: sell > 0 ? Math.round((fixPromo / sell) * 100) : 0,
  }
}

export default function SourcingCompare() {
  const [cands, setCands] = useState<Cand[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [sort, setSort] = useState<Sort>('margin')
  const [tier, setTier] = useState<string | null>(null)
  const [single, setSingle] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/sourcing', { cache: 'no-store' })
      // 401/500 을 '후보 없음'으로 오판하지 않게 상태코드를 구분한다
      if (!r.ok) throw new Error(`후보 조회 실패 (HTTP ${r.status})`)
      const j = await r.json()
      if (!Array.isArray(j.candidates)) throw new Error('응답 형식이 올바르지 않습니다')
      setCands(j.candidates)
      setErr(null)
    } catch (e) { setErr(e instanceof Error ? e.message : '후보를 불러오지 못했습니다') } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  const rows = useMemo(() => cands.map(enrich), [cands])

  const view = useMemo(() => {
    let v = rows.filter((c) => c.fixMargin > 0)
    if (tier) v = v.filter((c) => tierOf(c.fixRate) === tier)
    if (single) v = v.filter((c) => !c.has_option)
    const key = (r: Row) => (sort === 'margin' ? r.fixMargin : sort === 'rate' ? r.fixRate : (r.sell ?? 0))
    return [...v].sort((a, b) => key(b) - key(a))
  }, [rows, sort, tier, single])

  const stats = useMemo(() => {
    const v = rows.filter((c) => c.fixMargin > 0)
    const hi = v.filter((c) => c.fixRate >= 40).length
    const mid = v.filter((c) => c.fixRate >= 30 && c.fixRate < 40).length
    const low = v.filter((c) => c.fixRate < 30).length
    const avg = v.length ? Math.round(v.reduce((a, c) => a + c.fixRate, 0) / v.length) : 0
    const singleN = v.filter((c) => !c.has_option).length
    // 보정 전에는 흑자였지만 매입수량을 곱하니 적자가 된 건 — 조용히 사라지면 안 되므로 건수를 알린다
    const dropped = rows.filter((c) => (c.margin ?? 0) > 0 && c.fixMargin <= 0).length
    return { total: v.length, hi, mid, low, avg, singleN, dropped }
  }, [rows])

  const sortBtn = (key: Sort, label: string) => (
    <button
      onClick={() => setSort(key)}
      aria-pressed={sort === key}
      className={`rounded-full px-3 py-1 text-xs font-semibold border transition ${sort === key ? 'bg-emerald-600 border-emerald-600 text-white' : 'border-gray-300 text-gray-500 hover:text-black hover:border-emerald-500'}`}
    >{label}</button>
  )
  const tierBtn = (key: string, label: string) => (
    <button
      onClick={() => setTier(tier === key ? null : key)}
      aria-pressed={tier === key}
      className={`rounded-full px-3 py-1 text-xs font-semibold border transition ${tier === key ? 'bg-emerald-600 border-emerald-600 text-white' : 'border-gray-300 text-gray-500 hover:text-black hover:border-emerald-500'}`}
    >{label}</button>
  )

  if (loading) return <p className="text-sm text-gray-500">불러오는 중…</p>
  if (err) return (
    <p className="text-sm text-rose-600">
      {err} — 후보가 없는 것이 아니라 조회에 실패했습니다.{' '}
      <button onClick={() => { setErr(null); setLoading(true); load() }} className="underline font-semibold">다시 시도</button>
    </p>
  )
  if (!cands.length) return <p className="text-sm text-gray-500">아직 발행된 소싱 후보가 없습니다. (scripts/scout-sourcing-publish.mjs 실행 후 표시)</p>

  return (
    <div className="space-y-4">
      {/* 요약 */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-gray-200 bg-white p-3 sm:p-4">
        <Stat n={stats.total} label="흑자 후보" />
        <Stat n={stats.hi} label="우수 40%+" sep />
        <Stat n={stats.mid} label="양호 30–39%" />
        <Stat n={stats.low} label="박함 20–29%" />
        <Stat n={`${stats.avg}%`} label="평균 마진율" sep />
        <Stat n={stats.singleN} label="단일옵션" />
        {stats.dropped > 0 && (
          <p className="w-full text-[11px] text-amber-700 bg-amber-50 rounded-lg px-2.5 py-1.5">
            ⚠ 매입수량 보정으로 <b>{stats.dropped}건</b>이 적자 전환되어 목록에서 빠졌습니다 — 상품명이 &quot;N개&quot;인 묶음은 도매 공급가를 N배로 매입해야 하는데 발행 스냅샷은 1개분만 잡고 있었습니다(화면에서 재계산).
          </p>
        )}
      </div>

      {/* 컨트롤 */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-gray-200 bg-white p-3">
        <span className="text-[11px] uppercase tracking-wide text-gray-400 mr-1">정렬</span>
        {sortBtn('margin', '마진액')}{sortBtn('rate', '마진율')}{sortBtn('sell', '진입가')}
        <span className="text-[11px] uppercase tracking-wide text-gray-400 ml-2 mr-1">마진</span>
        {tierBtn('hi', '우수')}{tierBtn('mid', '양호')}{tierBtn('low', '박함')}
        <button
          onClick={() => setSingle((s) => !s)}
          aria-pressed={single}
          className={`rounded-full px-3 py-1 text-xs font-semibold border transition ${single ? 'bg-emerald-600 border-emerald-600 text-white' : 'border-gray-300 text-gray-500 hover:text-black hover:border-emerald-500'}`}
        >단일옵션만</button>
        <span className="ml-auto text-xs text-gray-400 tabular-nums">{view.length}건</span>
      </div>

      {/* 카드 그리드 */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {view.map((c) => {
          const t = tierOf(c.fixRate)
          return (
            <article key={c.id} className="flex flex-col rounded-xl border border-gray-200 bg-white overflow-hidden hover:border-emerald-400 transition">
              <div className="flex items-center justify-center gap-2.5 px-3 pt-3 pb-1.5 bg-gradient-to-b from-gray-50 to-transparent">
                <Thumb src={c.dome_image} cap="도매꾹" />
                <span className="text-gray-400 text-sm">↔</span>
                <Thumb src={c.coupang_image} cap="쿠팡" />
              </div>
              <div className="flex flex-col gap-2 px-4 pb-3 flex-1">
                <div className="flex items-baseline justify-between gap-2 mt-1.5">
                  <span className={`inline-flex items-baseline gap-1 rounded-lg px-2.5 py-0.5 text-base font-extrabold tabular-nums ${chipCls[t]}`}>
                    {c.fixRate}%<small className="text-[10px] font-bold opacity-80">{tierLabel[t]}</small>
                  </span>
                  <span className="text-sm font-bold tabular-nums">+{won(c.fixMargin)}<small className="text-[10px] text-gray-400 font-semibold ml-0.5">원/건</small></span>
                </div>
                <div className="flex items-center justify-between gap-2 -mt-1">
                  <span className="inline-flex items-center gap-1 rounded bg-violet-100 text-violet-700 px-2 py-0.5 text-[11px] font-bold tabular-nums">
                    🚀 90일 프로모션 {c.fixPromoRate}%<small className="font-semibold opacity-80">+{won(c.fixPromo)}</small>
                  </span>
                  <span className="text-[10px] text-gray-400">수수료 {c.commission != null ? (c.commission * 100).toFixed(1) : '?'}%</span>
                </div>
                <h3 className="text-sm font-semibold leading-snug line-clamp-2">{c.name}</h3>
                <p className="text-xs text-gray-500 truncate">도매 실물: {c.dome_title}</p>
                <div className="flex gap-2">
                  <div className="flex-1 rounded-lg bg-gray-50 px-2.5 py-1.5">
                    <div className="text-[10px] uppercase tracking-wide text-gray-400">진입가{c.qty > 1 ? ` (${c.qty}개 기준)` : ''}</div>
                    <div className="text-sm font-bold tabular-nums">{won(c.sell)}</div>
                    {c.qty > 1 && <div className="text-[9px] text-gray-400 leading-tight">개당 {won(c.unitMarket)}</div>}
                  </div>
                  <div className="flex-1 rounded-lg bg-gray-50 px-2.5 py-1.5">
                    <div className="text-[10px] uppercase tracking-wide text-gray-400">실단가</div>
                    <div className="text-sm font-bold tabular-nums text-emerald-700">
                      {won(c.landed)}{c.qty > 1 && <small className="text-[10px] text-gray-500 font-semibold"> ×{c.qty}={won((c.landed ?? 0) * c.qty)}</small>}
                    </div>
                    <div className="text-[9px] text-gray-400 leading-tight">도매 {won(c.unit)}+배송 {won(c.inbound)}</div>
                  </div>
                </div>
                <ul className="flex flex-wrap gap-1.5 text-[11px]">
                  <Meta>MOQ <b className="text-gray-900">{c.moq}</b></Meta>
                  <Meta>재고 <b className="text-gray-900">{won(c.inventory)}</b></Meta>
                  <Meta>발송 <b className="text-gray-900">{c.send_avg ?? '?'}일</b></Meta>
                  {c.qty > 1 && <li className="rounded bg-sky-100 text-sky-700 font-bold px-1.5 py-0.5">매입 ×{c.qty}</li>}
                  {c.has_option
                    ? <li className="rounded bg-amber-100 text-amber-700 font-bold px-1.5 py-0.5">옵션 확인</li>
                    : <li className="rounded bg-gray-100 text-gray-500 px-1.5 py-0.5">단일옵션</li>}
                  <Meta>리뷰 {won(c.review_count)}</Meta>
                </ul>
                {/* 상품별 판매가 계산기 — 1개/묶음별로 목표 마진을 남기는 판매가 */}
                <PriceCalculator
                  landed={c.landed ?? 0}
                  fee={c.commission ?? 0.108}
                  baseTier={c.rgTier}
                  unitMarket={c.unitMarket}
                  moq={c.moq}
                />
              </div>
              <div className="flex gap-2 px-4 pb-4">
                <a href={c.dome_url ?? '#'} target="_blank" rel="noopener noreferrer"
                  className="flex-1 text-center text-[13px] font-bold py-2 rounded-lg bg-emerald-600 text-white hover:brightness-105">도매꾹 매입 →</a>
                <a href={c.coupang_url ?? '#'} target="_blank" rel="noopener noreferrer"
                  className="flex-1 text-center text-[13px] font-bold py-2 rounded-lg border border-gray-300 text-gray-800 hover:border-emerald-400">쿠팡 비교</a>
              </div>
            </article>
          )
        })}
      </div>

      <p className="text-xs text-gray-500 leading-relaxed pt-2">
        <b className="text-gray-800">마진 두 종류</b> — 큰 칩은 <b className="text-gray-800">정상 마진</b>(로켓그로스 물류비 포함, 90일 이후 지속가능 기준). <span className="text-violet-700 font-semibold">🚀 90일 프로모션</span>은 신규 판매자 첫 90일 물류비(입출고·배송·보관·반품) 0원 적용 시 마진(판매수수료만) — 초기 런칭·테스트에 유리하지만 <b className="text-gray-800">상품 선정은 정상 마진 기준</b>으로 하세요(프로모션 끝나면 물류비가 붙습니다). 판매수수료는 카테고리별 실제 요율 적용.
        <br /><b className="text-gray-800">💰 판매가 계산기</b> — 카드마다 접혀 있습니다. <b className="text-gray-800">1·2·3·5·10개(직접 입력 가능) 묶음별로</b> ① 목표 마진율을 남기는 <b className="text-gray-800">권장 판매가</b>와 개당가 ② <b className="text-gray-800">손익분기가</b> ③ 시장가로 팔 때 실제 마진을 계산합니다. 권장가가 시장가보다 비싸면 <span className="text-amber-600 font-semibold">⚠</span>로 표시 — 그 마진율은 현실에서 안 나옵니다. 물류비는 묶음 부피를 반영해 티어를 자동 상향 추정하며 직접 지정할 수 있고, 묶음 할인은 기본 10%(개당가 기준) 가정입니다.
        <br /><b className="text-gray-800">확인 방법</b> — 두 썸네일(도매꾹 ↔ 쿠팡)이 같은/유사 물건인지 대조하고, <b className="text-gray-800">옵션 확인</b> 표시가 있으면 도매꾹에서 실제 옵션 단가를 확인하세요. 진입가는 브랜드 프리미엄을 뺀 시장 하위 25%가(P25) 기준. <b className="text-gray-800">매입 ×N</b> 표시는 상품명이 N개 묶음이라 도매 공급가를 N배로 매입해야 한다는 뜻입니다. 로켓그로스 최소 판매가 3,000원 이상 필수.
      </p>
    </div>
  )
}

function Stat({ n, label, sep }: { n: number | string; label: string; sep?: boolean }) {
  return (
    <div className={`flex flex-col ${sep ? 'border-l border-gray-200 pl-4 sm:pl-6' : ''}`}>
      <b className="text-lg tabular-nums leading-tight">{n}</b>
      <span className="text-[11px] text-gray-400">{label}</span>
    </div>
  )
}
function Meta({ children }: { children: React.ReactNode }) {
  return <li className="rounded bg-gray-100 text-gray-500 px-1.5 py-0.5 tabular-nums">{children}</li>
}
function Thumb({ src, cap }: { src: string | null; cap: string }) {
  return (
    <figure className="m-0 flex flex-col items-center gap-1">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img loading="lazy" src={src ?? ''} alt={cap} referrerPolicy="no-referrer"
        className="w-[86px] h-[86px] object-contain bg-white border border-gray-200 rounded-lg" />
      <figcaption className="text-[10px] uppercase tracking-wide text-gray-400 font-bold">{cap}</figcaption>
    </figure>
  )
}
