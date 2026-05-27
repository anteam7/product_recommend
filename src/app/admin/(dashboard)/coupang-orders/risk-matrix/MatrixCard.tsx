'use client'

import { useState, useTransition } from 'react'

export interface MatrixRow {
  order_row_id: string
  order_id: number
  order_item_id: number
  product_name: string
  option_name: string | null
  shipping_count: number
  order_price: number | null
  ordered_at: string
  hours_pending: number | null
  seller_product_id: number | null
  source_goods_no: string | null
  ggsan_title: string | null
  ggsan_status: string | null
  ggsan_is_imminent: boolean | null
  ggsan_price_krw: number | null
  ggsan_detail_url: string | null
  recovery_eta_days: number | null
  quadrant: 'Q1' | 'Q2' | 'Q3' | 'Q4'
}

type Quadrant = 'Q1' | 'Q2' | 'Q3' | 'Q4'

const QUADRANT_META: Record<
  Quadrant,
  { title: string; sub: string; tone: string; border: string; chip: string }
> = {
  Q1: {
    title: 'Q1 · 즉시 캔슬',
    sub: 'PENDING ≥12h + 도매 sold_out — 입고 불가능, 고객 사과 큐로',
    tone: 'bg-rose-50',
    border: 'border-rose-300',
    chip: 'bg-rose-600 text-white',
  },
  Q2: {
    title: 'Q2 · 긴급 발주 푸시',
    sub: 'PENDING ≥12h + imminent — 도매 재고 임박, 지금 발주 안 하면 Q1로 굴러감',
    tone: 'bg-amber-50',
    border: 'border-amber-300',
    chip: 'bg-amber-600 text-white',
  },
  Q3: {
    title: 'Q3 · 자동 발주 후보',
    sub: 'PENDING 4~12h + active — 정상 발주 SLA 안에 있음, 자동 발주 가능',
    tone: 'bg-blue-50',
    border: 'border-blue-300',
    chip: 'bg-blue-600 text-white',
  },
  Q4: {
    title: 'Q4 · 정상',
    sub: 'PENDING <4h + active — SLA 여유, 매시간 cron 으로 처리',
    tone: 'bg-emerald-50',
    border: 'border-emerald-300',
    chip: 'bg-emerald-600 text-white',
  },
}

function fmtPrice(n: number | null | undefined) {
  return n == null ? '—' : n.toLocaleString()
}

function EnqueueRefreshButton() {
  const [pending, startTransition] = useTransition()
  const [msg, setMsg] = useState<string | null>(null)

  function onClick() {
    setMsg(null)
    startTransition(async () => {
      try {
        const res = await fetch('/api/admin/coupang-orders/risk-matrix/enqueue-refresh', {
          method: 'POST',
        })
        const j = (await res.json()) as { ok?: boolean; alreadyActive?: boolean; error?: string }
        if (j.ok) {
          setMsg(j.alreadyActive ? '이미 갱신 중' : '갱신 큐잉 완료')
        } else {
          setMsg(j.error ?? '실패')
        }
      } catch (e) {
        setMsg(e instanceof Error ? e.message : '실패')
      }
    })
  }

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className="text-xs px-3 py-1 rounded bg-black text-white hover:bg-zinc-700 disabled:opacity-50"
      >
        {pending ? '큐잉 중…' : '↻ 도매 재고 즉시 갱신'}
      </button>
      {msg && <span className="text-xs text-zinc-600">{msg}</span>}
    </div>
  )
}

export function MatrixCard({ quadrant, rows }: { quadrant: Quadrant; rows: MatrixRow[] }) {
  const meta = QUADRANT_META[quadrant]
  const showRefresh = quadrant === 'Q1' || quadrant === 'Q2'
  return (
    <div className={`rounded-lg border ${meta.border} ${meta.tone} p-4 space-y-3`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className={`px-2 py-0.5 rounded text-xs font-bold ${meta.chip}`}>
              {quadrant}
            </span>
            <h2 className="text-base font-bold">{meta.title}</h2>
            <span className="text-xs text-zinc-500">· {rows.length}건</span>
          </div>
          <p className="text-xs text-zinc-600 mt-1">{meta.sub}</p>
        </div>
        {showRefresh && rows.length > 0 && <EnqueueRefreshButton />}
      </div>

      {rows.length === 0 ? (
        <div className="text-xs text-zinc-400 py-6 text-center">대상 주문 없음</div>
      ) : (
        <ul className="space-y-2">
          {rows.slice(0, 20).map((r) => (
            <li
              key={r.order_row_id}
              className="bg-white border border-zinc-200 rounded p-3 text-xs flex items-start gap-3"
            >
              <div className="flex-1 min-w-0">
                <div className="font-medium text-zinc-900 truncate">{r.product_name}</div>
                {r.option_name && (
                  <div className="text-[11px] text-zinc-500 truncate">{r.option_name}</div>
                )}
                <div className="text-[10px] text-zinc-400 mt-1">
                  order#{r.order_id} · item#{r.order_item_id}
                  {r.source_goods_no && <> · goods_no={r.source_goods_no}</>}
                </div>
              </div>
              <div className="text-right shrink-0 space-y-1">
                <div className="font-semibold tabular-nums">{fmtPrice(r.order_price)}원</div>
                <div className="text-[10px] text-zinc-500">
                  PENDING {r.hours_pending != null ? `${r.hours_pending}h` : '—'}
                </div>
                {(quadrant === 'Q1' || quadrant === 'Q2') && r.recovery_eta_days != null && (
                  <div className="inline-block text-[10px] px-1.5 py-0.5 rounded bg-zinc-900 text-white">
                    D+{Math.max(1, Math.round(r.recovery_eta_days))} 재입고 예상
                  </div>
                )}
                {r.ggsan_detail_url && (
                  <div>
                    <a
                      href={r.ggsan_detail_url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[10px] text-blue-600 hover:underline"
                    >
                      도매 보기 ↗
                    </a>
                  </div>
                )}
              </div>
            </li>
          ))}
          {rows.length > 20 && (
            <li className="text-[11px] text-zinc-400 text-center py-1">
              +{rows.length - 20}건 더…
            </li>
          )}
        </ul>
      )}
    </div>
  )
}
