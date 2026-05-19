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

interface TribeRecRow {
  community_id: string
  tribe_label: string
  channel: string
  channel_label: string
  priority: number
  expected_ctr_low: number | null
  expected_ctr_high: number | null
  copy_tone: string | null
  note: string | null
}

interface KeywordShareRow {
  community_id: string
  keyword: string
  share_pct: number
  dominance_idx: number
}

const COMMUNITY_EMOJI: Record<string, string> = {
  '82cook': '🍳',
  ppomppu: '🏷️',
  dcinside: '🎮',
  natepan: '💄',
  clien_park: '💻',
  quasarzone_sale: '🖥️',
}

async function fetchProduct(id: string) {
  const sb = createAdminClient() as any
  const [prodRes, aliasRes, scoreRes, mapRes] = await Promise.all([
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
    sb.from('jimscanner_tribe_channel_map').select('*').order('priority'),
  ])

  if (prodRes.error || !prodRes.data) return null

  const aliases = (aliasRes.data ?? []) as AliasRow[]
  const channelMap = (mapRes.data ?? []) as TribeRecRow[]

  // alias 들로 keyword_share lookup → 트라이브 우세도 산출
  const aliasKeys = aliases.map((a) => a.alias.toLowerCase().trim()).filter(Boolean)
  let shareRows: KeywordShareRow[] = []
  if (aliasKeys.length > 0) {
    const shareRes = await sb
      .from('jimscanner_tribe_keyword_share')
      .select('community_id, keyword, share_pct, dominance_idx')
      .in('keyword', aliasKeys)
    shareRows = (shareRes.data ?? []) as KeywordShareRow[]
  }

  // 트라이브 점수 = sum(share_pct * dominance_idx) per community
  const tribeScore = new Map<string, number>()
  for (const s of shareRows) {
    const cur = tribeScore.get(s.community_id) ?? 0
    tribeScore.set(s.community_id, cur + (s.share_pct || 0) * (s.dominance_idx || 0))
  }

  // 우세 community 가 없으면 fallback: category_top 으로 휴리스틱 매칭
  let dominantCommunities = Array.from(tribeScore.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([cid]) => cid)

  if (dominantCommunities.length === 0) {
    // alias 매칭 결과가 없으면, 카테고리 휴리스틱으로 fallback
    const cat = (prodRes.data.category_top ?? '').toLowerCase()
    if (cat.includes('식품') || cat.includes('생활')) dominantCommunities = ['82cook', 'ppomppu']
    else if (cat.includes('pc') || cat.includes('가전') || cat.includes('it')) dominantCommunities = ['clien_park', 'quasarzone_sale']
    else if (cat.includes('뷰티') || cat.includes('패션')) dominantCommunities = ['natepan', '82cook']
    else dominantCommunities = ['ppomppu', 'clien_park']
  }

  // 우세 community 의 채널 매핑 중 priority 낮은 순으로 Top 3 합산
  const recs: TribeRecRow[] = []
  for (const cid of dominantCommunities) {
    const list = channelMap.filter((m) => m.community_id === cid)
    for (const c of list) {
      if (recs.length >= 3) break
      // 중복 channel 은 합치지 말고 community 별로 우선순위 유지
      if (recs.find((r) => r.community_id === cid && r.channel === c.channel)) continue
      recs.push(c)
    }
    if (recs.length >= 3) break
  }

  return {
    product: prodRes.data as ProductRow,
    aliases,
    scoreHistory: (scoreRes.data ?? []) as ScoreRow[],
    channelRecs: recs.slice(0, 3),
    tribeScore: Array.from(tribeScore.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4),
    fallbackUsed: tribeScore.size === 0,
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
  const { product, aliases, scoreHistory, channelRecs, tribeScore, fallbackUsed } = data
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

      {/* 추천 광고 채널 Top 3 (트라이브 매칭) */}
      <section>
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="text-sm font-semibold">📣 추천 광고 채널 Top 3</h2>
          <Link href="/admin/trend-radar/tribe-channel" className="text-[11px] text-gray-500 hover:text-black underline">
            트라이브↔채널 보드 →
          </Link>
        </div>
        {channelRecs.length === 0 ? (
          <div className="rounded border border-dashed border-gray-300 p-3 text-xs text-gray-500">
            매핑 데이터 없음 — <code>supabase/tribe_channel_map.sql</code> 마이그레이션 적용 필요
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {channelRecs.map((c, i) => (
                <div key={`${c.community_id}-${c.channel}`} className="rounded-lg border border-gray-200 p-3">
                  <div className="flex items-baseline justify-between">
                    <div className="text-xs text-gray-500">#{i + 1} · {COMMUNITY_EMOJI[c.community_id] ?? '◆'} {c.tribe_label}</div>
                    <div className="text-[10px] text-gray-400 font-mono">{c.community_id}</div>
                  </div>
                  <div className="mt-1 text-base font-bold">{c.channel_label}</div>
                  <div className="text-xs text-gray-600 font-mono mt-0.5">
                    예상 CTR {c.expected_ctr_low != null && c.expected_ctr_high != null
                      ? `${c.expected_ctr_low}~${c.expected_ctr_high}%`
                      : '—'}
                  </div>
                  {c.copy_tone && (
                    <div className="text-xs text-gray-700 mt-2">
                      <span className="text-gray-400">카피 톤:</span> {c.copy_tone}
                    </div>
                  )}
                  {c.note && <div className="text-[11px] text-gray-400 mt-1">{c.note}</div>}
                </div>
              ))}
            </div>
            <div className="mt-2 text-[11px] text-gray-500">
              {fallbackUsed
                ? '※ alias-keyword_share 매칭 없음 → 카테고리 휴리스틱으로 fallback'
                : `트라이브 우세도: ${tribeScore.map(([c, s]) => `${c}=${s.toFixed(1)}`).join(' · ')}`}
            </div>
          </>
        )}
      </section>

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
