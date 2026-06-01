import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// 구매의도 발화 타입 → 한글 라벨 + 색
const TYPE_LABEL: Record<string, { label: string; cls: string }> = {
  where_to_buy: { label: '어디서 사요', cls: 'bg-emerald-100 text-emerald-800' },
  recommend_request: { label: '추천 요청', cls: 'bg-blue-100 text-blue-800' },
  link_request: { label: '링크 좀', cls: 'bg-indigo-100 text-indigo-800' },
  model_query: { label: '품번 문의', cls: 'bg-violet-100 text-violet-800' },
  alternative: { label: '대체템', cls: 'bg-amber-100 text-amber-800' },
  price_query: { label: '가격 문의', cls: 'bg-rose-100 text-rose-800' },
}

interface IntentQuote {
  quote: string
  type: string
}

interface ProductRow {
  id: string
  canonical_name: string
  category_top: string
  brand: string | null
  alias_count: number
  purchase_intent_count: number
  intent_density: number
  intent_quotes: IntentQuote[]
  intent_classified_at: string | null
}

interface Card extends ProductRow {
  final_score: number | null
  // 교차 분류
  verdict: 'hidden_gem' | 'verified' | 'bubble' | 'neutral'
}

const VERDICT: Record<Card['verdict'], { label: string; cls: string; hint: string }> = {
  hidden_gem: {
    label: '💎 숨은 보석',
    cls: 'border-emerald-300 bg-emerald-50',
    hint: '저화제 · 고구매의도 — 검증된 능동수요, 경쟁 전에 선점',
  },
  verified: {
    label: '✅ 검증 수요',
    cls: 'border-blue-200 bg-blue-50/60',
    hint: '고화제 · 고구매의도 — 화제+실수요 모두 확인',
  },
  bubble: {
    label: '🫧 거품 주의',
    cls: 'border-amber-300 bg-amber-50',
    hint: '고화제 · 저구매의도 — 화제뿐, 사겠다는 발화 적음',
  },
  neutral: {
    label: '· 관찰',
    cls: 'border-gray-200 bg-white',
    hint: '',
  },
}

async function fetchData() {
  const sb = createAdminClient()

  // 구매의도 발화가 잡힌 상품만, 밀도 DESC
  const { data: prods } = await sb
    .from('jimscanner_trends_products')
    // 신규 컬럼은 types/supabase.ts 에 아직 없어 캐스팅
    .select(
      'id, canonical_name, category_top, brand, alias_count, purchase_intent_count, intent_density, intent_quotes, intent_classified_at' as any,
    )
    .gt('purchase_intent_count' as any, 0)
    .order('intent_density' as any, { ascending: false })
    .order('purchase_intent_count' as any, { ascending: false })
    .limit(200)

  const rows = ((prods ?? []) as any[]).map(
    (p): ProductRow => ({
      id: p.id,
      canonical_name: p.canonical_name ?? '?',
      category_top: p.category_top ?? 'other',
      brand: p.brand ?? null,
      alias_count: p.alias_count ?? 0,
      purchase_intent_count: p.purchase_intent_count ?? 0,
      intent_density: Number(p.intent_density ?? 0),
      intent_quotes: Array.isArray(p.intent_quotes) ? p.intent_quotes : [],
      intent_classified_at: p.intent_classified_at ?? null,
    }),
  )

  if (rows.length === 0) return { cards: [] as Card[] }

  // 최신 final_score 매핑 (교차 해석용)
  const ids = rows.map((r) => r.id)
  const { data: scores } = await sb
    .from('jimscanner_trends_scores')
    .select('product_id, final_score, computed_at')
    .in('product_id', ids)
    .order('computed_at', { ascending: false })
    .limit(2000)

  const finalById = new Map<string, number>()
  for (const s of (scores ?? []) as any[]) {
    if (!finalById.has(s.product_id)) finalById.set(s.product_id, s.final_score)
  }

  // 화제(final_score) 임계: 50 이상이면 고화제. 구매의도 밀도 0.3 이상이면 고의도.
  const HIGH_SCORE = 50
  const HIGH_DENSITY = 0.3

  const cards: Card[] = rows.map((r) => {
    const fs = finalById.get(r.id) ?? null
    const hot = fs != null && fs >= HIGH_SCORE
    const wanted = r.intent_density >= HIGH_DENSITY
    let verdict: Card['verdict'] = 'neutral'
    if (wanted && !hot) verdict = 'hidden_gem'
    else if (wanted && hot) verdict = 'verified'
    else if (!wanted && hot) verdict = 'bubble'
    return { ...r, final_score: fs, verdict }
  })

  return { cards }
}

function densityPct(d: number): string {
  return `${Math.round(d * 100)}%`
}

export default async function IntentBoardPage() {
  const { cards } = await fetchData()

  const counts = {
    gem: cards.filter((c) => c.verdict === 'hidden_gem').length,
    verified: cards.filter((c) => c.verdict === 'verified').length,
    bubble: cards.filter((c) => c.verdict === 'bubble').length,
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">구매의도 능동수요 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            커뮤니티 원문에서 추출한 &ldquo;어디서 사요 · 추천 좀 · 링크 좀&rdquo; 발화 ·
            화제량 대비 구매문의 밀도(intent_density) 순
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <section className="grid grid-cols-3 gap-4">
        <div className="rounded border border-emerald-300 bg-emerald-50 p-4">
          <div className="text-2xl font-bold text-emerald-800">{counts.gem}</div>
          <div className="text-xs text-emerald-700 mt-1">💎 숨은 보석 (저화제·고의도)</div>
        </div>
        <div className="rounded border border-blue-200 bg-blue-50/60 p-4">
          <div className="text-2xl font-bold text-blue-800">{counts.verified}</div>
          <div className="text-xs text-blue-700 mt-1">✅ 검증 수요 (고화제·고의도)</div>
        </div>
        <div className="rounded border border-amber-300 bg-amber-50 p-4">
          <div className="text-2xl font-bold text-amber-800">{counts.bubble}</div>
          <div className="text-xs text-amber-700 mt-1">🫧 거품 주의 (고화제·저의도)</div>
        </div>
      </section>

      {cards.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 구매의도 발화가 추출되지 않음. classify-trends-llm cron 누적 후 다시 방문.
        </div>
      ) : (
        <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {cards.map((c) => {
            const v = VERDICT[c.verdict]
            return (
              <Link
                key={c.id}
                href={`/admin/trend-radar/products/${c.id}`}
                className={`block rounded border p-4 transition-colors hover:shadow-sm ${v.cls}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold truncate">
                      {c.canonical_name}
                      {c.brand && <span className="text-gray-500 font-normal ml-1">· {c.brand}</span>}
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      {c.category_top} · alias {c.alias_count}개
                    </div>
                  </div>
                  <span className="shrink-0 text-xs font-semibold whitespace-nowrap">{v.label}</span>
                </div>

                <div className="mt-3 flex items-center gap-4 text-xs">
                  <div>
                    <span className="font-bold text-base">{densityPct(c.intent_density)}</span>
                    <span className="text-gray-500 ml-1">구매의도 밀도</span>
                  </div>
                  <div className="text-gray-600">
                    구매문의 <span className="font-semibold">{c.purchase_intent_count}</span>건
                  </div>
                  <div className="text-gray-600">
                    화제 final{' '}
                    <span className="font-semibold">
                      {c.final_score != null ? Math.round(c.final_score) : '—'}
                    </span>
                  </div>
                </div>

                {c.intent_quotes.length > 0 && (
                  <ul className="mt-3 space-y-1.5">
                    {c.intent_quotes.map((q, i) => {
                      const t = TYPE_LABEL[q.type] ?? TYPE_LABEL.where_to_buy
                      return (
                        <li key={i} className="flex items-start gap-2 text-xs">
                          <span className={`shrink-0 rounded px-1.5 py-0.5 ${t.cls}`}>{t.label}</span>
                          <span className="text-gray-700">&ldquo;{q.quote}&rdquo;</span>
                        </li>
                      )
                    })}
                  </ul>
                )}

                {v.hint && <div className="mt-3 text-[11px] text-gray-500">{v.hint}</div>}
              </Link>
            )
          })}
        </section>
      )}
    </div>
  )
}
