import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import InboxClient, { type InboxCard, type CategoryOption } from './InboxClient'

export const dynamic = 'force-dynamic'

const CATEGORY_OPTIONS: CategoryOption[] = [
  { key: '1', code: 'health',   label: '건강식품' },
  { key: '2', code: 'living',   label: '생활/리빙' },
  { key: '3', code: 'digital',  label: '디지털/가전' },
  { key: '4', code: 'beauty',   label: '뷰티' },
  { key: '5', code: 'fashion',  label: '패션' },
  { key: '6', code: 'kitchen',  label: '주방' },
  { key: '7', code: 'pet',      label: '반려' },
  { key: '8', code: 'baby',     label: '유아' },
  { key: '9', code: 'other',    label: '기타' },
]

interface ProductLite {
  id: string
  canonical_name: string
  category_top: string | null
  category_mid: string | null
  intent_label: string | null
  description: string | null
  brand: string | null
  alias_count: number
  llm_classified_at: string | null
  llm_model: string | null
  last_seen_at: string
}

interface AliasLite {
  product_id: string
  alias: string
  alias_type: string
  source: string | null
  confidence: number
  created_at: string
}

async function fetchInbox() {
  const sb = createAdminClient()

  // 미분류 = category_top IS NULL OR '미분류'. 이미 처리된 row 는 classify_status 로 제외.
  // classify_status / snoozed_until 컬럼은 supabase/trends_v4_triage_inbox.sql 적용 후 존재.
  // generated 타입 미반영 — `npm run gen:types` 후 unknown 캐스팅 제거.
  const { data: products } = await (sb
    .from('jimscanner_trends_products') as any)
    .select(
      'id, canonical_name, category_top, category_mid, intent_label, description, brand, alias_count, llm_classified_at, llm_model, last_seen_at, classify_status, snoozed_until'
    )
    .or('category_top.is.null,category_top.eq.미분류')
    .order('last_seen_at', { ascending: false })
    .limit(200)

  type RawRow = ProductLite & { classify_status: string | null; snoozed_until: string | null }
  const nowIso = new Date().toISOString()
  const pending = ((products ?? []) as unknown as RawRow[]).filter((p) => {
    if (!p.classify_status) return true
    if (p.classify_status === 'snoozed' && (!p.snoozed_until || p.snoozed_until < nowIso)) return true
    return false
  })

  const productIds = pending.map((p) => p.id)

  // alias 미니 프리뷰 — 한 번에 가져와서 client 에 분배.
  let aliasMap = new Map<string, AliasLite[]>()
  if (productIds.length > 0) {
    const { data: aliases } = await sb
      .from('jimscanner_trends_aliases')
      .select('product_id, alias, alias_type, source, confidence, created_at')
      .in('product_id', productIds)
      .order('created_at', { ascending: false })
      .limit(2000)
    for (const a of (aliases ?? []) as AliasLite[]) {
      const arr = aliasMap.get(a.product_id) ?? []
      arr.push(a)
      aliasMap.set(a.product_id, arr)
    }
  }

  // 미분류 전체 카운트 (페이지 KPI)
  const { count: totalPending } = await sb
    .from('jimscanner_trends_products')
    .select('*', { count: 'exact', head: true })
    .or('category_top.is.null,category_top.eq.미분류')

  // 오늘 actor 가 처리한 카운트 (전체 admin 합산 — 멀티유저 시 actor 별 분리 가능)
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)
  // jimscanner_classify_events 는 supabase/trends_v4_triage_inbox.sql 적용 후 생성.
  // generated 타입 미반영 — as any 캐스팅 (gen:types 후 제거).
  const { count: todayDone } = await (sb as any)
    .from('jimscanner_classify_events')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', todayStart.toISOString())

  const cards: InboxCard[] = pending.map((p) => {
    const aliases = (aliasMap.get(p.id) ?? []).slice(0, 3)
    const sourceCount = new Map<string, number>()
    for (const a of aliasMap.get(p.id) ?? []) {
      if (!a.source) continue
      sourceCount.set(a.source, (sourceCount.get(a.source) ?? 0) + 1)
    }
    const topSource =
      [...sourceCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null

    return {
      id: p.id,
      canonical_name: p.canonical_name,
      category_top: p.category_top,
      category_mid: p.category_mid,
      intent_label: p.intent_label,
      description: p.description,
      brand: p.brand,
      alias_count: p.alias_count,
      llm_classified_at: p.llm_classified_at,
      llm_model: p.llm_model,
      last_seen_at: p.last_seen_at,
      aliases: aliases.map((a) => ({
        alias: a.alias,
        source: a.source,
        confidence: Number(a.confidence ?? 0),
      })),
      top_source: topSource,
    }
  })

  return {
    cards,
    totalPending: totalPending ?? cards.length,
    todayDone: todayDone ?? 0,
  }
}

export default async function TriageInboxPage() {
  const { cards, totalPending, todayDone } = await fetchInbox()

  return (
    <div className="p-6">
      <header className="mb-4 flex items-baseline justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold">Triage Inbox</h1>
          <p className="text-sm text-gray-500 mt-1">
            미분류 시그널을 키보드로 한 화면에서 처리.
            <span className="ml-2 text-xs font-mono text-gray-400">
              J/K 이동 · 1~9 카테고리 · P=핀 · X=거부 · S=스누즈7d · N=메모 · A=LLM추정 수용
            </span>
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <InboxClient
        initialCards={cards}
        totalPending={totalPending}
        todayDone={todayDone}
        categoryOptions={CATEGORY_OPTIONS}
      />
    </div>
  )
}
