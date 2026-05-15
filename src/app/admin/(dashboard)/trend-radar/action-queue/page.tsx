import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import ActionCardControls from './ActionCardControls'
import GenerateButton from './GenerateButton'

export const dynamic = 'force-dynamic'

const ACTION_LABEL: Record<string, string> = {
  register: '신규 등록',
  reprice: '리프라이스',
  restock: '리스톡',
  derecord: '디레코드',
}

const ACTION_COLOR: Record<string, string> = {
  register: 'bg-emerald-50 border-emerald-200 text-emerald-800',
  reprice: 'bg-amber-50 border-amber-200 text-amber-800',
  restock: 'bg-sky-50 border-sky-200 text-sky-800',
  derecord: 'bg-rose-50 border-rose-200 text-rose-800',
}

interface QueueRow {
  id: string
  product_id: string
  action_type: string
  trigger_signal: any
  trigger_rule: string | null
  status: string
  priority_score: number
  decision_note: string | null
  snoozed_until: string | null
  created_at: string
  processed_at: string | null
}
interface ProductRow {
  id: string
  canonical_name: string
  category_top: string
}

async function fetchData() {
  const sb = createAdminClient() as any

  const { data: queue } = await sb
    .from('jimscanner_trends_action_queue')
    .select(
      'id, product_id, action_type, trigger_signal, trigger_rule, status, priority_score, decision_note, snoozed_until, created_at, processed_at',
    )
    .order('priority_score', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(500)

  const rows = (queue ?? []) as QueueRow[]
  const productIds = [...new Set(rows.map((r) => r.product_id))]

  let products: ProductRow[] = []
  if (productIds.length > 0) {
    const { data } = await sb
      .from('jimscanner_trends_products')
      .select('id, canonical_name, category_top')
      .in('id', productIds)
    products = (data ?? []) as ProductRow[]
  }
  const productMap = new Map(products.map((p) => [p.id, p]))

  // KPI funnel: 최근 30일 생성/완료/스킵 + 평균 lead-time
  const since = new Date(Date.now() - 30 * 86400_000).toISOString()
  const { data: recent } = await sb
    .from('jimscanner_trends_action_queue')
    .select('status, created_at, processed_at')
    .gte('created_at', since)
    .limit(5000)
  const recentRows = (recent ?? []) as Array<{ status: string; created_at: string; processed_at: string | null }>

  const created30d = recentRows.length
  const done30d = recentRows.filter((r) => r.status === 'done').length
  const skipped30d = recentRows.filter((r) => r.status === 'skipped').length
  const skipRatio = created30d > 0 ? Math.round((skipped30d / created30d) * 100) : 0

  const leadTimes: number[] = recentRows
    .filter((r) => r.status === 'done' && r.processed_at)
    .map((r) => {
      const c = new Date(r.created_at).getTime()
      const p = new Date(r.processed_at as string).getTime()
      return (p - c) / 3600_000
    })
  const avgLeadHours =
    leadTimes.length > 0 ? Math.round(leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length) : 0

  return {
    rows,
    productMap,
    kpis: { created30d, done30d, skipped30d, skipRatio, avgLeadHours, newCount: rows.filter((r) => r.status === 'new').length },
  }
}

export default async function ActionQueuePage() {
  const { rows, productMap, kpis } = await fetchData()

  const byStatus = {
    new: rows.filter((r) => r.status === 'new'),
    snoozed: rows.filter((r) => r.status === 'snoozed'),
    done: rows.filter((r) => r.status === 'done').slice(0, 50),
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">오늘의 액션 큐</h1>
          <p className="text-sm text-gray-500 mt-1">
            시그널 → 운영자 To-Do 카드. 등록·리프라이스·디레코드 결정을 한 곳에서.
          </p>
        </div>
        <div className="flex gap-2 items-center">
          <GenerateButton />
          <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
            ← 대시보드
          </Link>
        </div>
      </header>

      {/* Funnel KPI */}
      <section className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <KpiCard label="미처리 (new)" value={kpis.newCount} hint="현재 큐" />
        <KpiCard label="30일 생성" value={kpis.created30d} hint="트리거 발화" />
        <KpiCard label="30일 완료" value={kpis.done30d} hint={`${kpis.created30d > 0 ? Math.round((kpis.done30d / kpis.created30d) * 100) : 0}% 완료율`} />
        <KpiCard label="skip ratio" value={kpis.skipRatio} hint={`${kpis.skipped30d}건 스킵 / 30d`} suffix="%" />
        <KpiCard label="평균 lead-time" value={kpis.avgLeadHours} hint="생성→완료" suffix="h" />
      </section>

      {/* 3-컬럼 보드 */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Column title="📥 new" count={byStatus.new.length} accent="border-emerald-300">
          {byStatus.new.length === 0 ? (
            <Empty hint="시그널이 트리거되면 카드가 여기에 쌓입니다. 생성 버튼으로 즉시 실행 가능." />
          ) : (
            byStatus.new.map((row) => (
              <Card key={row.id} row={row} product={productMap.get(row.product_id)} />
            ))
          )}
        </Column>
        <Column title="💤 snoozed" count={byStatus.snoozed.length} accent="border-gray-300">
          {byStatus.snoozed.length === 0 ? (
            <Empty hint="스누즈 한 카드가 여기로 옵니다." />
          ) : (
            byStatus.snoozed.map((row) => (
              <Card key={row.id} row={row} product={productMap.get(row.product_id)} />
            ))
          )}
        </Column>
        <Column title="✅ done" count={byStatus.done.length} accent="border-blue-300">
          {byStatus.done.length === 0 ? (
            <Empty hint="처리한 카드 (최근 50)." />
          ) : (
            byStatus.done.map((row) => (
              <Card key={row.id} row={row} product={productMap.get(row.product_id)} compact />
            ))
          )}
        </Column>
      </section>
    </div>
  )
}

function KpiCard({
  label,
  value,
  hint,
  suffix,
}: {
  label: string
  value: number
  hint: string | number
  suffix?: string
}) {
  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-3xl font-bold mt-1">
        {value.toLocaleString()}
        {suffix && <span className="text-base font-normal text-gray-500 ml-1">{suffix}</span>}
      </div>
      <div className="text-xs text-gray-400 mt-1">{hint}</div>
    </div>
  )
}

function Column({
  title,
  count,
  accent,
  children,
}: {
  title: string
  count: number
  accent: string
  children: React.ReactNode
}) {
  return (
    <div className={`rounded border-t-2 ${accent} border-x border-b border-gray-200 bg-gray-50/40`}>
      <div className="px-3 py-2 border-b border-gray-200 bg-white flex items-baseline justify-between">
        <div className="text-sm font-semibold">{title}</div>
        <div className="text-xs font-mono text-gray-500">{count}</div>
      </div>
      <div className="p-2 space-y-2 max-h-[800px] overflow-y-auto">{children}</div>
    </div>
  )
}

function Empty({ hint }: { hint: string }) {
  return (
    <div className="rounded border border-dashed border-gray-300 p-6 text-center text-xs text-gray-500">
      {hint}
    </div>
  )
}

function Card({
  row,
  product,
  compact,
}: {
  row: QueueRow
  product: ProductRow | undefined
  compact?: boolean
}) {
  const sig = row.trigger_signal ?? {}
  return (
    <div className="rounded border border-gray-200 bg-white p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <Link
          href={`/admin/trend-radar/products/${row.product_id}`}
          className="font-medium text-sm hover:underline"
        >
          {product?.canonical_name ?? row.product_id.slice(0, 8)}
        </Link>
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded border ${
            ACTION_COLOR[row.action_type] ?? 'bg-gray-50 border-gray-200 text-gray-700'
          }`}
        >
          {ACTION_LABEL[row.action_type] ?? row.action_type}
        </span>
      </div>

      <div className="text-[11px] text-gray-500 flex flex-wrap gap-x-3 gap-y-0.5">
        {product?.category_top && <span>{product.category_top}</span>}
        {row.trigger_rule && <span className="font-mono">{row.trigger_rule}</span>}
        <span className="font-mono">priority {Math.round(row.priority_score)}</span>
      </div>

      {!compact && (
        <details className="text-[11px] text-gray-600">
          <summary className="cursor-pointer text-gray-500 hover:text-black">시그널 원본</summary>
          <pre className="mt-1 bg-gray-50 rounded p-2 overflow-x-auto text-[10px] leading-snug">
            {JSON.stringify(sig, null, 2)}
          </pre>
        </details>
      )}

      {row.decision_note && (
        <div className="text-[11px] text-gray-600 bg-gray-50 rounded px-2 py-1 italic">
          “{row.decision_note}”
        </div>
      )}

      <div className="flex items-center justify-between text-[10px] text-gray-400 font-mono">
        <span>{row.created_at.slice(0, 16)}</span>
        {row.snoozed_until && row.status === 'snoozed' && (
          <span>⏰ {row.snoozed_until.slice(0, 16)}</span>
        )}
      </div>

      {row.status !== 'done' && row.status !== 'skipped' && (
        <ActionCardControls id={row.id} currentStatus={row.status} />
      )}
    </div>
  )
}
