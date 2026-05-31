import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import TimelineRail, { type TimelineEvent } from './TimelineRail'

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
  const aliases = (aliasRes.data ?? []) as AliasRow[]
  const scoreHistory = (scoreRes.data ?? []) as ScoreRow[]

  const timeline = await buildTimeline(sb, id, product, aliases, scoreHistory)

  return { product, aliases, scoreHistory, timeline }
}

// 여러 테이블에 흩어진 사건을 시간순 단일 연대기로 합성한다.
// 규칙 기반으로 핵심 변곡점을 자동 주석 처리:
//  · '신호 최초 2개+ 소스 동시확인'  · 'final_score 돌파(<40→≥60)'
//  · 'ggsan 소싱 연결'              · '첫 실판매'
// 신규 테이블 없이 기존 테이블 조인만 사용 (일부는 마이그레이션 후 컬럼을 가정, as any 캐스팅).
async function buildTimeline(
  sb: ReturnType<typeof createAdminClient>,
  productId: string,
  product: ProductRow,
  aliases: AliasRow[],
  scoreHistory: ScoreRow[],
): Promise<TimelineEvent[]> {
  const events: TimelineEvent[] = []

  // ── ① 신호: 키워드/raw 에서 alias 가 어느 소스에 언제 처음 등장했는지 ──
  const aliasTexts = [...new Set(aliases.map((a) => a.alias).filter(Boolean))]
  try {
    if (aliasTexts.length) {
      const { data: kw } = await (sb as any)
        .from('jimscanner_trends_keywords')
        .select('keyword, source, collected_at')
        .in('keyword', aliasTexts.slice(0, 100))
        .order('collected_at', { ascending: true })
        .limit(500)
      const rows = (kw ?? []) as Array<{ keyword: string; source: string; collected_at: string }>
      // 소스별 최초 등장
      const firstBySource = new Map<string, { at: string; keyword: string }>()
      for (const r of rows) {
        if (!r.source || !r.collected_at) continue
        if (!firstBySource.has(r.source)) firstBySource.set(r.source, { at: r.collected_at, keyword: r.keyword })
      }
      // 시간순 정렬해, ≥2개 소스가 동시확인된 시점(다중 소스 교차검증)을 자동 주석
      const sorted = [...firstBySource.entries()].sort((a, b) => a[1].at.localeCompare(b[1].at))
      let crossMarked = false
      sorted.forEach(([source, info], idx) => {
        const isCross = idx === 1 && !crossMarked
        if (isCross) crossMarked = true
        events.push({
          at: info.at,
          kind: 'signal',
          title: `${source} 에서 신호 포착 — "${info.keyword}"`,
          detail: idx === 0 ? '최초 단일 소스 등장' : undefined,
          annotation: isCross ? `${sorted.length}개 소스 동시확인` : undefined,
        })
      })
    }
  } catch {
    /* 키워드 조회 실패는 무시 (타임라인은 가용 데이터로 best-effort) */
  }

  // ── ② 점수: final_score 시계열 변곡점 (오름차순으로 재정렬해 임계 돌파 감지) ──
  const scoresAsc = [...scoreHistory].sort((a, b) => (a.computed_at ?? '').localeCompare(b.computed_at ?? ''))
  if (scoresAsc.length) {
    events.push({
      at: scoresAsc[0].computed_at,
      kind: 'score',
      title: `최초 스코어링 — final ${scoresAsc[0].final_score}`,
      detail: `trend ${scoresAsc[0].trend_score} · commerce ${scoresAsc[0].commerce_score} · supplier ${scoresAsc[0].supplier_score} · competition ${scoresAsc[0].competition_score}`,
    })
    let prevFinal = scoresAsc[0].final_score
    let peak = { v: scoresAsc[0].final_score, at: scoresAsc[0].computed_at }
    let breakoutMarked = false
    for (let i = 1; i < scoresAsc.length; i++) {
      const s = scoresAsc[i]
      if (s.final_score > peak.v) peak = { v: s.final_score, at: s.computed_at }
      // final_score 돌파: 직전 <40 → 현재 ≥60
      if (!breakoutMarked && prevFinal < 40 && s.final_score >= 60) {
        events.push({
          at: s.computed_at,
          kind: 'score',
          title: `final_score 돌파 ${prevFinal} → ${s.final_score}`,
          annotation: 'final_score 돌파 (<40→≥60)',
        })
        breakoutMarked = true
      }
      prevFinal = s.final_score
    }
    if (scoresAsc.length > 1 && peak.at !== scoresAsc[0].computed_at) {
      events.push({ at: peak.at, kind: 'score', title: `final_score 최고점 ${peak.v}` })
    }
  }

  // ── ③ 소싱: trends_supplier (product_id 연결) + ggsan 도매가 변동 ──
  const ggsanGoodsNos = new Set<string>()
  try {
    const { data: sup } = await (sb as any)
      .from('jimscanner_trends_supplier')
      .select('supplier_source, supplier_url, supplier_product_id, price_krw, collected_at')
      .eq('product_id', productId)
      .order('collected_at', { ascending: true })
    const supRows = (sup ?? []) as Array<{
      supplier_source: string
      supplier_url: string | null
      supplier_product_id: string | null
      price_krw: number | null
      collected_at: string
    }>
    supRows.forEach((r, idx) => {
      if (r.supplier_product_id) ggsanGoodsNos.add(r.supplier_product_id)
      events.push({
        at: r.collected_at,
        kind: 'sourcing',
        title: `${r.supplier_source} 소싱 연결${r.price_krw ? ` — 도매 ${r.price_krw.toLocaleString()}원` : ''}`,
        detail: r.supplier_product_id ? `상품번호 ${r.supplier_product_id}` : undefined,
        annotation: idx === 0 ? 'ggsan 소싱 연결' : undefined,
      })
    })
  } catch {
    /* supplier 조회 실패 무시 */
  }

  // ── ③-b ggsan 도매가 변동 시계열 (연결된 goods_no 기준, 변동분만) ──
  if (ggsanGoodsNos.size) {
    try {
      const { data: ph } = await (sb as any)
        .from('jimscanner_ggsan_price_history')
        .select('goods_no, price_krw, status, observed_at')
        .in('goods_no', [...ggsanGoodsNos])
        .order('observed_at', { ascending: true })
        .limit(200)
      const phRows = (ph ?? []) as Array<{ goods_no: string; price_krw: number | null; status: string | null; observed_at: string }>
      const prevPrice = new Map<string, number | null>()
      for (const r of phRows) {
        const prev = prevPrice.get(r.goods_no)
        if (prev !== undefined && prev !== r.price_krw) {
          events.push({
            at: r.observed_at,
            kind: 'price',
            title: `도매가 변동 ${prev?.toLocaleString() ?? '—'} → ${r.price_krw?.toLocaleString() ?? '—'}원`,
            detail: r.status ? `재고: ${r.status}` : undefined,
          })
        }
        prevPrice.set(r.goods_no, r.price_krw)
      }
    } catch {
      /* price history 조회 실패 무시 */
    }
  }

  // ── ④ 실판매: ggsan goods_no → 쿠팡 listing → 주문 (첫 실판매 자동 주석) ──
  if (ggsanGoodsNos.size) {
    try {
      const { data: lst } = await (sb as any)
        .from('jimscanner_coupang_listings')
        .select('seller_product_id, source_goods_no')
        .in('source_goods_no', [...ggsanGoodsNos])
      const spids = [
        ...new Set(
          ((lst ?? []) as Array<{ seller_product_id: number | null }>)
            .map((l) => l.seller_product_id)
            .filter((v): v is number => v != null),
        ),
      ]
      if (spids.length) {
        const { data: ord } = await (sb as any)
          .from('jimscanner_coupang_orders')
          .select('order_price, product_name, ordered_at, seller_product_id')
          .in('seller_product_id', spids)
          .order('ordered_at', { ascending: true })
          .limit(200)
        const ordRows = (ord ?? []) as Array<{ order_price: number | null; product_name: string | null; ordered_at: string }>
        ordRows.forEach((r, idx) => {
          if (!r.ordered_at) return
          events.push({
            at: r.ordered_at,
            kind: 'sale',
            title: `쿠팡 주문${r.order_price ? ` ${r.order_price.toLocaleString()}원` : ''}${r.product_name ? ` — ${r.product_name}` : ''}`,
            annotation: idx === 0 ? '첫 실판매' : undefined,
          })
        })
      }
    } catch {
      /* 주문 체인 조회 실패 무시 */
    }
  }

  // ── 메타: 발굴/마지막 관측 ──
  events.push({ at: product.first_seen_at, kind: 'meta', title: '상품으로 발굴 등록', annotation: '발굴 시작' })
  if (product.last_seen_at && product.last_seen_at !== product.first_seen_at) {
    events.push({ at: product.last_seen_at, kind: 'meta', title: '최근 관측' })
  }

  // 시간 오름차순 정렬 (연대기)
  return events
    .filter((e) => e.at)
    .sort((a, b) => a.at.localeCompare(b.at))
}

export default async function ProductDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const data = await fetchProduct(id)
  if (!data) notFound()
  const { product, aliases, scoreHistory, timeline } = data
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

      {/* 발굴 서사 타임라인 — 신호→소싱→판매 단일 연대기 */}
      <section>
        <h2 className="text-sm font-semibold mb-3">
          발굴 서사 타임라인
          <span className="ml-2 font-normal text-gray-400">신호 → 소싱 → 판매 연대기</span>
        </h2>
        <TimelineRail events={timeline} />
      </section>

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
