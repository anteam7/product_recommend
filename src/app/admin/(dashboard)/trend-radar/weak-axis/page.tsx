import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import WeakAxisHeatmap from './WeakAxisHeatmap'

export const dynamic = 'force-dynamic'

// DB aspect 키 → 한국어 라벨 (extract-review-aspects.mjs / SQL 과 일치)
export const ASPECT_LABELS: Record<string, string> = {
  delivery: '배송',
  packaging: '포장',
  quality: '품질',
  taste: '맛·향',
  size_fit: '사이즈·핏',
  design: '디자인',
  price: '가격',
  usability: '사용감',
}
const ASPECT_ORDER = Object.keys(ASPECT_LABELS)

const CATEGORY_LABELS: Record<string, string> = {
  health: '건강',
  living: '생활',
  digital: '디지털',
  other: '기타',
}

interface WeaknessRow {
  category_top: string
  aspect: string
  neg_count: number
  total_count: number
  neg_ratio: number
  last_30d: boolean
}
interface SnippetRow {
  category_top: string
  aspect: string
  snippet: string | null
  sku_external_id: string
  product_title: string | null
  confidence: number
}

async function fetchData() {
  // 신규 테이블/뷰는 생성된 Supabase 타입에 아직 없음 → as any (마이그레이션 후 제거)
  const sb = createAdminClient() as any

  const { data: weakness } = await sb
    .from('v_category_aspect_weakness')
    .select('category_top, aspect, neg_count, total_count, neg_ratio, last_30d')

  // 부정 스니펫 (드릴다운 워드클라우드/토픽용)
  const { data: snippets } = await sb
    .from('jimscanner_review_aspects')
    .select('category_top, aspect, snippet, sku_external_id, product_title, confidence')
    .eq('sentiment', 'neg')
    .not('snippet', 'is', null)
    .order('captured_at', { ascending: false })
    .limit(2000)

  return {
    weakness: (weakness ?? []) as WeaknessRow[],
    snippets: (snippets ?? []) as SnippetRow[],
  }
}

export default async function WeakAxisPage() {
  const { weakness, snippets } = await fetchData()

  const categories = Array.from(new Set(weakness.map((w) => w.category_top))).sort()
  const cells = new Map<string, WeaknessRow>()
  for (const w of weakness) cells.set(`${w.category_top}::${w.aspect}`, w)

  // 스니펫을 cell 키별로 묶기
  const snippetsByCell: Record<string, SnippetRow[]> = {}
  for (const s of snippets) {
    const k = `${s.category_top}::${s.aspect}`
    ;(snippetsByCell[k] ??= []).push(s)
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">Weak-Axis 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            카테고리 × 속성 부정률 히트맵 · 진한 셀 = 경쟁 SKU 가 공통으로 못하는 약점 축 ·
            셀 클릭 → 부정 스니펫. <span className="text-gray-400">발행 시 그 축을 카피·이미지에서 선제 방어.</span>
          </p>
        </div>
        <Link href="/admin/trend-radar/opportunity" className="text-sm text-gray-700 hover:text-black underline">
          Opportunity →
        </Link>
      </header>

      {weakness.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 aspect 데이터 없음. <code className="text-xs">scripts/extract-review-aspects.mjs</code> cron 누적 후 다시 방문.
        </div>
      ) : (
        <WeakAxisHeatmap
          categories={categories}
          aspectOrder={ASPECT_ORDER}
          aspectLabels={ASPECT_LABELS}
          categoryLabels={CATEGORY_LABELS}
          cells={Object.fromEntries(cells)}
          snippetsByCell={snippetsByCell}
        />
      )}
    </div>
  )
}
