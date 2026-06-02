import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import IntentMomentumBoard, { type MomentumRow } from './IntentMomentumBoard'

export const dynamic = 'force-dynamic'

interface RpcRow {
  product_id: string
  canonical_name: string | null
  category_top: string | null
  category_mid: string | null
  txn_share_7d: number | null
  txn_share_prev: number | null
  base_share: number | null
  velocity: number | null
  signals_7d: number | null
  signals_total: number | null
  mix_informational: number | null
  mix_commercial: number | null
  mix_transactional: number | null
  mix_navigational: number | null
  has_ggsan: boolean | null
}

async function fetchData(): Promise<{ rows: MomentumRow[]; error: string | null }> {
  const sb = createAdminClient()

  // RPC는 DB(supabase/trends_v5_intent_momentum.sql)에 존재하나 generated 타입 미반영
  //  — `npm run gen:types` 시 캐스팅 제거
  const { data, error } = await sb.rpc('jimscanner_intent_momentum' as never, {
    p_min_signals: 3,
  } as never)

  if (error) return { rows: [], error: error.message }

  const rows: MomentumRow[] = ((data ?? []) as RpcRow[]).map((r) => ({
    id: r.product_id,
    name: r.canonical_name ?? '?',
    category: r.category_top ?? 'all',
    categoryMid: r.category_mid ?? null,
    txnShare: Number(r.txn_share_7d ?? 0),
    txnSharePrev: Number(r.txn_share_prev ?? 0),
    baseShare: Number(r.base_share ?? 0),
    velocity: Number(r.velocity ?? 0),
    signals7d: Number(r.signals_7d ?? 0),
    signalsTotal: Number(r.signals_total ?? 0),
    mix: {
      informational: Number(r.mix_informational ?? 0),
      commercial: Number(r.mix_commercial ?? 0),
      transactional: Number(r.mix_transactional ?? 0),
      navigational: Number(r.mix_navigational ?? 0),
    },
    hasGgsan: !!r.has_ggsan,
  }))

  return { rows, error: null }
}

export default async function IntentMomentumPage() {
  const { rows, error } = await fetchData()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">구매의도 전환 모멘텀</h1>
          <p className="text-sm text-gray-500 mt-1">
            X = 거래의도 비중(transactional+commercial, 최근 7d) · Y = 전환가속도(최근 7d − 직전 7d, %p) ·
            우상단 = 정보→거래 변곡점 통과 중
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {error ? (
        <div className="rounded border border-dashed border-amber-300 bg-amber-50 p-8 text-sm text-amber-800">
          RPC <code>jimscanner_intent_momentum</code> 호출 실패. DB에 적용 안 됐을 가능성:
          <br />
          <code>supabase/trends_v5_intent_momentum.sql</code> 적용 필요.
          <div className="mt-2 font-mono text-xs text-amber-600">{error}</div>
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 의도 시계열 데이터 부족. classify-trends-llm 누적 후 다시 방문.
        </div>
      ) : (
        <IntentMomentumBoard rows={rows} />
      )}
    </div>
  )
}
