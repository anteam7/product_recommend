import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// jimscanner_trends_rivalry — 마이그레이션(supabase/trends_rivalry.sql) 적용 후 타입 미생성 상태라 as any 캐스팅.
interface RivalryRow {
  id: string
  from_product_id: string | null
  to_product_id: string | null
  from_name: string
  to_name: string
  relation: 'vs' | 'replace'
  window: string
  mention_count: number
  source: string | null
  sample_quote: string | null
  last_seen_at: string
}

interface ConsiderationSet {
  product: string
  rivals: { name: string; mentions: number; relation: 'vs' | 'replace' }[]
  total: number
}

interface MomentumPair {
  challenger: string
  incumbent: string
  challengerNow: number
  incumbentNow: number
  challengerPrev: number
  incumbentPrev: number
  share: number // 챌린저 언급 점유율 (challenger / (challenger+incumbent))
  sharePrev: number
  reversing: boolean // 점유 역전 중(추월 직전/직후)
  quote: string | null
}

function sortedWindows(rows: RivalryRow[]): string[] {
  return [...new Set(rows.map((r) => r.window))].sort()
}

async function fetchRivalry(): Promise<{ rows: RivalryRow[]; error: string | null }> {
  const sb = createAdminClient()
  const { data, error } = await (sb as any)
    .from('jimscanner_trends_rivalry')
    .select(
      'id, from_product_id, to_product_id, from_name, to_name, relation, window, mention_count, source, sample_quote, last_seen_at',
    )
    .order('mention_count', { ascending: false })
    .limit(2000)
  if (error) return { rows: [], error: error.message }
  return { rows: (data ?? []) as RivalryRow[], error: null }
}

// ① consideration set — 한 상품이 누구와 저울질되는지 (양방향 집계).
function buildConsiderationSets(rows: RivalryRow[]): ConsiderationSet[] {
  const byProduct = new Map<string, Map<string, { mentions: number; relation: 'vs' | 'replace' }>>()
  const bump = (a: string, b: string, m: number, rel: 'vs' | 'replace') => {
    if (!byProduct.has(a)) byProduct.set(a, new Map())
    const inner = byProduct.get(a)!
    const cur = inner.get(b)
    inner.set(b, { mentions: (cur?.mentions ?? 0) + m, relation: cur?.relation ?? rel })
  }
  for (const r of rows) {
    bump(r.from_name, r.to_name, r.mention_count, r.relation)
    bump(r.to_name, r.from_name, r.mention_count, r.relation)
  }
  const sets: ConsiderationSet[] = []
  for (const [product, inner] of byProduct) {
    const rivals = [...inner.entries()]
      .map(([name, v]) => ({ name, mentions: v.mentions, relation: v.relation }))
      .sort((a, b) => b.mentions - a.mentions)
    const total = rivals.reduce((s, r) => s + r.mentions, 0)
    sets.push({ product, rivals, total })
  }
  return sets.sort((a, b) => b.total - a.total).slice(0, 30)
}

// ②③ 모멘텀 — 챌린저→인커번트 쌍별로 최근 vs 직전 window 언급 점유율 추세.
function buildMomentum(rows: RivalryRow[]): MomentumPair[] {
  const windows = sortedWindows(rows)
  const now = windows[windows.length - 1]
  const prev = windows.length > 1 ? windows[windows.length - 2] : null

  // 정규화된 방향 키: challenger=from, incumbent=to
  const pairs = new Map<
    string,
    { challenger: string; incumbent: string; nowC: number; prevC: number; quote: string | null }
  >()
  // 각 쌍의 인커번트 자체 언급(역방향)도 점유율 분모에 필요 → from/to 합산.
  const mentionsAt = (window: string | null, a: string, b: string) =>
    rows
      .filter(
        (r) =>
          r.window === window &&
          ((r.from_name === a && r.to_name === b) || (r.from_name === b && r.to_name === a)),
      )
      .reduce((s, r) => s + r.mention_count, 0)

  for (const r of rows) {
    if (r.relation !== 'replace') continue // 갈아타기(방향성 명확)만 모멘텀 대상
    const key = `${r.from_name}→${r.to_name}`
    if (pairs.has(key)) continue
    const challenger = r.from_name
    const incumbent = r.to_name
    pairs.set(key, {
      challenger,
      incumbent,
      nowC: 0,
      prevC: 0,
      quote: r.sample_quote,
    })
  }

  const out: MomentumPair[] = []
  for (const { challenger, incumbent, quote } of pairs.values()) {
    // 챌린저 언급 = replace(from=challenger) 합, 인커번트 언급 = 반대방향 + 동일쌍 'vs' 절반 취급은 생략하고 쌍 총량 기준.
    const cNow = rows
      .filter((r) => r.window === now && r.from_name === challenger && r.to_name === incumbent)
      .reduce((s, r) => s + r.mention_count, 0)
    const cPrev = rows
      .filter((r) => r.window === prev && r.from_name === challenger && r.to_name === incumbent)
      .reduce((s, r) => s + r.mention_count, 0)
    const totalNow = mentionsAt(now, challenger, incumbent)
    const totalPrev = mentionsAt(prev, challenger, incumbent)
    const iNow = Math.max(0, totalNow - cNow)
    const iPrev = Math.max(0, totalPrev - cPrev)
    const share = totalNow > 0 ? cNow / totalNow : 0
    const sharePrev = totalPrev > 0 ? cPrev / totalPrev : 0
    // 역전 중: 직전엔 인커번트 우위(<0.5)였는데 지금 추월 임박(>=0.4) 또는 추월(>0.5)하며 상승.
    const reversing = share > sharePrev && share >= 0.4 && totalNow >= 2
    out.push({
      challenger,
      incumbent,
      challengerNow: cNow,
      incumbentNow: iNow,
      challengerPrev: cPrev,
      incumbentPrev: iPrev,
      share,
      sharePrev,
      reversing,
      quote,
    })
  }
  return out.sort((a, b) => Number(b.reversing) - Number(a.reversing) || b.share - a.share)
}

export default async function RivalryPage() {
  const { rows, error } = await fetchRivalry()
  const sets = buildConsiderationSets(rows)
  const momentum = buildMomentum(rows)
  const reversalQueue = momentum.filter((m) => m.reversing)
  const windows = sortedWindows(rows)

  return (
    <div className="space-y-8 p-6">
      <header>
        <h1 className="text-2xl font-bold">⚔️ 경쟁구도 · 챌린저 모멘텀</h1>
        <p className="text-sm text-gray-500 mt-1">
          커뮤니티 비교·대체 발화(A vs B / A 말고 B)에서 마이닝한 방향성 경쟁 그래프. 구매 직전 소비자가 무엇과
          무엇을 저울질하는지 = 가장 액션 가능한 신호.
        </p>
        <p className="text-[11px] text-gray-400 mt-1 font-mono">
          rows {rows.length} · windows {windows.length ? windows.join(', ') : '—'} · 수집:{' '}
          <code>scripts/mine-trends-rivalry.mjs</code>
        </p>
      </header>

      {error && (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          rivalry 테이블 조회 실패: {error}
          <div className="text-xs mt-1">
            마이그레이션 <code>supabase/trends_rivalry.sql</code> 적용 후 사용 가능합니다.
          </div>
        </div>
      )}

      {!error && rows.length === 0 && (
        <div className="rounded border border-gray-200 bg-gray-50 p-6 text-sm text-gray-600">
          아직 마이닝된 비교 발화가 없습니다. 로컬에서{' '}
          <code className="font-mono">node --env-file=.env.local scripts/mine-trends-rivalry.mjs</code> 실행 후
          데이터가 채워집니다.
        </div>
      )}

      {/* ③ 발굴 큐 — 점유 역전 중인 챌린저 */}
      {reversalQueue.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold mb-2">
            🔥 역전 발굴 큐 — 챌린저가 인커번트 추월 중/임박 ({reversalQueue.length})
          </h2>
          <div className="grid gap-2 md:grid-cols-2">
            {reversalQueue.map((m, i) => (
              <div key={i} className="rounded border border-red-200 bg-red-50/40 p-3">
                <div className="flex items-baseline justify-between">
                  <div className="text-sm font-semibold">
                    {m.challenger} <span className="text-red-600">▶</span>{' '}
                    <span className="text-gray-500 line-through">{m.incumbent}</span>
                  </div>
                  <div className="text-xs font-mono text-red-700">점유 {(m.share * 100).toFixed(0)}%</div>
                </div>
                <ShareBar share={m.share} />
                <div className="text-[11px] text-gray-500 mt-1">
                  직전 {(m.sharePrev * 100).toFixed(0)}% → 현재 {(m.share * 100).toFixed(0)}% (챌린저{' '}
                  {m.challengerNow} / 인커번트 {m.incumbentNow} 언급)
                </div>
                {m.quote && <div className="text-[11px] text-gray-400 italic mt-1">“{m.quote}”</div>}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ② 챌린저 모멘텀 — 갈아타기 점유율 막대 */}
      {momentum.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold mb-2">② 갈아타기 모멘텀 (replace 발화 점유율)</h2>
          <div className="rounded border border-gray-200 divide-y divide-gray-100">
            {momentum.slice(0, 40).map((m, i) => (
              <div key={i} className="px-3 py-2">
                <div className="flex items-center justify-between text-sm">
                  <div>
                    <span className="font-medium">{m.challenger}</span>
                    <span className="text-gray-400"> 대신 ← </span>
                    <span className="text-gray-600">{m.incumbent}</span>
                  </div>
                  <div className="text-xs font-mono text-gray-500">
                    {(m.share * 100).toFixed(0)}%
                    {m.reversing && <span className="ml-1 text-red-600">↑역전</span>}
                  </div>
                </div>
                <ShareBar share={m.share} />
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ① consideration set — 같이 비교되는 상품 */}
      {sets.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold mb-2">① consideration set — 같이 저울질되는 상품</h2>
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {sets.map((s, i) => (
              <div key={i} className="rounded border border-gray-200 p-3">
                <div className="flex items-baseline justify-between">
                  <div className="text-sm font-semibold">{s.product}</div>
                  <div className="text-[11px] text-gray-400 font-mono">총 {s.total}</div>
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {s.rivals.slice(0, 8).map((r, j) => (
                    <span
                      key={j}
                      className={`text-xs px-2 py-0.5 rounded ${
                        r.relation === 'replace'
                          ? 'bg-red-100 text-red-700'
                          : 'bg-gray-100 text-gray-600'
                      }`}
                      title={r.relation === 'replace' ? '대체(갈아타기)' : 'vs(비교)'}
                    >
                      {r.name} <span className="font-mono opacity-60">{r.mentions}</span>
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <p className="text-[11px] text-gray-400">
        <Link href="/admin/trend-radar" className="hover:text-black">
          ← 대시보드
        </Link>{' '}
        · 동반언급(보완재)과 반대로 <strong>대체재 경쟁</strong>을 다룹니다.
      </p>
    </div>
  )
}

function ShareBar({ share }: { share: number }) {
  const pct = Math.max(0, Math.min(100, share * 100))
  return (
    <div className="mt-1 h-2 w-full rounded bg-gray-100 overflow-hidden">
      <div
        className={`h-full ${pct >= 50 ? 'bg-red-500' : 'bg-blue-400'}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}
