import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface RecommendRow {
  goods_no: string
  title: string
  cate_cd: string | null
  cate_label: string | null
  price_krw: number | null
  is_imminent: boolean
  image_url: string | null
  detail_url: string | null
  ggsan_last_seen: string

  tv_score: number
  search_score: number
  raw_score: number
  imminent_bonus: number
  final_score: number

  tv_match_count: number
  tv_top_keyword: string
  tv_total_pushes: number
  search_match_count: number
  search_top_keyword: string
  search_sources: string[]
}

// ─── Charm price cliff (mirrors supabase/charm_price_anchor.sql) ───
const CLIFFS = [9900, 19900, 29900, 49900, 99900] as const
type Cliff = (typeof CLIFFS)[number]
type AnchorStatus = 'safe' | 'thin' | 'underwater' | 'unknown'
const COST_KEEP_RATIO = 1 - (5.85 + 3.0 + 10.0) / 100 // platform + PG + VAT
const SHIPPING_BORNE = 3000

interface CliffAnchor {
  cliff: Cliff
  net_margin: number
  headroom_pct: number
  status: AnchorStatus
}

function computeAnchors(wholesale: number | null): CliffAnchor[] {
  return CLIFFS.map((cliff) => {
    if (wholesale == null) {
      return { cliff, net_margin: 0, headroom_pct: 0, status: 'unknown' as const }
    }
    const net = cliff * COST_KEEP_RATIO - SHIPPING_BORNE - wholesale
    const pct = (net / cliff) * 100
    const status: AnchorStatus = pct >= 20 ? 'safe' : pct >= 5 ? 'thin' : 'underwater'
    return { cliff, net_margin: Math.round(net), headroom_pct: Math.round(pct * 10) / 10, status }
  })
}

function bestAnchor(anchors: CliffAnchor[]): CliffAnchor | null {
  // 가장 낮은 cliff 중 safe → 없으면 가장 낮은 thin → 없으면 마지막(underwater)
  const safe = anchors.find((a) => a.status === 'safe')
  if (safe) return safe
  const thin = anchors.find((a) => a.status === 'thin')
  if (thin) return thin
  return anchors[anchors.length - 1] ?? null
}

const DAYS_OPTIONS = [
  { v: 7, label: '7일' },
  { v: 14, label: '14일' },
  { v: 30, label: '30일 (기본)' },
  { v: 60, label: '60일' },
] as const

const SIM_OPTIONS = [
  { v: 0.15, label: '0.15 (느슨)' },
  { v: 0.2, label: '0.20 (기본)' },
  { v: 0.3, label: '0.30 (엄격)' },
] as const

async function fetchRecommend(opts: {
  days: number
  minSim: number
  imminentOnly: boolean
  cate: string
}) {
  const sb = createAdminClient()
  // RPC는 DB(supabase/ggsan_recommend_rpc.sql)에 존재하나 generated 타입 미반영 — `npm run gen:types` 시 캐스팅 제거
  const { data, error } = await sb.rpc('jimscanner_ggsan_recommend' as never, {
    days_window: opts.days,
    min_sim: opts.minSim,
    min_score: 0.5,
    result_limit: 200,
  } as never)
  if (error) {
    return { rows: [] as RecommendRow[], error: error.message }
  }
  let rows = (data ?? []) as RecommendRow[]
  if (opts.imminentOnly) rows = rows.filter((r) => r.is_imminent)
  if (opts.cate) rows = rows.filter((r) => r.cate_cd === opts.cate)
  return { rows, error: null as string | null }
}

const CATEGORIES: { code: string; label: string }[] = [
  { code: '001', label: '장건강' },
  { code: '002', label: '눈건강' },
  { code: '003', label: '간건강' },
  { code: '005', label: '혈행건강' },
  { code: '006', label: '관절건강' },
  { code: '007', label: '면역건강' },
  { code: '008', label: '체지방' },
  { code: '009', label: '건기식기타' },
  { code: '010', label: '전통건강식품' },
  { code: '011', label: '전립선' },
  { code: '012', label: '식품분말' },
  { code: '013', label: '가공식품기타' },
  { code: '014', label: '신선식품' },
  { code: '020', label: '임박특가' },
]

function buildHref(current: Record<string, string>, override: Record<string, string | null>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/recommend' + (qs ? `?${qs}` : '')
}

function parseCliffSet(raw: string): Set<number> {
  if (!raw) return new Set()
  const set = new Set<number>()
  for (const tok of raw.split(',')) {
    const n = parseInt(tok, 10)
    if (CLIFFS.includes(n as Cliff)) set.add(n)
  }
  return set
}

function toggleCliffParam(current: Set<number>, cliff: number): string {
  const next = new Set(current)
  if (next.has(cliff)) next.delete(cliff)
  else next.add(cliff)
  return [...next].sort((a, b) => a - b).join(',')
}

function sourceLabel(s: string): string {
  switch (s) {
    case 'naver_shopping_hot': return '🛍 쇼핑hot'
    case 'naver_search_trend': return '🔍 검색트렌드'
    case 'aliex_best': return '🅰 알리'
    case 'musinsa_best': return '🅼 무신사'
    default: return s
  }
}

function statusBadgeClass(status: AnchorStatus): string {
  switch (status) {
    case 'safe': return 'bg-emerald-100 text-emerald-800 border-emerald-300'
    case 'thin': return 'bg-amber-100 text-amber-800 border-amber-300'
    case 'underwater': return 'bg-rose-100 text-rose-800 border-rose-300'
    default: return 'bg-gray-100 text-gray-600 border-gray-300'
  }
}

function statusLabel(status: AnchorStatus): string {
  switch (status) {
    case 'safe': return 'SAFE'
    case 'thin': return 'THIN'
    case 'underwater': return 'UNDER'
    default: return '—'
  }
}

function barColor(status: AnchorStatus): string {
  switch (status) {
    case 'safe': return 'bg-emerald-500'
    case 'thin': return 'bg-amber-500'
    case 'underwater': return 'bg-rose-400'
    default: return 'bg-gray-300'
  }
}

export default async function RecommendPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; sim?: string; imminent?: string; cate?: string; cliffs?: string }>
}) {
  const sp = await searchParams
  const days = parseInt(sp.days ?? '30', 10)
  const validDays = DAYS_OPTIONS.some((d) => d.v === days) ? days : 30
  const sim = parseFloat(sp.sim ?? '0.2')
  const validSim = SIM_OPTIONS.some((s) => Math.abs(s.v - sim) < 0.001) ? sim : 0.2
  const imminentOnly = sp.imminent === '1'
  const cate = sp.cate ?? ''
  const cliffsParam = sp.cliffs ?? ''
  const cliffFilter = parseCliffSet(cliffsParam)

  const current: Record<string, string> = {
    days: String(validDays),
    sim: String(validSim),
    imminent: imminentOnly ? '1' : '',
    cate,
    cliffs: cliffsParam,
  }

  const { rows: rawRows, error } = await fetchRecommend({ days: validDays, minSim: validSim, imminentOnly, cate })

  // anchors 계산
  const rowsWithAnchors = rawRows.map((r) => {
    const anchors = computeAnchors(r.price_krw)
    return { row: r, anchors, best: bestAnchor(anchors) }
  })

  // cliff 필터: 선택된 cliff 중 최소 하나가 safe/thin 인 SKU 만 통과
  const rows = cliffFilter.size === 0
    ? rowsWithAnchors
    : rowsWithAnchors.filter((x) =>
        x.anchors.some((a) => cliffFilter.has(a.cliff) && (a.status === 'safe' || a.status === 'thin'))
      )

  // KPI
  const total = rows.length
  const imminentCount = rows.filter((x) => x.row.is_imminent).length
  const safeCount = rows.filter((x) => x.best?.status === 'safe').length
  const underwaterCount = rows.filter((x) => x.best?.status === 'underwater').length
  const avgFinal = rows.length > 0 ? rows.reduce((s, x) => s + Number(x.row.final_score), 0) / rows.length : 0

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">⭐ 위탁 후보 추천 (V0)</h1>
          <p className="text-sm text-gray-500 mt-1">
            ggsan 도매 카탈로그 × TV 편성 시그널 × 검색·쇼핑 시그널 — 임박특가 보너스 적용 · <strong>가격절벽 헤드룸 매핑</strong>
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 알림: V0 한계 */}
      <div className="rounded border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
        <strong>V0 한계</strong> · 스마트스토어·쿠팡 경쟁 데이터 부재로 saturation_penalty 미적용.
        커뮤니티 시그널은 LLM 정규화 후 V1에 포함 예정. 현재 점수는 <strong>수요 강도만</strong> 반영.
        Cliff 헤드룸은 네이버 스마트스토어 가정 (플랫폼 5.85%+PG 3%+VAT 10%, 배송비 부담 ₩3,000).
      </div>

      {/* 필터 */}
      <div className="rounded border border-gray-200 px-4 py-3 space-y-3">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">기간</span>
            {DAYS_OPTIONS.map((d) => (
              <Link
                key={d.v}
                href={buildHref(current, { days: String(d.v) })}
                className={`px-2 py-1 text-xs rounded ${validDays === d.v ? 'bg-amber-100 text-amber-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
              >
                {d.label}
              </Link>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">유사도 ≥</span>
            {SIM_OPTIONS.map((s) => (
              <Link
                key={s.v}
                href={buildHref(current, { sim: String(s.v) })}
                className={`px-2 py-1 text-xs rounded ${Math.abs(validSim - s.v) < 0.001 ? 'bg-amber-100 text-amber-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
              >
                {s.label}
              </Link>
            ))}
          </div>
          <Link
            href={buildHref(current, { imminent: imminentOnly ? null : '1' })}
            className={`px-3 py-1 text-xs rounded ${imminentOnly ? 'bg-red-100 text-red-700 font-semibold' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
          >
            {imminentOnly ? '✓ ' : ''}임박특가만
          </Link>
        </div>

        {/* Cliff 필터 (다중 선택) */}
        <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 pt-2">
          <span className="text-xs text-gray-500">절벽 안착 가능</span>
          {CLIFFS.map((c) => {
            const active = cliffFilter.has(c)
            const next = toggleCliffParam(cliffFilter, c)
            return (
              <Link
                key={c}
                href={buildHref(current, { cliffs: next || null })}
                className={`px-2 py-1 text-xs rounded border ${
                  active
                    ? 'bg-emerald-100 text-emerald-800 border-emerald-300 font-semibold'
                    : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'
                }`}
              >
                {active ? '✓ ' : ''}₩{c.toLocaleString()}
              </Link>
            )
          })}
          {cliffFilter.size > 0 && (
            <Link
              href={buildHref(current, { cliffs: null })}
              className="px-2 py-1 text-xs rounded text-gray-500 hover:text-black underline"
            >
              초기화
            </Link>
          )}
        </div>

        <div className="flex flex-wrap gap-1 border-t border-gray-100 pt-2">
          <Link
            href={buildHref(current, { cate: null })}
            className={`px-2 py-1 text-xs rounded ${cate === '' ? 'bg-black text-white font-semibold' : 'text-gray-500 hover:text-black'}`}
          >
            전체
          </Link>
          {CATEGORIES.map((c) => (
            <Link
              key={c.code}
              href={buildHref(current, { cate: c.code })}
              className={`px-2 py-1 text-xs rounded ${cate === c.code ? 'bg-black text-white font-semibold' : 'text-gray-500 hover:text-black'}`}
            >
              {c.label}
            </Link>
          ))}
        </div>
      </div>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Kpi label="후보 상품" value={total} />
        <Kpi label="🔥 임박특가" value={imminentCount} highlight={imminentCount > 0} />
        <Kpi label="🟢 SAFE 안착" value={safeCount} />
        <Kpi label="🔴 UNDER (전 절벽 손실)" value={underwaterCount} />
        <Kpi label="평균 final_score" value={avgFinal.toFixed(2)} />
      </section>

      {/* 에러 */}
      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          RPC 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            RPC <code>jimscanner_ggsan_recommend</code> 가 DB에 적용 안 됐을 가능성. supabase/ggsan_recommend_rpc.sql 적용 필요.
          </p>
        </div>
      )}

      {/* 결과 카드 */}
      {!error && rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">조건에 맞는 후보 없음</div>
          <div className="text-xs text-gray-400">
            데이터 부족 가능성: 1) WSL cron 죽음 (sources 페이지 확인) · 2) trends_keywords 가 1일치 미만 누적
            <br />
            min_sim 을 0.15 로 낮추거나 days 60 으로 늘려보기. cliff 필터를 풀어도 됨.
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map(({ row: r, anchors, best }, i) => (
            <a
              key={r.goods_no}
              href={r.detail_url ?? '#'}
              target="_blank"
              rel="noopener"
              className={`block rounded border overflow-hidden hover:shadow-sm transition-all ${
                r.is_imminent
                  ? 'border-red-200 bg-red-50/40 hover:bg-red-50'
                  : 'border-gray-200 hover:bg-gray-50'
              }`}
            >
              <div className="flex items-start gap-3 p-3">
                {/* 순위 */}
                <div className="w-8 text-center text-sm font-mono text-gray-400 pt-1">
                  {i + 1}
                </div>

                {/* 이미지 */}
                <div className="w-20 h-20 bg-gray-100 rounded overflow-hidden flex-shrink-0 relative">
                  {r.image_url && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={r.image_url} alt="" loading="lazy" className="w-full h-full object-cover" />
                  )}
                  {r.is_imminent && (
                    <span className="absolute top-0 left-0 bg-red-600 text-white text-[9px] px-1 leading-tight rounded-br">
                      임박
                    </span>
                  )}
                </div>

                {/* 본문 */}
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="text-sm font-medium leading-snug" title={r.title}>
                    {r.title}
                  </div>
                  <div className="text-xs text-gray-500">
                    {r.cate_label ?? r.cate_cd} · {r.goods_no}
                  </div>
                  {/* 매칭 근거 */}
                  <div className="flex flex-wrap gap-2 text-xs pt-1">
                    {r.tv_match_count > 0 && (
                      <span className="bg-amber-100 text-amber-800 px-2 py-0.5 rounded">
                        📺 TV {r.tv_match_count}건 · &quot;{r.tv_top_keyword}&quot; ({r.tv_total_pushes}회 편성)
                      </span>
                    )}
                    {r.search_match_count > 0 && (
                      <span className="bg-blue-100 text-blue-800 px-2 py-0.5 rounded">
                        🔍 검색 {r.search_match_count}건 · &quot;{r.search_top_keyword}&quot;
                      </span>
                    )}
                    {r.search_sources.length > 0 && (
                      <span className="text-gray-500">
                        from {r.search_sources.map(sourceLabel).join(', ')}
                      </span>
                    )}
                  </div>

                  {/* Cliff 헤드룸 미니차트 */}
                  <CliffStrip anchors={anchors} wholesale={r.price_krw} />
                </div>

                {/* 점수 + 가격 + best cliff */}
                <div className="text-right flex-shrink-0 space-y-1 w-40">
                  <div className="text-base font-bold">
                    {r.price_krw ? `${r.price_krw.toLocaleString()}원` : <span className="text-gray-400 text-xs">가격 X</span>}
                  </div>
                  {best && (
                    <div className={`inline-block text-[10px] font-mono px-2 py-0.5 rounded border ${statusBadgeClass(best.status)}`}>
                      ₩{best.cliff.toLocaleString()} · {statusLabel(best.status)}
                      {best.status !== 'unknown' && (
                        <span className="ml-1 opacity-70">({best.headroom_pct > 0 ? '+' : ''}{best.headroom_pct}%)</span>
                      )}
                    </div>
                  )}
                  <div className="text-2xl font-bold font-mono text-amber-700">
                    {Number(r.final_score).toFixed(1)}
                  </div>
                  <div className="text-[10px] text-gray-500 font-mono space-y-0.5">
                    <div>TV {Number(r.tv_score).toFixed(2)} × 1.5</div>
                    <div>검색 {Number(r.search_score).toFixed(2)} × 1.0</div>
                    {r.is_imminent && <div className="text-red-600">× 1.3 (임박)</div>}
                  </div>
                </div>
              </div>
            </a>
          ))}
        </div>
      )}

      {/* 공식 설명 */}
      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-2">
        <div className="font-semibold text-gray-700">📐 ProductScore V0 공식</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          final_score = (tv_score × 1.5 + search_score × 1.0) × imminent_bonus
          <br />
          tv_score = Σ (tv_count × similarity(tv_keyword, ggsan_title))
          <br />
          search_score = Σ (occurrences × similarity(search_keyword, ggsan_title))
          <br />
          imminent_bonus = is_imminent ? 1.3 : 1.0
        </code>

        <div className="font-semibold text-gray-700 pt-2">💸 Charm Price Cliff 헤드룸 공식</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          net = cliff × (1 − 5.85% − 3% − 10%) − ₩3,000 배송 − 도매가
          <br />
          headroom_pct = net / cliff × 100
          <br />
          status = headroom_pct ≥ 20 ? &apos;safe&apos; : ≥ 5 ? &apos;thin&apos; : &apos;underwater&apos;
        </code>

        <div className="pt-2">
          <strong>V1 보강 예정:</strong> ÷ (1 + log(스마트스토어 등록상품수)) saturation_penalty · 커뮤니티 시그널 LLM 정규화 후 추가 · ggsan_price_history 가격 인하 추세 보너스 · 동 카테고리 SERP 가격 modal bin 으로 distance-to-cliff 표시
        </div>
      </section>
    </div>
  )
}

function CliffStrip({ anchors, wholesale }: { anchors: CliffAnchor[]; wholesale: number | null }) {
  if (wholesale == null) {
    return <div className="text-[10px] text-gray-400 pt-1">cliff: 도매가 없음</div>
  }
  // 각 cliff 별 가로 막대: 막대 길이 = headroom_pct (음수면 0) · 색상 = status
  const maxPct = Math.max(40, ...anchors.map((a) => Math.max(0, a.headroom_pct)))
  return (
    <div className="flex items-center gap-1 pt-1.5">
      {anchors.map((a) => {
        const widthPct = Math.max(2, Math.min(100, (Math.max(0, a.headroom_pct) / maxPct) * 100))
        return (
          <div key={a.cliff} className="flex-1 group relative" title={`₩${a.cliff.toLocaleString()} · ${a.headroom_pct}% · net ₩${a.net_margin.toLocaleString()} · ${a.status}`}>
            <div className="text-[9px] text-gray-500 font-mono leading-tight mb-0.5">
              ₩{(a.cliff / 1000).toFixed(a.cliff >= 10000 ? 0 : 1)}k
            </div>
            <div className="h-2 bg-gray-100 rounded-sm overflow-hidden relative">
              <div
                className={`h-full ${barColor(a.status)}`}
                style={{ width: `${widthPct}%` }}
              />
            </div>
            <div className={`text-[9px] font-mono leading-tight mt-0.5 ${
              a.status === 'safe' ? 'text-emerald-700'
              : a.status === 'thin' ? 'text-amber-700'
              : 'text-rose-600'
            }`}>
              {a.headroom_pct > 0 ? '+' : ''}{a.headroom_pct}%
            </div>
          </div>
        )
      })}
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
