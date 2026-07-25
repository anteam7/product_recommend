'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'

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
  moq: number | null
  inventory: number | null
  send_avg: string | null
  has_option: boolean | null
  review_count: number | null
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

export default function SourcingCompare() {
  const [cands, setCands] = useState<Cand[]>([])
  const [loading, setLoading] = useState(true)
  const [sort, setSort] = useState<Sort>('margin')
  const [tier, setTier] = useState<string | null>(null)
  const [single, setSingle] = useState(false)

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/sourcing', { cache: 'no-store' })
      const j = await r.json()
      if (Array.isArray(j.candidates)) setCands(j.candidates)
    } catch { /* noop */ } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])

  const view = useMemo(() => {
    let v = cands.filter((c) => (c.margin ?? 0) > 0)
    if (tier) v = v.filter((c) => tierOf(c.rate) === tier)
    if (single) v = v.filter((c) => !c.has_option)
    return [...v].sort((a, b) => (Number(b[sort]) || 0) - (Number(a[sort]) || 0))
  }, [cands, sort, tier, single])

  const stats = useMemo(() => {
    const v = cands.filter((c) => (c.margin ?? 0) > 0)
    const hi = v.filter((c) => (c.rate ?? 0) >= 40).length
    const mid = v.filter((c) => (c.rate ?? 0) >= 30 && (c.rate ?? 0) < 40).length
    const low = v.filter((c) => (c.rate ?? 0) < 30).length
    const avg = v.length ? Math.round(v.reduce((a, c) => a + (c.rate ?? 0), 0) / v.length) : 0
    const singleN = v.filter((c) => !c.has_option).length
    return { total: v.length, hi, mid, low, avg, singleN }
  }, [cands])

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
          const t = tierOf(c.rate)
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
                    {c.rate}%<small className="text-[10px] font-bold opacity-80">{tierLabel[t]}</small>
                  </span>
                  <span className="text-sm font-bold tabular-nums">+{won(c.margin)}<small className="text-[10px] text-gray-400 font-semibold ml-0.5">원/개</small></span>
                </div>
                <h3 className="text-sm font-semibold leading-snug line-clamp-2">{c.name}</h3>
                <p className="text-xs text-gray-500 truncate">도매 실물: {c.dome_title}</p>
                <div className="flex gap-2">
                  <div className="flex-1 rounded-lg bg-gray-50 px-2.5 py-1.5">
                    <div className="text-[10px] uppercase tracking-wide text-gray-400">진입가</div>
                    <div className="text-sm font-bold tabular-nums">{won(c.sell)}</div>
                  </div>
                  <div className="flex-1 rounded-lg bg-gray-50 px-2.5 py-1.5">
                    <div className="text-[10px] uppercase tracking-wide text-gray-400">실단가</div>
                    <div className="text-sm font-bold tabular-nums text-emerald-700">{won(c.landed)}</div>
                    <div className="text-[9px] text-gray-400 leading-tight">도매 {won(c.unit)}+배송 {won(c.inbound)}</div>
                  </div>
                </div>
                <ul className="flex flex-wrap gap-1.5 text-[11px]">
                  <Meta>MOQ <b className="text-gray-900">{c.moq}</b></Meta>
                  <Meta>재고 <b className="text-gray-900">{won(c.inventory)}</b></Meta>
                  <Meta>발송 <b className="text-gray-900">{c.send_avg ?? '?'}일</b></Meta>
                  {c.has_option
                    ? <li className="rounded bg-amber-100 text-amber-700 font-bold px-1.5 py-0.5">옵션 확인</li>
                    : <li className="rounded bg-gray-100 text-gray-500 px-1.5 py-0.5">단일옵션</li>}
                  <Meta>리뷰 {won(c.review_count)}</Meta>
                </ul>
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
        <b className="text-gray-800">확인 방법</b> — 두 썸네일(도매꾹 ↔ 쿠팡)이 같은/유사 물건인지 대조하고, <b className="text-gray-800">옵션 확인</b> 표시가 있으면 도매꾹에서 원하는 옵션의 실제 단가를 확인하세요(표시 단가는 기본가). 마진은 방향성 추정 — 로켓그로스 반품·보관·광고비는 별도라 실질 여유는 더 얇을 수 있습니다. 진입가는 브랜드 프리미엄을 뺀 시장 하위 25%가(P25) 기준.
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
