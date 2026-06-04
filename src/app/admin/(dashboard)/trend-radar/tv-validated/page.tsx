import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// ────────────────────────────────────────────────────────────
// TV홈쇼핑 채널중복 MD검증 보드
// '편성 빈도'가 아니라 '몇 개 홈쇼핑사(채널)가 같은 상품을 편성했나'로 재집계.
// 홈쇼핑 MD = 자비로 대량 사입·편성하는 전문 게이트키퍼.
// 한 SKU 를 여러 사가 반복 편성 = 대중수요·재구매·반품률까지 이미 검증된 위너.
// 검증점수 = 채널폭 × 반복 × 프라임슬롯 프리미엄.
// channel 컬럼은 supabase/trends_v5_tv_channel.sql 적용 후 채워짐.
// ────────────────────────────────────────────────────────────

const DAYS_OPTIONS = [
  { v: 7, label: '7일' },
  { v: 14, label: '14일' },
  { v: 30, label: '30일' },
] as const

// 프라임 슬롯 = 오전 황금(09~11) + 저녁 황금(20~23). MD 가 메인 상품을 거는 시간대.
function isPrimeSlot(hhmm: string | null): boolean {
  if (!hhmm) return false
  const h = parseInt(hhmm.split(':')[0], 10)
  if (Number.isNaN(h)) return false
  return (h >= 9 && h <= 11) || (h >= 20 && h <= 23)
}

// 상품명 정규화 — 같은 상품의 채널별 표기 차이를 흡수해 canonical 단위로 묶기.
function canonName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[[\]()<>{}「」『』，,·…！!~"']/g, ' ')
    .replace(/\d+\s*(개입|개|팩|종|병|매|box|set|세트|구성)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

interface KwRow {
  keyword: string
  category: string | null // 시간 슬롯 HH:MM
  channel: string | null
  collected_at: string
}

interface GgsanMatch {
  goods_no: string
  ggsan_title: string
  price_krw: number | null
  is_imminent: boolean
  image_url: string | null
  detail_url: string | null
  sim: number
}

interface Validated {
  canonical: string
  display: string // 대표 표기 (가장 자주 등장한 원문)
  channels: string[]
  editions: number // 총 편성 횟수 (반복)
  days: number // 편성된 distinct 일수
  primeEditions: number
  firstSeen: string
  lastSeen: string
  score: number
  ggsan: GgsanMatch | null
}

async function fetchTvRows(days: number): Promise<KwRow[]> {
  const sb = createAdminClient()
  const since = new Date(Date.now() - days * 86400_000).toISOString()
  // channel 컬럼은 생성 타입 미반영 → select 결과를 명시 캐스팅
  const { data, error } = await sb
    .from('jimscanner_trends_keywords')
    .select('keyword, category, channel, collected_at')
    .eq('source', 'naver_tvtime')
    .gte('collected_at', since)
    .order('collected_at', { ascending: false })
  if (error) {
    console.error('tv-validated fetch error', error)
    return []
  }
  return (data ?? []) as unknown as KwRow[]
}

// RPC 로 ggsan 후보 best match 를 원문 keyword 단위로 인덱싱.
async function fetchGgsanByKeyword(days: number): Promise<Map<string, GgsanMatch>> {
  const sb = createAdminClient()
  const { data, error } = await sb.rpc('jimscanner_tv_ggsan_match', {
    days_window: days,
    min_sim: 0.2,
    per_keyword_limit: 1,
    result_limit: 500,
  })
  const map = new Map<string, GgsanMatch>()
  if (error) {
    console.error('tv-validated rpc error', error)
    return map
  }
  type Row = GgsanMatch & { keyword: string }
  for (const r of (data ?? []) as Row[]) {
    const prev = map.get(r.keyword)
    if (!prev || r.sim > prev.sim) {
      map.set(r.keyword, {
        goods_no: r.goods_no,
        ggsan_title: r.ggsan_title,
        price_krw: r.price_krw,
        is_imminent: r.is_imminent,
        image_url: r.image_url,
        detail_url: r.detail_url,
        sim: r.sim,
      })
    }
  }
  return map
}

function buildValidated(rows: KwRow[], ggsanByKw: Map<string, GgsanMatch>): Validated[] {
  interface Agg {
    canonical: string
    channels: Set<string>
    editions: number
    days: Set<string>
    primeEditions: number
    firstSeen: string
    lastSeen: string
    displayHist: Map<string, number>
    keywords: Set<string>
  }
  const map = new Map<string, Agg>()
  for (const r of rows) {
    const c = canonName(r.keyword)
    if (c.length < 2) continue
    let v = map.get(c)
    if (!v) {
      v = {
        canonical: c,
        channels: new Set(),
        editions: 0,
        days: new Set(),
        primeEditions: 0,
        firstSeen: r.collected_at,
        lastSeen: r.collected_at,
        displayHist: new Map(),
        keywords: new Set(),
      }
      map.set(c, v)
    }
    v.editions++
    if (r.channel) v.channels.add(r.channel)
    v.days.add(r.collected_at.slice(0, 10))
    if (isPrimeSlot(r.category)) v.primeEditions++
    if (r.collected_at < v.firstSeen) v.firstSeen = r.collected_at
    if (r.collected_at > v.lastSeen) v.lastSeen = r.collected_at
    v.displayHist.set(r.keyword, (v.displayHist.get(r.keyword) ?? 0) + 1)
    v.keywords.add(r.keyword)
  }

  const out: Validated[] = []
  for (const v of map.values()) {
    const distinctChannels = v.channels.size
    const primeRatio = v.editions > 0 ? v.primeEditions / v.editions : 0
    // 채널폭 가중: 채널 식별 실패(0) 시 1 로 처리(빈도만 반영).
    const breadth = Math.max(distinctChannels, 1)
    // 검증점수 = 채널폭 × √반복 × (1 + 프라임프리미엄) — 채널 다양성에 가장 큰 가중.
    const score = Math.round(breadth * Math.sqrt(v.editions) * (1 + primeRatio) * 10)

    // 대표 표기 = 가장 자주 등장한 원문
    let display = v.canonical
    let best = -1
    for (const [k, n] of v.displayHist) if (n > best) { best = n; display = k }

    // ggsan best match = 멤버 keyword 중 sim 최고
    let ggsan: GgsanMatch | null = null
    for (const k of v.keywords) {
      const g = ggsanByKw.get(k)
      if (g && (!ggsan || g.sim > ggsan.sim)) ggsan = g
    }

    out.push({
      canonical: v.canonical,
      display,
      channels: [...v.channels].sort(),
      editions: v.editions,
      days: v.days.size,
      primeEditions: v.primeEditions,
      firstSeen: v.firstSeen,
      lastSeen: v.lastSeen,
      score,
      ggsan,
    })
  }

  // 정렬: ggsan 소싱가능 + 3사 이상 반복편성 최상단 → 점수 → 채널폭
  return out.sort((a, b) => {
    const aTop = a.ggsan && a.channels.length >= 3 ? 1 : 0
    const bTop = b.ggsan && b.channels.length >= 3 ? 1 : 0
    if (aTop !== bTop) return bTop - aTop
    if (a.score !== b.score) return b.score - a.score
    return b.channels.length - a.channels.length
  })
}

function buildHref(days: number): string {
  return days === 14 ? '/admin/trend-radar/tv-validated' : `/admin/trend-radar/tv-validated?days=${days}`
}

export default async function TvValidatedPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>
}) {
  const sp = await searchParams
  const reqDays = parseInt(sp.days ?? '14', 10)
  const days = DAYS_OPTIONS.some((d) => d.v === reqDays) ? reqDays : 14

  const [rows, ggsanByKw] = await Promise.all([fetchTvRows(days), fetchGgsanByKeyword(days)])
  const validated = buildValidated(rows, ggsanByKw)

  const channelTagged = rows.filter((r) => r.channel).length
  const multiChannel = validated.filter((v) => v.channels.length >= 2).length
  const tripleSourceable = validated.filter((v) => v.channels.length >= 3 && v.ggsan).length
  const topList = validated.slice(0, 120)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">📺 TV 채널중복 MD검증 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            빈도가 아니라 <strong>몇 개 홈쇼핑사가 같은 상품을 편성했나</strong>로 재집계.
            여러 사가 반복 편성한 상품 = 프로 MD 가 이미 다중 검증한 대중 위너.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 기간 필터 */}
      <div className="flex flex-wrap items-center gap-4 rounded border border-gray-200 px-4 py-3">
        <span className="text-xs text-gray-500">기간</span>
        {DAYS_OPTIONS.map((d) => (
          <Link
            key={d.v}
            href={buildHref(d.v)}
            className={`px-2 py-1 text-xs rounded ${days === d.v ? 'bg-amber-100 text-amber-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
          >
            {d.label}
          </Link>
        ))}
      </div>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="검증 상품(canonical)" value={validated.length} />
        <Kpi label="2사+ 동시편성" value={multiChannel} highlight={multiChannel > 0} />
        <Kpi label="🔥 3사+ ⨯ ggsan 소싱가능" value={tripleSourceable} highlight={tripleSourceable > 0} />
        <Kpi label="채널 태깅 row" value={`${channelTagged}/${rows.length}`} />
      </section>

      {channelTagged === 0 && (
        <div className="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-800">
          아직 channel 태깅된 row 가 없습니다. <code>supabase/trends_v5_tv_channel.sql</code> 적용 +
          collect-naver-tvtime 재수집 후 채널폭 신호가 채워집니다. (현재는 편성 빈도만 반영)
        </div>
      )}

      {/* 검증 랭킹 */}
      {topList.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          조건에 맞는 데이터 없음. 누적 후 다시 확인.
        </div>
      ) : (
        <div className="space-y-2">
          {topList.map((v, i) => {
            const top = v.channels.length >= 3 && v.ggsan
            return (
              <div
                key={v.canonical}
                className={`rounded border overflow-hidden ${top ? 'border-red-300' : 'border-gray-200'}`}
              >
                <div className={`flex items-start gap-3 px-4 py-3 ${top ? 'bg-red-50' : ''}`}>
                  <div className="font-mono text-gray-400 text-sm w-6 pt-1">{i + 1}</div>
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold text-sm leading-snug line-clamp-2" title={v.display}>
                      {v.display}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                      {v.channels.length > 0 ? (
                        v.channels.map((c) => (
                          <span key={c} className="text-[11px] bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded">
                            {c}
                          </span>
                        ))
                      ) : (
                        <span className="text-[11px] text-gray-400">채널 미식별</span>
                      )}
                    </div>
                    <div className="text-xs text-gray-500 mt-1.5">
                      편성 <strong className="font-mono">{v.editions}</strong>회 · {v.days}일 ·
                      프라임 <strong className="font-mono">{v.primeEditions}</strong> ·
                      {v.firstSeen.slice(5, 10)}~{v.lastSeen.slice(5, 10)}
                    </div>
                  </div>

                  {/* ggsan 소싱 */}
                  {v.ggsan ? (
                    <a
                      href={v.ggsan.detail_url ?? '#'}
                      target="_blank"
                      rel="noopener"
                      className="flex items-center gap-2 flex-shrink-0 max-w-[230px] rounded border border-gray-200 px-2 py-1.5 hover:bg-amber-50"
                      title={v.ggsan.ggsan_title}
                    >
                      <div className="w-10 h-10 bg-gray-100 rounded overflow-hidden flex-shrink-0">
                        {v.ggsan.image_url && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={v.ggsan.image_url} alt="" className="w-full h-full object-cover" loading="lazy" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="text-[11px] text-gray-700 line-clamp-2 leading-tight">
                          ggsan: {v.ggsan.ggsan_title}
                        </div>
                        <div className="text-xs font-bold">
                          {v.ggsan.price_krw ? `${v.ggsan.price_krw.toLocaleString()}원` : '가격 X'}
                          {v.ggsan.is_imminent && (
                            <span className="ml-1 text-[9px] bg-red-600 text-white px-1 rounded">임박</span>
                          )}
                        </div>
                      </div>
                    </a>
                  ) : (
                    <div className="text-[11px] text-gray-400 flex-shrink-0 pt-1">ggsan 미매칭</div>
                  )}

                  {/* 검증점수 */}
                  <div className="text-right flex-shrink-0 pl-1">
                    <div className="text-[10px] text-gray-400">검증점수</div>
                    <div className={`text-xl font-bold ${top ? 'text-red-700' : ''}`}>{v.score}</div>
                    <div className="text-[10px] text-gray-400">채널 {v.channels.length}사</div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div>
          <strong>검증점수</strong> = 채널폭(distinct 편성사) × √편성반복 × (1 + 프라임슬롯 비율). 채널 다양성에 최대 가중.
        </div>
        <div>
          <strong>의사결정:</strong> (1) <strong className="text-red-700">3사+ 반복편성 + ggsan 소싱가능</strong> 이 최상단 = 진입 확신도 최고 ·
          (2) 채널폭이 클수록 단일출처 노이즈가 아닌 프로 바이어 합의 ·
          (3) 홈쇼핑 노출가는 소매 천장(앵커) — ggsan 도매가와 마진 비교.
        </div>
      </section>
    </div>
  )
}

function Kpi({ label, value, highlight = false }: { label: string; value: number | string; highlight?: boolean }) {
  return (
    <div className={`rounded border p-3 ${highlight ? 'border-red-300 bg-red-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${highlight ? 'text-red-700' : ''}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}
