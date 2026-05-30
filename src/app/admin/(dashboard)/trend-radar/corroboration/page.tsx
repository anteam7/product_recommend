import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import CorroborationBoard, { type BoardRow, MODALITIES } from './CorroborationBoard'

export const dynamic = 'force-dynamic'

// SQL 의 jimscanner_trends_modality() 와 반드시 동기화할 것.
// (UI 는 alias 테이블에서 직접 집계하므로 뷰가 없어도 동작 — SQL 뷰는 분석용)
const SOURCE_TO_MODALITY: Record<string, string> = {
  naver_search_trend: 'search',
  naver_shopping_insight: 'search',
  google_suggest: 'search',
  naver_shopping_hot: 'shopping',
  musinsa: 'shopping',
  aliex: 'shopping',
  domeggook: 'shopping',
  '82cook': 'community',
  natepan: 'community',
  ppomppu: 'community',
  dcinside: 'community',
  clien: 'community',
  naver_tvtime: 'tv',
  daum: 'news',
  naver: 'news',
  kca: 'news',
}

interface AliasRow {
  product_id: string
  source: string | null
}
interface ProductRow {
  id: string
  canonical_name: string
  category_top: string
}
interface ScoreRow {
  product_id: string
  final_score: number
  trend_score: number
  score_components: any
  computed_at: string
}

function extractConsensus(components: any): number | null {
  if (!components || typeof components !== 'object') return null
  const t = components.trend ?? components
  const v = t?.source_consensus ?? components?.source_consensus
  return typeof v === 'number' ? v : null
}

async function fetchData(): Promise<{ rows: BoardRow[] }> {
  const sb = createAdminClient()

  const [aliasRes, scoreRes] = await Promise.all([
    sb.from('jimscanner_trends_aliases').select('product_id, source').limit(20000),
    sb
      .from('jimscanner_trends_scores')
      .select('product_id, final_score, trend_score, score_components, computed_at')
      .order('computed_at', { ascending: false })
      .limit(4000),
  ])

  const aliases = (aliasRes.data ?? []) as AliasRow[]

  // product_id → Set<modality>, 그리고 모달리티별 alias 카운트
  const modalityCounts = new Map<string, Map<string, number>>()
  for (const a of aliases) {
    if (!a.source) continue
    const modality = SOURCE_TO_MODALITY[a.source]
    if (!modality) continue // 'other' 는 교차검증에서 제외
    let m = modalityCounts.get(a.product_id)
    if (!m) {
      m = new Map<string, number>()
      modalityCounts.set(a.product_id, m)
    }
    m.set(modality, (m.get(modality) ?? 0) + 1)
  }

  // product_id 별 최신 score
  const latestScore = new Map<string, ScoreRow>()
  for (const s of (scoreRes.data ?? []) as ScoreRow[]) {
    if (!latestScore.has(s.product_id)) latestScore.set(s.product_id, s)
  }

  const ids = Array.from(modalityCounts.keys())
  if (ids.length === 0) return { rows: [] }

  // 상품 이름 (chunk 로 in 조회)
  const byId = new Map<string, ProductRow>()
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500)
    const { data } = await sb
      .from('jimscanner_trends_products')
      .select('id, canonical_name, category_top')
      .in('id', chunk)
    for (const p of (data ?? []) as ProductRow[]) byId.set(p.id, p)
  }

  const rows: BoardRow[] = ids.map((pid) => {
    const counts = modalityCounts.get(pid)!
    const present = MODALITIES.filter((m) => counts.has(m.key)).map((m) => m.key)
    const p = byId.get(pid)
    const score = latestScore.get(pid)
    const cells: Record<string, number> = {}
    for (const m of MODALITIES) cells[m.key] = counts.get(m.key) ?? 0
    return {
      product_id: pid,
      name: p?.canonical_name ?? '(미분류)',
      category: p?.category_top ?? '—',
      cells,
      breadth: present.length,
      total_aliases: Array.from(counts.values()).reduce((a, b) => a + b, 0),
      independence: Math.round((present.length / MODALITIES.length) * 1000) / 1000,
      final_score: score?.final_score ?? null,
      trend_score: score?.trend_score ?? null,
      source_consensus: extractConsensus(score?.score_components),
    }
  })

  // breadth 내림차순, 동률은 final_score
  rows.sort((a, b) => b.breadth - a.breadth || (b.final_score ?? 0) - (a.final_score ?? 0))

  return { rows }
}

export default async function CorroborationPage() {
  const { rows } = await fetchData()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">교차 모달리티 출처폭</h1>
          <p className="text-sm text-gray-500 mt-1">
            16개 수집원을 5개 모달리티로 묶어 상품별 <b>독립 교차검증 폭(breadth)</b>을 집계 ·
            breadth=1 은 단일소스 일시 스파이크(취약) · 출처 &apos;개수&apos;가 아닌 &apos;다양성&apos;으로 재랭킹
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 alias 데이터 없음. cron 누적 후 다시 방문.
        </div>
      ) : (
        <CorroborationBoard rows={rows} />
      )}
    </div>
  )
}
