import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface ProductRow {
  id: string
  canonical_name: string
  category_top: string
  category_mid: string | null
  brand: string | null
  description: string | null
  intent_label: string | null
  llm_classified_at: string | null
  llm_model: string | null
  alias_count: number
  first_seen_at: string
  last_seen_at: string
}
interface AliasRow {
  alias: string
  alias_type: string
  source: string | null
  confidence: number
  classified_by: string | null
  created_at: string
}
interface ScoreRow {
  trend_score: number
  commerce_score: number
  supplier_score: number
  competition_score: number
  final_score: number
  score_components: any
  computed_at: string
}

interface VisionAttrSummary {
  axis: string
  label: string
  modalValue: string | null
  modalLabel: string | null
  share: number
  total: number
}

const VISION_AXES: { key: string; label: string; values: { v: string; label: string }[] }[] = [
  {
    key: 'primary_color',
    label: '주조색',
    values: [
      { v: 'beige', label: '베이지' },
      { v: 'pastel', label: '파스텔' },
      { v: 'vivid', label: '원색' },
      { v: 'mono', label: '모노톤' },
      { v: 'other', label: '기타' },
    ],
  },
  {
    key: 'package_form',
    label: '패키지 형태',
    values: [
      { v: 'pouch', label: '파우치' },
      { v: 'bottle', label: '병' },
      { v: 'box', label: '박스' },
      { v: 'zipper', label: '지퍼' },
      { v: 'stick', label: '스틱' },
      { v: 'other', label: '기타' },
    ],
  },
  {
    key: 'design_style',
    label: '디자인 스타일',
    values: [
      { v: 'minimal', label: '미니멀' },
      { v: 'retro', label: '레트로' },
      { v: 'natural', label: '내추럴' },
      { v: 'kpop', label: '케이팝' },
      { v: 'other', label: '기타' },
    ],
  },
  {
    key: 'model_in_scene',
    label: '모델/사용씬',
    values: [
      { v: 'true', label: '있음' },
      { v: 'false', label: '없음' },
    ],
  },
  {
    key: 'has_korean',
    label: '한글표기',
    values: [
      { v: 'true', label: '있음' },
      { v: 'false', label: '없음' },
    ],
  },
  {
    key: 'size_label',
    label: '사이즈 명시',
    values: [
      { v: 'true', label: '있음' },
      { v: 'false', label: '없음' },
    ],
  },
]

async function fetchPinnedAttrSummary(
  sb: ReturnType<typeof createAdminClient>,
  category_top: string,
): Promise<VisionAttrSummary[]> {
  // 같은 카테고리에서 final_score >= 50 인 product 의 vision attrs modal 산출.
  const { data: scores } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, final_score, computed_at')
    .gte('final_score', 50)
    .order('computed_at', { ascending: false })
    .limit(500)
  const seen = new Set<string>()
  const ids: string[] = []
  for (const r of (scores ?? []) as any[]) {
    if (seen.has(r.product_id)) continue
    seen.add(r.product_id)
    ids.push(r.product_id)
  }
  if (ids.length === 0) return []

  const q = (sb as any)
    .from('jimscanner_trends_vision_attrs')
    .select('attrs, category_top')
    .in('product_id', ids)
    .eq('category_top', category_top)
    .limit(2000)
  const { data, error } = await q
  if (error || !data || data.length === 0) return []
  const counts: Record<string, Record<string, number>> = {}
  for (const ax of VISION_AXES) counts[ax.key] = {}
  for (const r of data as any[]) {
    for (const ax of VISION_AXES) {
      const raw = r.attrs?.[ax.key]
      const v = raw == null ? null : String(raw)
      if (!v) continue
      counts[ax.key][v] = (counts[ax.key][v] ?? 0) + 1
    }
  }
  return VISION_AXES.map((ax) => {
    const entries = Object.entries(counts[ax.key]).sort((a, b) => b[1] - a[1])
    const total = entries.reduce((s, [, n]) => s + n, 0)
    const top = entries[0]
    return {
      axis: ax.key,
      label: ax.label,
      modalValue: top ? top[0] : null,
      modalLabel: top ? ax.values.find((x) => x.v === top[0])?.label ?? top[0] : null,
      share: top && total > 0 ? top[1] / total : 0,
      total,
    }
  })
}

async function fetchOwnVisionAttrs(
  sb: ReturnType<typeof createAdminClient>,
  productId: string,
) {
  const { data } = await (sb as any)
    .from('jimscanner_trends_vision_attrs')
    .select('attrs, image_url, vision_model, classified_at')
    .eq('product_id', productId)
    .order('classified_at', { ascending: false })
    .limit(1)
  const row = data?.[0]
  return row ? (row as { attrs: any; image_url: string; vision_model: string | null; classified_at: string }) : null
}

async function fetchProduct(id: string) {
  const sb = createAdminClient()
  const [prodRes, aliasRes, scoreRes] = await Promise.all([
    sb.from('jimscanner_trends_products').select('*').eq('id', id).single(),
    sb
      .from('jimscanner_trends_aliases')
      .select('alias, alias_type, source, confidence, classified_by, created_at')
      .eq('product_id', id)
      .order('confidence', { ascending: false }),
    sb
      .from('jimscanner_trends_scores')
      .select('trend_score, commerce_score, supplier_score, competition_score, final_score, score_components, computed_at')
      .eq('product_id', id)
      .order('computed_at', { ascending: false })
      .limit(30),
  ])

  if (prodRes.error || !prodRes.data) return null
  const product = prodRes.data as ProductRow

  const [pinnedAttrs, ownAttrs] = await Promise.all([
    fetchPinnedAttrSummary(sb, product.category_top),
    fetchOwnVisionAttrs(sb, id),
  ])

  return {
    product,
    aliases: (aliasRes.data ?? []) as AliasRow[],
    scoreHistory: (scoreRes.data ?? []) as ScoreRow[],
    pinnedAttrs,
    ownAttrs,
  }
}

export default async function ProductDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const data = await fetchProduct(id)
  if (!data) notFound()
  const { product, aliases, scoreHistory, pinnedAttrs, ownAttrs } = data
  const latest = scoreHistory[0]

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <Link href="/admin/trend-radar" className="text-sm text-gray-500 hover:text-black">
            ← 대시보드
          </Link>
          <h1 className="text-2xl font-bold mt-1">{product.canonical_name}</h1>
          <p className="text-sm text-gray-500 mt-1">
            {product.brand ? <span className="text-black font-medium">{product.brand}</span> : null}
            {product.brand ? ' · ' : ''}
            카테고리: {product.category_top}
            {product.category_mid ? ` / ${product.category_mid}` : ''} · alias {product.alias_count}건
          </p>
          {(product.intent_label || product.description) && (
            <div className="mt-2 flex items-center gap-2 flex-wrap">
              {product.intent_label && (
                <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-700 font-medium">
                  🏷 {product.intent_label}
                </span>
              )}
              {product.description && (
                <span className="text-sm text-gray-700">{product.description}</span>
              )}
            </div>
          )}
          {product.llm_classified_at && (
            <p className="text-[10px] text-gray-400 mt-1 font-mono">
              LLM 분류: {product.llm_classified_at.slice(0, 19).replace('T', ' ')}
              {product.llm_model ? ` · ${product.llm_model}` : ''}
            </p>
          )}
        </div>
      </header>

      {/* 4점수 카드 */}
      {latest && (
        <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <ScoreCard label="final" value={latest.final_score} bold />
          <ScoreCard label="trend" value={latest.trend_score} />
          <ScoreCard label="commerce" value={latest.commerce_score} />
          <ScoreCard label="supplier" value={latest.supplier_score} />
          <ScoreCard label="competition" value={latest.competition_score} />
        </section>
      )}

      {/* score 시계열 (최근 30 row) */}
      {scoreHistory.length > 1 && (
        <section>
          <h2 className="text-sm font-semibold mb-2">점수 추이 (최근 {scoreHistory.length}회 산출)</h2>
          <div className="rounded border border-gray-200 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-gray-500">
                <tr>
                  <th className="px-3 py-2 text-left">computed_at</th>
                  <th className="px-3 py-2 text-right">final</th>
                  <th className="px-3 py-2 text-right">trend</th>
                  <th className="px-3 py-2 text-right">commerce</th>
                  <th className="px-3 py-2 text-right">supplier</th>
                  <th className="px-3 py-2 text-right">competition</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {scoreHistory.map((s, i) => (
                  <tr key={i}>
                    <td className="px-3 py-1 font-mono text-gray-600">{s.computed_at?.slice(5, 19)}</td>
                    <td className="px-3 py-1 text-right font-bold">{s.final_score}</td>
                    <td className="px-3 py-1 text-right">{s.trend_score}</td>
                    <td className="px-3 py-1 text-right">{s.commerce_score}</td>
                    <td className="px-3 py-1 text-right">{s.supplier_score}</td>
                    <td className="px-3 py-1 text-right">{s.competition_score}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* score breakdown */}
      {latest?.score_components && (
        <section>
          <h2 className="text-sm font-semibold mb-2">최신 score components</h2>
          <pre className="rounded border border-gray-200 p-3 text-xs overflow-x-auto bg-gray-50">
            {JSON.stringify(latest.score_components, null, 2)}
          </pre>
        </section>
      )}

      {/* 추천 패키지 속성 — 같은 카테고리 핀/고득점군 modal 기반 */}
      {pinnedAttrs.length > 0 && pinnedAttrs.some((a) => a.total > 0) && (
        <section className="rounded border border-amber-300 bg-amber-50/40 p-4">
          <h2 className="text-sm font-semibold text-gray-700">
            🎨 추천 패키지 속성{' '}
            <span className="text-xs font-normal text-gray-500 ml-2">
              ({product.category_top} 카테고리 핀/고득점군의 modal · 카피·소싱 가이드)
            </span>
          </h2>
          <div className="mt-3 grid grid-cols-2 md:grid-cols-3 gap-3">
            {pinnedAttrs.map((a) => {
              const ownVal = ownAttrs?.attrs ? String(ownAttrs.attrs[a.axis] ?? '') : ''
              const isMatch = a.modalValue && ownVal && ownVal === a.modalValue
              return (
                <div key={a.axis} className="rounded border border-gray-100 p-3 bg-white">
                  <div className="text-xs text-gray-500">{a.label}</div>
                  {a.modalValue ? (
                    <>
                      <div className="text-lg font-bold mt-1">
                        {a.modalLabel}
                        <span className="text-xs text-gray-400 ml-2 font-mono">
                          {Math.round(a.share * 100)}%
                        </span>
                      </div>
                      <div className="text-[10px] text-gray-400 mt-1">
                        고득점군 {a.total}건 중 최빈값
                      </div>
                      {ownAttrs?.attrs && (
                        <div className={`mt-2 text-xs ${isMatch ? 'text-emerald-700' : 'text-gray-500'}`}>
                          현재: {ownVal || '미분류'}
                          {isMatch ? ' ✓ 일치' : ''}
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="text-xs text-gray-400 mt-1">표본 부족</div>
                  )}
                </div>
              )
            })}
          </div>
          {ownAttrs && (
            <div className="text-[10px] text-gray-400 mt-3 font-mono">
              본 상품 vision 분류: {ownAttrs.classified_at.slice(0, 19).replace('T', ' ')}
              {ownAttrs.vision_model ? ` · ${ownAttrs.vision_model}` : ''}
            </div>
          )}
        </section>
      )}

      {/* aliases */}
      <section>
        <h2 className="text-sm font-semibold mb-2">매핑된 alias ({aliases.length})</h2>
        <div className="rounded border border-gray-200 divide-y divide-gray-100">
          {aliases.map((a, i) => (
            <div key={i} className="grid grid-cols-12 px-3 py-2 text-sm items-center">
              <div className="col-span-7">{a.alias}</div>
              <div className="col-span-2 text-xs text-gray-500">{a.source ?? '—'}</div>
              <div className="col-span-2 text-xs text-gray-500">{a.classified_by ?? '—'}</div>
              <div className="col-span-1 text-right text-xs font-mono text-gray-600">
                {a.confidence?.toFixed(2)}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="text-xs text-gray-500">
        first_seen: {product.first_seen_at} · last_seen: {product.last_seen_at}
      </section>
    </div>
  )
}

function ScoreCard({ label, value, bold }: { label: string; value: number; bold?: boolean }) {
  return (
    <div className="rounded border border-gray-200 p-3 text-center">
      <div className="text-xs text-gray-500 uppercase">{label}</div>
      <div className={`mt-1 ${bold ? 'text-3xl font-bold' : 'text-2xl text-gray-700'}`}>
        {value}
      </div>
    </div>
  )
}
