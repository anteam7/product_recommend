import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// classify-trends-llm.mjs 와 동기화 (희소 자원 한도)
const BATCH_SIZE = 20
const DAILY_REQ_HARD_CAP = 800

interface TriageRow {
  product_id: string
  canonical_name: string
  category_top: string | null
  alias_count: number
  source_count: number
  age_days: number
  days_since_last: number
  recency_slope: number
  commerce_hits: number
  ev_score: number
}

interface CounterRow {
  request_count: number
  product_count: number
  input_token_count: number
  output_token_count: number
  last_call_at: string | null
}

const CATEGORY_LABEL: Record<string, string> = {
  health: '건강식품',
  living: '생활/리빙',
  digital: '디지털/가전',
  other: '기타',
}

async function fetchData() {
  const sb = createAdminClient()
  const today = new Date().toISOString().slice(0, 10)

  // 1) 오늘 LLM 호출 카운터 (번다운)
  const { data: counterRaw } = await sb
    .from('jimscanner_trends_llm_calls')
    .select('request_count, product_count, input_token_count, output_token_count, last_call_at')
    .eq('day', today)
    .maybeSingle()
  const counter: CounterRow = (counterRaw as CounterRow | null) ?? {
    request_count: 0,
    product_count: 0,
    input_token_count: 0,
    output_token_count: 0,
    last_call_at: null,
  }

  // 2) EV 트리아지 큐 (RPC) — 미배포 시 빈 큐
  // 타입 미생성 RPC 이므로 캐스팅으로 우회 (마이그레이션 후 상태 가정).
  const { data: queueRaw, error } = await (sb as any).rpc('jimscanner_classification_triage', {
    p_limit: 300,
  })
  const queue: TriageRow[] = Array.isArray(queueRaw) ? (queueRaw as TriageRow[]) : []
  const rpcError = error ? (error.message as string) : null

  return { counter, queue, rpcError }
}

export default async function TriagePage() {
  const { counter, queue, rpcError } = await fetchData()

  // 오늘 남은 요청 예산 → 처리 가능한 product 수 (capacity)
  const reqRemaining = Math.max(0, DAILY_REQ_HARD_CAP - counter.request_count)
  const capacityProducts = reqRemaining * BATCH_SIZE
  const reqUsedPct = Math.min(100, Math.round((counter.request_count / DAILY_REQ_HARD_CAP) * 100))

  // 큐를 EV 순으로 capacity 기준 분할 → at-risk(예산 소진 미분류)
  const willProcess = queue.slice(0, capacityProducts)
  const atRisk = queue.slice(capacityProducts)
  const totalTokens = counter.input_token_count + counter.output_token_count

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">분류 예산 트리아지</h1>
          <p className="text-sm text-gray-500 mt-1">
            희소한 LLM 토큰 예산을 기대가치(EV)순으로 배분 · EV = 교차소스 × 최근 기울기 × 커머스 어휘
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 번다운 게이지 */}
      <section className="rounded border border-gray-200 p-4 space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-gray-700">오늘 LLM 요청 번다운</h2>
          <span className="text-xs text-gray-400">
            {counter.last_call_at
              ? `마지막 호출 ${new Date(counter.last_call_at).toLocaleString('ko-KR')}`
              : '오늘 호출 없음'}
          </span>
        </div>
        <div className="h-4 w-full rounded bg-gray-100 overflow-hidden">
          <div
            className={`h-full ${reqUsedPct >= 90 ? 'bg-red-500' : reqUsedPct >= 60 ? 'bg-amber-500' : 'bg-emerald-500'}`}
            style={{ width: `${reqUsedPct}%` }}
          />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-1">
          <Stat label="사용 요청" value={`${counter.request_count} / ${DAILY_REQ_HARD_CAP}`} hint={`${reqUsedPct}% 소진`} />
          <Stat label="남은 처리 용량" value={capacityProducts.toLocaleString()} hint="개 상품 (남은 요청 × 배치)" />
          <Stat label="오늘 분류" value={counter.product_count.toLocaleString()} hint="개 상품" />
          <Stat label="토큰 사용" value={totalTokens.toLocaleString()} hint={`in ${counter.input_token_count.toLocaleString()} / out ${counter.output_token_count.toLocaleString()}`} />
        </div>
      </section>

      {rpcError && (
        <div className="rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800">
          트리아지 RPC <code className="px-1 bg-amber-100 rounded">jimscanner_classification_triage</code> 가
          아직 DB 에 배포되지 않았습니다. <code className="px-1 bg-amber-100 rounded">supabase/classification_triage.sql</code> 적용 후
          큐가 표시됩니다. ({rpcError})
        </div>
      )}

      {/* 기회비용 카드 */}
      {atRisk.length > 0 && (
        <section className="rounded border border-red-200 bg-red-50 p-4 space-y-3">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold text-red-700">예산 소진으로 미분류될 상위 신호 (기회비용)</h2>
            <span className="text-xs text-red-500">{atRisk.length}건이 오늘 용량 밖</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {atRisk.slice(0, 12).map((r) => (
              <span
                key={r.product_id}
                className="text-xs px-2 py-1 rounded bg-white border border-red-200 text-red-700"
                title={`EV=${r.ev_score} · 소스 ${r.source_count} · 커머스 ${r.commerce_hits} · 기울기 ${r.recency_slope}`}
              >
                {r.canonical_name} · EV {r.ev_score}
              </span>
            ))}
          </div>
        </section>
      )}

      {/* 분류 대기 큐 */}
      {queue.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          분류 대기 신호가 없습니다 (모두 분류됨 또는 RPC 미배포).
        </div>
      ) : (
        <section className="space-y-2">
          <div className="grid grid-cols-12 text-xs text-gray-500 px-3 py-1">
            <div className="col-span-1">#</div>
            <div className="col-span-4">상품 후보</div>
            <div className="col-span-1 text-right">EV</div>
            <div className="col-span-1 text-right">소스</div>
            <div className="col-span-1 text-right">alias</div>
            <div className="col-span-1 text-right">커머스</div>
            <div className="col-span-1 text-right">기울기</div>
            <div className="col-span-2 text-right">상태</div>
          </div>
          {queue.slice(0, 200).map((r, i) => {
            const safe = i < willProcess.length
            return (
              <div
                key={r.product_id}
                className={`grid grid-cols-12 px-3 py-2 rounded border text-sm ${
                  safe ? 'border-gray-200 hover:bg-gray-50' : 'border-red-100 bg-red-50/40'
                }`}
              >
                <div className="col-span-1 font-mono text-gray-400">{i + 1}</div>
                <div className="col-span-4">
                  <Link
                    href={`/admin/trend-radar/products/${r.product_id}`}
                    className="font-medium hover:underline"
                  >
                    {r.canonical_name}
                  </Link>
                  <div className="text-xs text-gray-500">
                    {CATEGORY_LABEL[r.category_top ?? ''] ?? r.category_top ?? '—'} · 최근 {r.days_since_last}일 전
                  </div>
                </div>
                <div className="col-span-1 text-right font-mono font-bold">{r.ev_score}</div>
                <div className="col-span-1 text-right font-mono text-gray-600">{r.source_count}</div>
                <div className="col-span-1 text-right font-mono text-gray-600">{r.alias_count}</div>
                <div className="col-span-1 text-right font-mono text-gray-600">{r.commerce_hits}</div>
                <div className="col-span-1 text-right font-mono text-gray-600">{r.recency_slope}</div>
                <div className="col-span-2 text-right">
                  {safe ? (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">예산 내</span>
                  ) : (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-red-100 text-red-700">예산 밖</span>
                  )}
                </div>
              </div>
            )
          })}
        </section>
      )}
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div>
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-xl font-bold mt-0.5">{value}</div>
      <div className="text-xs text-gray-400 mt-0.5">{hint}</div>
    </div>
  )
}
