import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface CohortRow {
  product_id: string
  canonical_name: string
  category_top: string
  brand: string | null
  pinned_at: string
  age_days: number
  bucket: '0-7d' | '7-30d' | '30d+'
  score_then: number | null
  score_now: number | null
  delta_total: number | null
  delta_components: {
    trend?: number
    commerce?: number
    supplier?: number
    competition?: number
  } | null
  recommended_action: 'revive' | 'hold' | 'drop'
  current_action: string | null
  hold_until: string | null
}

const BUCKETS: Array<{ key: '0-7d' | '7-30d' | '30d+'; label: string; desc: string }> = [
  { key: '0-7d', label: '0-7일', desc: '신선 — 점수 변동 대기' },
  { key: '7-30d', label: '7-30일', desc: '의사결정 적정 구간' },
  { key: '30d+', label: '30일+', desc: '사일런트 적체 위험' },
]

const ACTION_META: Record<'revive' | 'hold' | 'drop', { label: string; cls: string; emoji: string }> = {
  revive: { label: '소생', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', emoji: '↑' },
  hold: { label: '대기', cls: 'bg-amber-50 text-amber-700 border-amber-200', emoji: '→' },
  drop: { label: '폐기', cls: 'bg-rose-50 text-rose-700 border-rose-200', emoji: '↓' },
}

async function fetchCohort(): Promise<{ rows: CohortRow[]; error: string | null }> {
  const sb = createAdminClient()
  // RPC 는 supabase/trends_v4_pin_aging.sql 에 정의. generated 타입 미반영 — 적용 후 `npm run gen:types` 시 캐스팅 제거.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (sb as any).rpc('jimscanner_pin_aging_cohort')
  if (error) return { rows: [], error: error.message }
  return { rows: (data ?? []) as CohortRow[], error: null }
}

function DeltaBar({ value, label }: { value: number; label: string }) {
  const clamped = Math.max(-30, Math.min(30, value))
  const pct = (Math.abs(clamped) / 30) * 100
  const isPos = clamped >= 0
  return (
    <div className="flex items-center gap-1.5 text-[10px]">
      <div className="w-12 text-gray-500 tabular-nums">{label}</div>
      <div className="relative flex-1 h-2 bg-gray-100 rounded overflow-hidden flex">
        <div className="flex-1 flex justify-end">
          {!isPos && (
            <div
              className="h-full bg-rose-400"
              style={{ width: `${pct}%` }}
            />
          )}
        </div>
        <div className="w-px h-full bg-gray-300" />
        <div className="flex-1">
          {isPos && (
            <div
              className="h-full bg-emerald-400"
              style={{ width: `${pct}%` }}
            />
          )}
        </div>
      </div>
      <div className={`w-10 text-right tabular-nums ${isPos ? 'text-emerald-700' : 'text-rose-700'}`}>
        {isPos ? '+' : ''}
        {value.toFixed(1)}
      </div>
    </div>
  )
}

function ScoreCompare({ then, now }: { then: number | null; now: number | null }) {
  const t = then ?? 0
  const n = now ?? 0
  const delta = n - t
  const up = delta > 0
  return (
    <div className="flex items-center gap-3 text-sm">
      <div className="text-right">
        <div className="text-[10px] text-gray-400 uppercase tracking-wide">핀시점</div>
        <div className="font-mono font-semibold text-gray-600">{then == null ? '—' : t.toFixed(1)}</div>
      </div>
      <div className={`text-lg ${up ? 'text-emerald-600' : delta < 0 ? 'text-rose-600' : 'text-gray-400'}`}>
        {up ? '→↑' : delta < 0 ? '→↓' : '→'}
      </div>
      <div>
        <div className="text-[10px] text-gray-400 uppercase tracking-wide">최신</div>
        <div className="font-mono font-semibold text-black">{now == null ? '—' : n.toFixed(1)}</div>
      </div>
    </div>
  )
}

function RowCard({ row }: { row: CohortRow }) {
  const action = ACTION_META[row.recommended_action]
  const dc = row.delta_components ?? {}
  return (
    <div className="rounded border border-gray-200 bg-white p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className={`inline-block px-2 py-0.5 text-[10px] rounded border ${action.cls}`}>
              {action.emoji} 추천: {action.label}
            </span>
            <span className="text-[10px] text-gray-400">
              {row.category_top}
              {row.brand ? ` · ${row.brand}` : ''}
            </span>
            {row.current_action && (
              <span className="text-[10px] text-gray-500 bg-gray-100 px-1.5 rounded">
                현재: {row.current_action}
              </span>
            )}
          </div>
          <div className="font-semibold text-sm truncate">{row.canonical_name}</div>
          <div className="text-[11px] text-gray-500 mt-0.5">
            핀: {row.pinned_at?.slice(0, 10)} · 경과 {row.age_days}일
          </div>
        </div>
        <ScoreCompare then={row.score_then} now={row.score_now} />
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 pt-2 border-t border-gray-100">
        <DeltaBar label="트렌드" value={Number(dc.trend ?? 0)} />
        <DeltaBar label="커머스" value={Number(dc.commerce ?? 0)} />
        <DeltaBar label="공급" value={Number(dc.supplier ?? 0)} />
        <DeltaBar label="경쟁" value={Number(dc.competition ?? 0)} />
      </div>

      <form
        action="/api/admin/trends/pin-aging/action"
        method="POST"
        className="flex items-center justify-end gap-2 pt-1"
      >
        <input type="hidden" name="product_id" value={row.product_id} />
        <button
          type="submit"
          name="action"
          value="revive"
          className="text-[11px] px-2 py-1 rounded border border-emerald-300 text-emerald-700 hover:bg-emerald-50"
        >
          소생 → 발행 후보
        </button>
        <button
          type="submit"
          name="action"
          value="hold"
          className="text-[11px] px-2 py-1 rounded border border-amber-300 text-amber-700 hover:bg-amber-50"
        >
          유지 (D+7 리마인더)
        </button>
        <button
          type="submit"
          name="action"
          value="drop"
          className="text-[11px] px-2 py-1 rounded border border-rose-300 text-rose-700 hover:bg-rose-50"
        >
          폐기 (unpin)
        </button>
      </form>
    </div>
  )
}

function BucketColumn({
  rows,
  bucket,
  label,
  desc,
}: {
  rows: CohortRow[]
  bucket: '0-7d' | '7-30d' | '30d+'
  label: string
  desc: string
}) {
  const items = rows.filter((r) => r.bucket === bucket)
  const counts = {
    revive: items.filter((r) => r.recommended_action === 'revive').length,
    hold: items.filter((r) => r.recommended_action === 'hold').length,
    drop: items.filter((r) => r.recommended_action === 'drop').length,
  }
  return (
    <div className="flex-1 min-w-0 space-y-3">
      <div className="sticky top-0 bg-white/95 backdrop-blur z-10 pb-2 border-b border-gray-200">
        <div className="flex items-baseline justify-between">
          <h2 className="text-base font-semibold">
            {label} <span className="text-gray-400 font-normal">({items.length})</span>
          </h2>
        </div>
        <div className="flex gap-2 mt-1 text-[10px]">
          <span className="text-emerald-700">↑ {counts.revive}</span>
          <span className="text-amber-700">→ {counts.hold}</span>
          <span className="text-rose-700">↓ {counts.drop}</span>
        </div>
        <p className="text-[11px] text-gray-400 mt-0.5">{desc}</p>
      </div>
      <div className="space-y-2">
        {items.length === 0 ? (
          <div className="text-xs text-gray-400 italic py-4 text-center border border-dashed border-gray-200 rounded">
            대기 없음
          </div>
        ) : (
          items.map((r) => <RowCard key={r.product_id} row={r} />)
        )}
      </div>
    </div>
  )
}

export default async function PinAgingPage() {
  const { rows, error } = await fetchCohort()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">핀 에이징 코호트</h1>
          <p className="text-sm text-gray-500 mt-1">
            핀 시점 vs 최신 final_score 델타로 자동 분기 — Revive (Δ≥+10) / Hold (±10) / Drop (Δ≤-10).
            사일런트 적체 큐를 시각화합니다.
          </p>
        </div>
        <Link
          href="/admin/trend-radar/pins"
          className="text-sm text-gray-700 hover:text-black underline"
        >
          ← 핀 목록
        </Link>
      </header>

      {error && (
        <div className="rounded border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          RPC 호출 실패: {error}
          <div className="text-[11px] mt-1 text-rose-500">
            마이그레이션 적용 필요: <code>supabase/trends_v4_pin_aging.sql</code>
          </div>
        </div>
      )}

      {rows.length === 0 && !error ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">핀된 상품 없음</p>
          <p className="text-sm mt-2">
            jimscanner_trends_products.pinned = true 인 row 가 없습니다.
          </p>
        </div>
      ) : (
        <div className="flex gap-4 items-start">
          {BUCKETS.map((b) => (
            <BucketColumn
              key={b.key}
              rows={rows}
              bucket={b.key}
              label={b.label}
              desc={b.desc}
            />
          ))}
        </div>
      )}
    </div>
  )
}
