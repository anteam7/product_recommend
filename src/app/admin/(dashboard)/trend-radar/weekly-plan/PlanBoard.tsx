'use client'

import { useState, useTransition } from 'react'
import type { PlanItem } from './planner'
import { confirmWeeklyPlan, toggleDone } from './actions'

interface Props {
  weekStart: string
  items: PlanItem[]
  /** goods_no → 저장된 상태(done 여부). 미저장이면 없음. */
  savedDone: Record<string, boolean>
  /** 이미 저장된 주차인지 (확정 버튼 라벨용). */
  hasSaved: boolean
  capacity: number
}

export default function PlanBoard({ weekStart, items, savedDone, hasSaved, capacity }: Props) {
  const [pending, startTransition] = useTransition()
  const [msg, setMsg] = useState<string | null>(null)
  // 로컬 done 상태 (서버 저장 + 낙관적 반영)
  const [doneMap, setDoneMap] = useState<Record<string, boolean>>(savedDone)

  const nowItems = items.filter((i) => i.group_type === 'now')
  const weekItems = items.filter((i) => i.group_type === 'week')

  const doneCount = items.filter((i) => doneMap[i.goods_no]).length
  const fillPct = capacity > 0 ? Math.min(100, (items.length / capacity) * 100) : 0
  const donePct = capacity > 0 ? Math.min(100, (doneCount / capacity) * 100) : 0

  function handleConfirm() {
    setMsg(null)
    startTransition(async () => {
      const res = await confirmWeeklyPlan(weekStart, items)
      setMsg(res.ok ? `✓ ${res.saved}건 배치 저장됨` : `저장 실패: ${res.error}`)
    })
  }

  function handleToggle(goodsNo: string, next: boolean) {
    setDoneMap((m) => ({ ...m, [goodsNo]: next }))
    startTransition(async () => {
      const res = await toggleDone(weekStart, goodsNo, next)
      if (!res.ok) {
        setDoneMap((m) => ({ ...m, [goodsNo]: !next })) // 롤백
        setMsg(`상태 변경 실패: ${res.error}`)
      }
    })
  }

  return (
    <div className="space-y-6">
      {/* 캐파 게이지 */}
      <div className="rounded border border-gray-200 px-4 py-3 space-y-2">
        <div className="flex items-baseline justify-between">
          <span className="text-sm font-semibold text-gray-700">주간 캐파</span>
          <span className="text-sm font-mono text-gray-600">
            선정 {items.length} / {capacity}건 · 완료 {doneCount}건
          </span>
        </div>
        <div className="h-3 w-full rounded-full bg-gray-100 overflow-hidden relative">
          <div className="absolute inset-y-0 left-0 bg-amber-200" style={{ width: `${fillPct}%` }} />
          <div className="absolute inset-y-0 left-0 bg-emerald-500" style={{ width: `${donePct}%` }} />
        </div>
        <div className="flex items-center gap-4 text-[11px] text-gray-500">
          <span className="flex items-center gap-1"><i className="inline-block w-3 h-2 rounded-sm bg-emerald-500" /> 완료</span>
          <span className="flex items-center gap-1"><i className="inline-block w-3 h-2 rounded-sm bg-amber-200" /> 선정(미완)</span>
          <span className="flex items-center gap-1"><i className="inline-block w-3 h-2 rounded-sm bg-gray-100" /> 잔여 캐파</span>
        </div>
      </div>

      {/* 확정 버튼 */}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={handleConfirm}
          disabled={pending || items.length === 0}
          className="px-4 py-2 text-sm rounded bg-black text-white font-semibold disabled:opacity-40 hover:bg-gray-800"
        >
          {pending ? '저장 중…' : hasSaved ? '이번 주 배치 갱신' : '이번 주 배치 확정'}
        </button>
        {msg && <span className="text-xs text-gray-600">{msg}</span>}
      </div>

      {/* 지금(시한성) 그룹 */}
      <PlanGroup
        title="🔥 지금 등록 (시한성)"
        hint="임박특가·활성 TV 편성 — 윈도우 놓치면 가치 소멸"
        items={nowItems}
        doneMap={doneMap}
        onToggle={handleToggle}
        accent="red"
      />

      {/* 이번 주 그룹 */}
      <PlanGroup
        title="🗓 이번 주 등록"
        hint="캐파·카테고리 상한 하 기대가치 greedy 선택"
        items={weekItems}
        doneMap={doneMap}
        onToggle={handleToggle}
        accent="amber"
      />
    </div>
  )
}

function PlanGroup({
  title,
  hint,
  items,
  doneMap,
  onToggle,
  accent,
}: {
  title: string
  hint: string
  items: PlanItem[]
  doneMap: Record<string, boolean>
  onToggle: (goodsNo: string, next: boolean) => void
  accent: 'red' | 'amber'
}) {
  if (items.length === 0) return null
  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-2">
        <h2 className="text-base font-bold">{title}</h2>
        <span className="text-xs text-gray-400">{hint}</span>
        <span className="text-xs text-gray-400">· {items.length}건</span>
      </div>
      <ol className="space-y-2">
        {items.map((it) => {
          const done = !!doneMap[it.goods_no]
          return (
            <li
              key={it.goods_no}
              className={`flex items-start gap-3 rounded border p-3 transition-colors ${
                done
                  ? 'border-emerald-200 bg-emerald-50/50'
                  : accent === 'red'
                    ? 'border-red-200 bg-red-50/40'
                    : 'border-gray-200'
              }`}
            >
              {/* 체크박스 */}
              <label className="flex items-center pt-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={done}
                  onChange={(e) => onToggle(it.goods_no, e.target.checked)}
                  className="w-4 h-4 accent-emerald-600"
                />
              </label>

              {/* 순서 */}
              <div className="w-6 text-center text-sm font-mono text-gray-400 pt-0.5">{it.seq}</div>

              {/* 이미지 */}
              <div className="w-14 h-14 bg-gray-100 rounded overflow-hidden flex-shrink-0">
                {it.image_url && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={it.image_url} alt="" loading="lazy" className="w-full h-full object-cover" />
                )}
              </div>

              {/* 본문 */}
              <div className="flex-1 min-w-0 space-y-1">
                <a
                  href={it.detail_url ?? '#'}
                  target="_blank"
                  rel="noopener"
                  className={`text-sm font-medium leading-snug hover:underline ${done ? 'line-through text-gray-400' : ''}`}
                  title={it.title}
                >
                  {it.title}
                </a>
                <div className="text-xs text-gray-500">
                  {it.cate_label ?? it.cate_cd} · {it.goods_no}
                </div>
                {/* 선정 사유 칩 */}
                <div className="flex flex-wrap gap-1 pt-0.5">
                  {it.reasons.map((rsn, idx) => (
                    <span
                      key={idx}
                      className="bg-gray-100 text-gray-700 text-[11px] px-1.5 py-0.5 rounded"
                    >
                      {rsn}
                    </span>
                  ))}
                </div>
              </div>

              {/* 가격/마진 */}
              <div className="text-right flex-shrink-0">
                <div className="text-sm font-bold">
                  {it.price_krw ? `${it.price_krw.toLocaleString()}원` : <span className="text-gray-400 text-xs">가격 X</span>}
                </div>
                <div className="text-xs font-mono text-emerald-700">
                  +{it.expected_margin.toLocaleString()}
                </div>
                <div className="text-[10px] text-gray-400 font-mono">가치 {it.plan_value.toFixed(1)}</div>
              </div>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
