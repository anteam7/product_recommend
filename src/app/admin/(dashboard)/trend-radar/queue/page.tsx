import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// classify-trends-llm.mjs 와 동기화된 상수 (배치/캡)
const BATCH_SIZE = 20
const DAILY_REQ_HARD_CAP = 800

interface PriorityRow {
  id: string
  canonical_name: string
  category_top: string
  category_mid: string | null
  alias_count: number
  source_count: number
  confidence_sum: number
  last_seen_at: string
  recency_days: number
  priority_score: number
}

interface QueueData {
  rows: PriorityRow[]
  totalUnclassified: number
  totalProducts: number
  todayReq: number
  todayProducts: number
  capRemaining: number
  rpcOk: boolean
}

async function fetchQueue(): Promise<QueueData> {
  const sb = createAdminClient()

  // 1) 우선순위 큐 (LLM 없이 산출하는 priority_score desc)
  // RPC 가 generated 타입에 없으므로 캐스팅 (마이그레이션 적용 후 상태 가정)
  const { data: rpcData, error: rpcError } = await (sb.rpc as any)(
    'jimscanner_classify_priority',
    { result_limit: 500 },
  )
  const rows = (rpcError ? [] : ((rpcData ?? []) as PriorityRow[]))

  // 2) KPI — 전체 / 미분류 카운트
  const totalProducts =
    (await sb.from('jimscanner_trends_products').select('*', { count: 'exact', head: true })).count ?? 0
  const totalUnclassified =
    (await sb
      .from('jimscanner_trends_products')
      .select('*', { count: 'exact', head: true })
      .is('llm_classified_at', null)).count ?? 0

  // 3) 오늘 LLM 호출 카운터 (일일 cap 잔량)
  const today = new Date().toISOString().slice(0, 10)
  const { data: counter } = await sb
    .from('jimscanner_trends_llm_calls')
    .select('request_count, product_count')
    .eq('day', today)
    .maybeSingle()
  const todayReq = counter?.request_count ?? 0
  const todayProducts = counter?.product_count ?? 0

  return {
    rows,
    totalUnclassified,
    totalProducts,
    todayReq,
    todayProducts,
    capRemaining: Math.max(0, DAILY_REQ_HARD_CAP - todayReq),
    rpcOk: !rpcError,
  }
}

function formatAge(iso: string): string {
  if (!iso) return '—'
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (min < 60) return `${min}m 전`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h 전`
  return `${Math.floor(h / 24)}d 전`
}

const CAT_LABEL: Record<string, string> = {
  health: '건강',
  living: '리빙',
  digital: '디지털',
  other: '기타',
}

export default async function ClassifyQueuePage() {
  const data = await fetchQueue()

  // 이번 실행에서 처리 가능한 배치 수 = min(cap잔량, MAX_REQ_PER_RUN 60) — 표시는 cap잔량 기준 예상순번
  // 예상순번(배치) = ceil(rank / BATCH_SIZE)
  const classifiedPct =
    data.totalProducts > 0
      ? Math.round(((data.totalProducts - data.totalUnclassified) / data.totalProducts) * 100)
      : 0

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">분류 대기열 (LLM 예산 라우터)</h1>
          <p className="text-sm text-gray-500 mt-1">
            미분류 백로그를 신호강도(사전 잠재력 점수)순으로 정렬 — LLM 호출 순서를 winner 우선으로 라우팅
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard
          label="미분류 백로그"
          value={data.totalUnclassified}
          hint={`전체 ${data.totalProducts}개 중 (${classifiedPct}% 분류 완료)`}
        />
        <KpiCard label="오늘 LLM 요청" value={data.todayReq} hint={`${data.todayProducts}개 상품 분류됨`} />
        <KpiCard
          label="일일 cap 잔량"
          value={data.capRemaining}
          hint={`${DAILY_REQ_HARD_CAP} req/day 한도`}
        />
        <KpiCard
          label="처리 가능 상품"
          value={data.capRemaining * BATCH_SIZE}
          hint={`잔량 × 배치 ${BATCH_SIZE}`}
        />
      </section>

      {!data.rpcOk && (
        <div className="rounded border border-yellow-300 bg-yellow-50 px-4 py-3 text-sm text-yellow-800">
          ⚠ <code>jimscanner_classify_priority</code> RPC 가 아직 DB 에 적용되지 않았습니다. 마이그레이션{' '}
          <code>supabase/trends_classify_priority_rpc.sql</code> 실행 후 큐가 채워집니다.
        </div>
      )}

      <div className="rounded border border-dashed border-gray-300 p-3 text-xs text-gray-500">
        <strong className="text-gray-700">점수 공식</strong> (LLM 없이 산출):{' '}
        alias 수 ×2 + 교차출처 ×6 + 최근성(30일 선형감쇠) + confidence합 ×3. classify-trends-llm.mjs 가 이 순서대로
        배치(20개씩)를 처리하므로 <strong>예상순번</strong> = ⌈순위 / {BATCH_SIZE}⌉ 번째 배치에서 호출됩니다.
      </div>

      {/* 큐 테이블 */}
      <section className="rounded border border-gray-200 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-gray-500 text-xs">
            <tr>
              <th className="px-3 py-2 text-left">#</th>
              <th className="px-3 py-2 text-left">상품명</th>
              <th className="px-3 py-2 text-left">카테고리</th>
              <th className="px-3 py-2 text-right">점수</th>
              <th className="px-3 py-2 text-right">alias</th>
              <th className="px-3 py-2 text-right">출처수</th>
              <th className="px-3 py-2 text-right">마지막관측</th>
              <th className="px-3 py-2 text-right">예상순번</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {data.rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-3 py-10 text-center text-gray-400">
                  미분류 대기 상품이 없습니다 (또는 RPC 미적용).
                </td>
              </tr>
            ) : (
              data.rows.map((r, i) => {
                const batch = Math.floor(i / BATCH_SIZE) + 1
                // cap 잔량으로 이번 실행에서 도달 가능한지
                const reachable = batch <= data.capRemaining
                return (
                  <tr key={r.id} className={reachable ? '' : 'opacity-60'}>
                    <td className="px-3 py-1.5 font-mono text-gray-400">{i + 1}</td>
                    <td className="px-3 py-1.5">
                      <Link
                        href={`/admin/trend-radar/products/${r.id}`}
                        className="font-medium hover:underline"
                      >
                        {r.canonical_name}
                      </Link>
                      {r.category_mid && (
                        <span className="ml-2 text-xs text-gray-400">{r.category_mid}</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-xs text-gray-500">
                      {CAT_LABEL[r.category_top] ?? r.category_top}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono font-bold">
                      {Number(r.priority_score).toFixed(1)}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-gray-600">{r.alias_count}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-gray-600">{r.source_count}</td>
                    <td className="px-3 py-1.5 text-right text-xs text-gray-500">
                      {formatAge(r.last_seen_at)}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <span
                        className={`inline-block rounded px-1.5 py-0.5 text-xs font-mono ${
                          reachable ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-400'
                        }`}
                      >
                        배치 {batch}
                      </span>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </section>
    </div>
  )
}

function KpiCard({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-3xl font-bold mt-1">{value.toLocaleString()}</div>
      <div className="text-xs text-gray-400 mt-1">{hint}</div>
    </div>
  )
}
