import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { computeMargin, SHIP } from '@/lib/coupang/price'

export const dynamic = 'force-dynamic'

// ── 핫딜 군중검증 수요 보드 ──────────────────────────────────────
// 커뮤니티 핫딜(quasarzone_sale·clien_park)을 발굴 신호로 승격한 화면.
// 핫딜가 = "이 가격이면 산다"는 군중 합의 가격상한선.
// ggsan 도매원가 + 쿠팡 공식가가 이 상한선 아래로 떨어지는 후보 = '확신 위너'.
// RPC: jimscanner_hotdeal_demand_board (supabase/hotdeal_demand_board.sql)
// 마이그레이션 적용 전이므로 RPC 결과는 as any 캐스팅.

const WINDOW_DAYS = 14

interface BoardRow {
  cluster_key: string
  sample_title: string
  source_label: string | null
  appearances: number
  total_reply: number
  total_view: number
  first_seen: string
  last_seen: string
  price_hint: number | null
  raw_ids: string[]
}

interface GgsanRow {
  goods_no: string
  title: string
  price_krw: number | null
  detail_url: string | null
}

const STOPWORDS = new Set([
  '무료배송', '무배', '정품', '국내', '해외', '직구', '특가', '할인', '쿠폰',
  '최저가', '핫딜', '세일', '이벤트', '증정', '단독', '한정', '오늘', '추가',
])

function tokenize(s: string): string[] {
  return (s.match(/[가-힣a-zA-Z0-9]+/g) ?? [])
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
}

/** board 제목 ↔ ggsan 제목 토큰 겹침으로 최선 매칭 1건 선택 (없으면 null) */
function matchGgsan(title: string, ggsan: GgsanRow[], ggsanTokens: string[][]): GgsanRow | null {
  const tks = tokenize(title)
  if (tks.length === 0) return null
  let best: GgsanRow | null = null
  let bestScore = 0
  for (let i = 0; i < ggsan.length; i++) {
    const gt = ggsanTokens[i]
    let score = 0
    for (const t of tks) {
      if (gt.some((g) => g.includes(t) || t.includes(g))) score++
    }
    if (score > bestScore) {
      bestScore = score
      best = ggsan[i]
    }
  }
  // 토큰 2개 이상 겹쳐야 신뢰 (board 토큰이 1개뿐이면 1개 매칭도 허용)
  const threshold = tks.length <= 2 ? 1 : 2
  return bestScore >= threshold ? best : null
}

async function fetchData() {
  const sb = createAdminClient()

  const [boardRes, ggsanRes] = await Promise.all([
    // RPC: 마이그레이션 적용 후 동작. 미적용 환경에선 빈 배열로 graceful.
    (sb.rpc as unknown as (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>)(
      'jimscanner_hotdeal_demand_board',
      { p_days: WINDOW_DAYS },
    ),
    sb
      .from('jimscanner_ggsan_products')
      .select('goods_no, title, price_krw, detail_url')
      .not('price_krw', 'is', null)
      .order('last_changed_at', { ascending: false })
      .limit(3000),
  ])

  const board = ((boardRes.data ?? []) as BoardRow[]).slice(0, 80)
  const ggsan = (ggsanRes.data ?? []) as GgsanRow[]
  const ggsanTokens = ggsan.map((g) => tokenize(g.title))

  return { board, ggsan, ggsanTokens, rpcError: boardRes.error }
}

function replyVelocity(row: BoardRow): number {
  const spanDays = Math.max(
    1,
    (new Date(row.last_seen).getTime() - new Date(row.first_seen).getTime()) / 86_400_000,
  )
  return Math.round((row.total_reply / spanDays) * 10) / 10
}

export default async function HotdealDemandPage() {
  const { board, ggsan, ggsanTokens, rpcError } = await fetchData()

  // 각 board row 에 ggsan 매칭 + 게이트 판정 부착
  const enriched = board.map((row) => {
    const match = matchGgsan(row.sample_title, ggsan, ggsanTokens)
    const ceiling = row.price_hint
    let margin: ReturnType<typeof computeMargin> | null = null
    let winner = false
    if (match?.price_krw != null && ceiling != null && ceiling > 0) {
      // 군중 가격상한선(ceiling)을 판매가로 두고 ggsan 원가로 마진 계산.
      margin = computeMargin(ceiling, match.price_krw)
      winner = margin.margin > 0
    }
    return { row, match, ceiling, margin, winner, velocity: replyVelocity(row) }
  })

  const winners = enriched.filter((e) => e.winner)
  const sourcingQueue = enriched.filter((e) => !e.match) // ggsan 미연결 → 소싱 후보

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🔥 핫딜 군중검증 수요</h1>
          <p className="text-sm text-gray-500 mt-1 max-w-3xl">
            커뮤니티 핫딜(퀘이사존·클리앙) 재등장 빈도 × 댓글 속도로 검증된 가성비 수요.
            핫딜가는 “이 가격이면 산다”는 <strong>군중 합의 가격상한선</strong> — ggsan 도매원가 + 쿠팡
            공식가가 이 상한선 아래로 떨어지면 <strong className="text-emerald-600">확신 위너</strong>.
            최근 {WINDOW_DAYS}일 · 배송비 {SHIP.toLocaleString()}원 가정.
          </p>
        </div>
        <Link href="/admin/trend-radar/sources" className="text-sm text-gray-700 hover:text-black underline">
          소스 헬스 →
        </Link>
      </header>

      {rpcError != null && (
        <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          RPC <code>jimscanner_hotdeal_demand_board</code> 미적용 또는 오류 —
          <code className="ml-1">supabase/hotdeal_demand_board.sql</code> 마이그레이션을 적용하세요.
        </div>
      )}

      {/* 요약 카드 */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded border border-gray-200 p-4">
          <div className="text-xs text-gray-500">군집된 핫딜 상품</div>
          <div className="text-2xl font-bold">{board.length}</div>
        </div>
        <div className="rounded border border-emerald-200 bg-emerald-50 p-4">
          <div className="text-xs text-emerald-700">확신 위너 (상한선 통과)</div>
          <div className="text-2xl font-bold text-emerald-700">{winners.length}</div>
        </div>
        <div className="rounded border border-amber-200 bg-amber-50 p-4">
          <div className="text-xs text-amber-700">소싱 후보 (ggsan 미연결)</div>
          <div className="text-2xl font-bold text-amber-700">{sourcingQueue.length}</div>
        </div>
      </div>

      {/* 메인 보드 */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-2">수요 랭킹</h2>
        <div className="rounded border border-gray-200 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs">
              <tr>
                <th className="px-3 py-2 text-left">상품</th>
                <th className="px-3 py-2 text-right">핫딜 재등장</th>
                <th className="px-3 py-2 text-right">댓글 속도</th>
                <th className="px-3 py-2 text-right">군중 가격상한</th>
                <th className="px-3 py-2 text-left">ggsan 원가 → 내 판매가</th>
                <th className="px-3 py-2 text-right">마진 여유</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {enriched.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-gray-400">
                    핫딜 데이터 없음 (수집 cron 또는 RPC 확인)
                  </td>
                </tr>
              ) : (
                enriched.map((e) => (
                  <tr key={e.row.cluster_key} className={e.winner ? 'bg-emerald-50/40' : undefined}>
                    <td className="px-3 py-2 max-w-md">
                      <div className="font-medium line-clamp-2 leading-snug" title={e.row.sample_title}>
                        {e.winner && <span className="mr-1">✅</span>}
                        {e.row.sample_title}
                      </div>
                      <div className="text-[11px] text-gray-400">
                        {e.row.source_label ?? '—'} · {e.row.total_view.toLocaleString()} 조회
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      {e.row.appearances}회
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-gray-600">
                      {e.row.total_reply}{' '}
                      <span className="text-[11px] text-gray-400">({e.velocity}/일)</span>
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      {e.ceiling != null ? `${e.ceiling.toLocaleString()}원` : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="px-3 py-2">
                      {e.match ? (
                        <a
                          href={e.match.detail_url ?? '#'}
                          target="_blank"
                          rel="noopener"
                          className="text-xs hover:underline"
                          title={e.match.title}
                        >
                          <span className="font-mono">{e.match.price_krw?.toLocaleString()}원</span>
                          {e.ceiling != null && (
                            <span className="text-gray-500"> → {e.ceiling.toLocaleString()}원</span>
                          )}
                          <span className="block text-gray-400 line-clamp-1">{e.match.title}</span>
                        </a>
                      ) : (
                        <Link
                          href={`/admin/trend-radar/ggsan?q=${encodeURIComponent(tokenize(e.row.sample_title)[0] ?? '')}`}
                          className="text-xs text-amber-700 hover:underline"
                        >
                          소싱 후보 — ggsan 검색 →
                        </Link>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      {e.margin ? (
                        <span className={e.margin.margin > 0 ? 'text-emerald-600 font-semibold' : 'text-red-500'}>
                          {e.margin.margin > 0 ? '+' : ''}
                          {e.margin.margin.toLocaleString()}원
                          <span className="block text-[11px] text-gray-400">{e.margin.marginPct}%</span>
                        </span>
                      ) : (
                        <span className="text-gray-300">—</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <p className="text-[11px] text-gray-400 mt-2">
          v1: 군집키 = 정규화 제목 prefix(16자). 댓글 속도 = total_reply / 등장 기간(일).
          ggsan 매칭은 제목 토큰 겹침 휴리스틱 — 정밀 캐노니컬 매칭(Haiku)은 후속.
        </p>
      </section>
    </div>
  )
}
