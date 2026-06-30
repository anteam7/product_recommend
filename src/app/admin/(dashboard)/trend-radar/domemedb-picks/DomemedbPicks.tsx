'use client'

import { useCallback, useEffect, useState } from 'react'

type Cand = {
  supplier_goods_no: string
  title: string | null
  supply_price: number | null
  coupang_price: number | null
  reviews: number | null
  est_margin_krw: number | null
  est_margin_rate: number | null
  market_source: string | null
  page_source: string | null
  detail_url: string | null
  image_url: string | null
  last_checked_at: string
}
type RunState = { status: string; found: number; screened: number; target: number; message: string | null; updated_at: string } | null

const SRC: Record<string, string> = { new: '🆕 신규', popular: '🔥 인기', event: '🎯 기획전' }
const marginCls = (r: number | null) => (r == null ? '' : r >= 20 ? 'bg-emerald-200 text-emerald-900' : r >= 10 ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-800')

export default function DomemedbPicks() {
  const [cands, setCands] = useState<Cand[]>([])
  const [state, setState] = useState<RunState>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try { const r = await fetch('/api/admin/domemedb-picks', { cache: 'no-store' }); const j = await r.json(); if (Array.isArray(j.candidates)) setCands(j.candidates); setState(j.state ?? null) } catch { /* noop */ }
  }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => { const t = setInterval(load, 4000); return () => clearInterval(t) }, [load])

  const running = state?.status === 'running'
  async function refresh() {
    if (busy || running) return
    setBusy(true)
    try {
      const r = await fetch('/api/admin/domemedb-picks/refresh', { method: 'POST' })
      const j = await r.json()
      if (!j.ok) alert(j.error || '실행 요청 실패')
      else { await load() }
    } finally { setBusy(false) }
  }

  return (
    <div className="space-y-4">
      <div className="rounded border border-gray-200 p-3 flex items-center justify-between gap-3 flex-wrap">
        <div className="text-sm">
          {running ? (
            <span className="text-blue-700 font-medium">⏳ 흑자 후보 찾는 중… <b>{state?.found ?? 0}/{state?.target ?? 30}</b> (스크린 {state?.screened ?? 0})</span>
          ) : (
            <span className="text-gray-600">{state?.message || `저장된 흑자 후보 ${cands.length}개`}{state?.updated_at ? ` · ${new Date(state.updated_at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ''}</span>
          )}
        </div>
        <button onClick={refresh} disabled={busy || running} className="bg-sky-600 text-white text-sm font-semibold px-4 py-2 rounded disabled:opacity-50">
          {running ? '실행 중…' : busy ? '요청 중…' : '🔎 추가로 흑자 찾기'}
        </button>
      </div>
      {running && <div className="h-1.5 bg-gray-100 rounded overflow-hidden"><div className="h-full bg-blue-500 transition-all" style={{ width: `${Math.min(100, Math.round(((state?.found ?? 0) / (state?.target || 30)) * 100))}%` }} /></div>}
      <p className="text-[11px] text-gray-400">상시 실행기(work-agent)가 PC에 떠 있어야 처리됩니다. 쿠팡 시세 조회로 수~수십 분 걸릴 수 있고, 진행은 위에 실시간 표시됩니다.</p>

      {cands.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-10 text-center text-gray-500 text-sm">
          아직 흑자 후보가 없습니다. <b>추가로 흑자 찾기</b>를 눌러 시작하세요.
        </div>
      ) : (
        <div className="space-y-2">
          {cands.map((c, i) => (
            <a key={c.supplier_goods_no} href={c.detail_url ?? '#'} target="_blank" rel="noopener" className="block rounded border border-gray-200 hover:bg-gray-50 p-3">
              <div className="flex items-start gap-3">
                <div className="w-7 text-center text-sm font-mono text-gray-400 pt-1">{i + 1}</div>
                <div className="w-16 h-16 bg-gray-100 rounded overflow-hidden flex-shrink-0">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {c.image_url && <img src={c.image_url} alt="" loading="lazy" className="w-full h-full object-cover" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium leading-snug" title={c.title ?? ''}>{c.title}</div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {c.page_source && <span className="mr-2">{SRC[c.page_source] ?? c.page_source}</span>}
                    {c.reviews != null ? `후기 ${c.reviews.toLocaleString()}` : <span className="text-gray-400">시세 {c.market_source === 'naver' ? '네이버' : c.market_source}</span>}
                  </div>
                </div>
                <div className="text-right flex-shrink-0 space-y-1">
                  <div className={`inline-block text-xs px-2 py-0.5 rounded ${marginCls(c.est_margin_rate)}`}>마진 {c.est_margin_rate}%</div>
                  <div className="text-base font-bold text-emerald-700">+{c.est_margin_krw?.toLocaleString()}원</div>
                  <div className="text-[10px] text-gray-500 font-mono">공급 {c.supply_price?.toLocaleString()} → {c.market_source === 'naver' ? '네이버' : '쿠팡'} {c.coupang_price?.toLocaleString()}</div>
                </div>
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  )
}
