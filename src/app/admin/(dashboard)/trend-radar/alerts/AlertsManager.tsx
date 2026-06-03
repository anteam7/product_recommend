'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export interface AlertRuleRow {
  id: string
  name: string
  description: string | null
  condition: Record<string, unknown>
  category_top: string | null
  channel: string
  enabled: boolean
  fired_count: number
  hit_count: number
  created_at: string
}

export interface AlertFeedRow {
  id: string
  rule_id: string
  product_id: string
  product_name: string | null
  category_top: string | null
  trigger_value: number | null
  message: string
  channel: string
  delivered: boolean
  feedback: string | null
  fired_at: string
}

const CONDITION_PRESETS: { label: string; json: string }[] = [
  { label: '급상승 Δ>15', json: '{"type":"score_delta","metric":"final_score","op":">","threshold":15}' },
  { label: '80 상향돌파', json: '{"type":"threshold_cross","metric":"final_score","threshold":80}' },
  { label: '신규 공급원 마진', json: '{"type":"new_supplier_margin","min_margin_krw":3000}' },
  { label: '브레이크아웃', json: '{"type":"rank_velocity","metric":"final_score","threshold":20}' },
  { label: '콜드스타트 신규', json: '{"type":"cold_start_token","min_final_score":50}' },
]

function hitRate(r: AlertRuleRow): string {
  if (r.fired_count === 0) return '—'
  return `${Math.round((r.hit_count / r.fired_count) * 100)}%`
}

export default function AlertsManager({
  initialRules,
  initialAlerts,
}: {
  initialRules: AlertRuleRow[]
  initialAlerts: AlertFeedRow[]
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // 새 룰 폼
  const [name, setName] = useState('')
  const [channel, setChannel] = useState<'digest' | 'instant'>('digest')
  const [category, setCategory] = useState('')
  const [condition, setCondition] = useState(CONDITION_PRESETS[0].json)

  async function call(method: string, url: string, body?: unknown) {
    setBusy(true)
    setErr(null)
    try {
      const res = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error ?? `${res.status}`)
      }
      router.refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function createRule() {
    if (!name.trim()) {
      setErr('룰 이름을 입력하세요')
      return
    }
    await call('POST', '/api/admin/trend-alerts', {
      name: name.trim(),
      channel,
      category_top: category.trim() || null,
      condition,
    })
    setName('')
  }

  return (
    <div className="space-y-8">
      {err && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-700">{err}</div>
      )}

      {/* 룰 생성 */}
      <section className="rounded border border-gray-200 p-4 space-y-3">
        <h2 className="text-sm font-semibold text-gray-700">새 룰</h2>
        <div className="grid grid-cols-1 md:grid-cols-12 gap-2 items-start">
          <input
            className="md:col-span-3 rounded border border-gray-300 px-2 py-1.5 text-sm"
            placeholder="룰 이름"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <select
            className="md:col-span-2 rounded border border-gray-300 px-2 py-1.5 text-sm"
            value={channel}
            onChange={(e) => setChannel(e.target.value as 'digest' | 'instant')}
          >
            <option value="digest">digest (1일 1회)</option>
            <option value="instant">instant (즉시)</option>
          </select>
          <input
            className="md:col-span-2 rounded border border-gray-300 px-2 py-1.5 text-sm"
            placeholder="category (선택)"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          />
          <div className="md:col-span-5 flex gap-1 flex-wrap">
            {CONDITION_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => setCondition(p.json)}
                className="text-xs px-2 py-1 rounded border border-gray-200 text-gray-600 hover:bg-gray-50"
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <textarea
          className="w-full rounded border border-gray-300 px-2 py-1.5 text-xs font-mono"
          rows={2}
          value={condition}
          onChange={(e) => setCondition(e.target.value)}
        />
        <button
          type="button"
          disabled={busy}
          onClick={createRule}
          className="rounded bg-gray-900 text-white px-4 py-1.5 text-sm disabled:opacity-50"
        >
          룰 추가
        </button>
      </section>

      {/* 룰 목록 + 적중률 */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-2">룰 ({initialRules.length})</h2>
        <div className="rounded border border-gray-200 divide-y divide-gray-200">
          {initialRules.length === 0 && (
            <div className="px-3 py-6 text-center text-sm text-gray-400">룰 없음 — 위에서 추가</div>
          )}
          {initialRules.map((r) => (
            <div key={r.id} className="grid grid-cols-12 px-3 py-2 items-center text-sm gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => call('PATCH', '/api/admin/trend-alerts', { id: r.id, enabled: !r.enabled })}
                className={`col-span-1 text-lg ${r.enabled ? 'text-green-600' : 'text-gray-300'}`}
                title="활성/비활성 토글"
              >
                {r.enabled ? '●' : '○'}
              </button>
              <div className="col-span-4">
                <div className="font-medium">{r.name}</div>
                <div className="text-xs text-gray-400 font-mono truncate">
                  {JSON.stringify(r.condition)}
                </div>
              </div>
              <div className="col-span-2 text-xs text-gray-500">
                {r.channel}
                {r.category_top ? ` · ${r.category_top}` : ''}
              </div>
              <div className="col-span-2 text-right text-xs text-gray-500">
                발화 {r.fired_count} · 적중 {r.hit_count}
              </div>
              <div className="col-span-2 text-right text-sm font-medium">{hitRate(r)}</div>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (confirm(`'${r.name}' 룰 삭제?`))
                    call('DELETE', `/api/admin/trend-alerts?id=${r.id}`)
                }}
                className="col-span-1 text-right text-xs text-red-500 hover:underline"
              >
                삭제
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* 발화 피드 */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-2">
          발화 피드 (최근 {initialAlerts.length})
        </h2>
        <div className="rounded border border-gray-200 divide-y divide-gray-100">
          {initialAlerts.length === 0 && (
            <div className="px-3 py-6 text-center text-sm text-gray-400">
              발화 없음 — cron 누적 후 다시 방문
            </div>
          )}
          {initialAlerts.map((a) => (
            <div key={a.id} className="grid grid-cols-12 px-3 py-2 items-center text-sm gap-2">
              <div className="col-span-1 text-xs text-gray-400 font-mono">
                {a.fired_at.slice(5, 16)}
              </div>
              <div className="col-span-4">
                <div className="font-medium truncate">{a.product_name ?? a.product_id.slice(0, 8)}</div>
                <div className="text-xs text-gray-500">{a.message}</div>
              </div>
              <div className="col-span-2 text-xs text-gray-500">
                {a.channel}
                {a.delivered ? ' · ✓전송' : ' · 대기'}
              </div>
              <div className="col-span-2 text-xs text-gray-400">{a.category_top ?? '—'}</div>
              <div className="col-span-3 flex gap-1 justify-end">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    call('POST', '/api/admin/trend-alerts/feedback', {
                      alert_id: a.id,
                      feedback: a.feedback === 'hit' ? null : 'hit',
                    })
                  }
                  className={`text-xs px-2 py-1 rounded border ${
                    a.feedback === 'hit'
                      ? 'bg-green-600 text-white border-green-600'
                      : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  적중
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    call('POST', '/api/admin/trend-alerts/feedback', {
                      alert_id: a.id,
                      feedback: a.feedback === 'noise' ? null : 'noise',
                    })
                  }
                  className={`text-xs px-2 py-1 rounded border ${
                    a.feedback === 'noise'
                      ? 'bg-gray-600 text-white border-gray-600'
                      : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  노이즈
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
