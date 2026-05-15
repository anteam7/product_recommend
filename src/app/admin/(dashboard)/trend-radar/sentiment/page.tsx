import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import SentimentScatter from './SentimentScatter'

export const dynamic = 'force-dynamic'

interface SentimentRow {
  product_id: string
  window_end: string
  window_start: string
  mention_count: number
  pos_count: number
  neg_count: number
  claim_count: number
  pos_ratio: number
  neg_ratio: number
  claim_ratio: number
  claim_keywords: string[] | null
}

interface ProductRow {
  id: string
  canonical_name: string
  category_top: string
}

async function fetchData() {
  const sb = createAdminClient()

  // 최신 sentiment 뷰가 마이그레이션 후 존재. 아직 적용 전이면 빈 배열.
  const { data: sentimentData, error: sentErr } = await (sb as any)
    .from('jimscanner_trends_sentiment_latest')
    .select(
      'product_id, window_end, window_start, mention_count, pos_count, neg_count, claim_count, pos_ratio, neg_ratio, claim_ratio, claim_keywords',
    )
    .limit(500)

  if (sentErr) {
    return { rows: [], missing: true as const, message: sentErr.message ?? '' }
  }
  const rows = (sentimentData ?? []) as SentimentRow[]
  if (rows.length === 0) return { rows: [], missing: false as const, message: '' }

  const ids = rows.map((r) => r.product_id).filter(Boolean)
  const { data: prods } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top')
    .in('id', ids)
  const byId = new Map((prods ?? []).map((p: any) => [p.id, p as ProductRow]))

  const scatter = rows.map((s) => {
    const p = byId.get(s.product_id)
    const mention = s.mention_count ?? 0
    // X 축: 언급량(log scale 0~100). Y 축: 긍정 비율 0~100.
    const xLog = Math.min(100, Math.log10(Math.max(1, mention)) * 33)
    return {
      id: s.product_id,
      name: p?.canonical_name ?? '?',
      category: p?.category_top ?? 'all',
      mention,
      x: Math.round(xLog),
      y: Math.round((s.pos_ratio ?? 0) * 100),
      neg: Math.round((s.neg_ratio ?? 0) * 100),
      claim: Math.round((s.claim_ratio ?? 0) * 100),
      claimKeywords: s.claim_keywords ?? [],
      windowEnd: s.window_end,
    }
  })

  return { rows: scatter, missing: false as const, message: '' }
}

export default async function SentimentPage() {
  const data = await fetchData()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">Sentiment × 언급량 매트릭스</h1>
          <p className="text-sm text-gray-500 mt-1">
            X = 언급량(log) · Y = 긍정 비율 · 좌상단 빨강 = 클레임 위험(언급↑·긍정↓) · 우상단 초록 = 안전 위탁 후보
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {data.missing ? (
        <div className="rounded border border-dashed border-amber-300 bg-amber-50 p-6 text-sm text-amber-800">
          <div className="font-semibold mb-1">마이그레이션 필요</div>
          <div className="text-xs text-amber-700">
            <code>supabase/trends_sentiment.sql</code> 을 먼저 적용한 뒤,{' '}
            <code>scripts/classify-sentiment.mjs</code> cron 으로 분류 누적.
          </div>
          {data.message ? <pre className="mt-2 text-[10px] bg-white p-2 rounded overflow-x-auto">{data.message}</pre> : null}
        </div>
      ) : data.rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 sentiment 데이터 없음. classify-sentiment cron 누적 후 다시 방문.
        </div>
      ) : (
        <SentimentScatter rows={data.rows} />
      )}
    </div>
  )
}
