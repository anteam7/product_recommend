import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import SentimentScatter, { type SentimentRow } from './SentimentScatter'

export const dynamic = 'force-dynamic'

interface RawSentiment {
  product_id: string
  polarity: 'positive' | 'negative' | 'neutral'
  defect_terms: string[] | null
  evidence_snippet: string | null
  source: string | null
  mention_count: number
  computed_at: string
}

const POLARITY_NET: Record<string, number> = { positive: 1, neutral: 0, negative: -1 }

async function fetchData() {
  const sb = createAdminClient()

  // jimscanner_trends_sentiment 은 마이그레이션 후 생성 (as any 로 타입 우회)
  const { data: rawRows } = await (sb as any)
    .from('jimscanner_trends_sentiment')
    .select('product_id, polarity, defect_terms, evidence_snippet, source, mention_count, computed_at')
    .order('computed_at', { ascending: false })
    .limit(3000)

  // product_id 별 최신 1건
  const seen = new Set<string>()
  const latest: RawSentiment[] = []
  for (const r of (rawRows ?? []) as RawSentiment[]) {
    if (seen.has(r.product_id)) continue
    seen.add(r.product_id)
    latest.push(r)
  }

  const ids = latest.map((r) => r.product_id)
  if (ids.length === 0) return { rows: [] as SentimentRow[] }

  const { data: prods } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name')
    .in('id', ids)
  const nameById = new Map((prods ?? []).map((p: any) => [p.id, p.canonical_name]))

  // 버즈량 정규화: 최대 mention_count 기준 0-100
  const maxBuzz = Math.max(1, ...latest.map((r) => r.mention_count ?? 0))

  const rows: SentimentRow[] = latest.map((r) => {
    const net = POLARITY_NET[r.polarity] ?? 0
    return {
      id: r.product_id,
      name: nameById.get(r.product_id) ?? '?',
      polarity: r.polarity,
      defect_terms: r.defect_terms ?? [],
      evidence: r.evidence_snippet ?? '',
      source: r.source,
      buzz: r.mention_count ?? 0,
      x: Math.round(((r.mention_count ?? 0) / maxBuzz) * 100),
      // 순극성: 중립 50 기준, 긍정 +40 / 부정 -40
      y: 50 + net * 40,
    }
  })

  return { rows }
}

export default async function SentimentPage() {
  const { rows } = await fetchData()
  const pos = rows.filter((r) => r.polarity === 'positive').length
  const neg = rows.filter((r) => r.polarity === 'negative').length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">커뮤니티 감성 극성 게이트</h1>
          <p className="text-sm text-gray-500 mt-1">
            X = 커뮤니티 버즈량 · Y = 순극성(positive−negative) · 우상단=입소문(우선 소싱) · 우하단=하자·불만(위탁 차단)
          </p>
          {rows.length > 0 && (
            <p className="text-xs text-gray-400 mt-1">
              총 {rows.length}개 · 입소문 {pos} · 하자·불만 {neg}
            </p>
          )}
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 감성 데이터 없음. classify-trends-llm.mjs 의 sentiment 패스 누적 후 다시 방문.
        </div>
      ) : (
        <SentimentScatter rows={rows} />
      )}
    </div>
  )
}
