import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// ── 출처 = 인구집단 사전 (docs/source-persona-map.md 와 동기화) ──
// personaKey 로 여러 source 를 한 집단에 합산할 수 있다.
interface Persona {
  key: string
  label: string
  emoji: string
  demo: string // 연령·성별
  motive: string // 구매 동기 / 소구 앵글
  channel: string // 추천 판매·광고 채널
  color: string // tailwind 칩 색
}

const SOURCE_PERSONA: Record<string, Persona> = {
  '82cook_talk': {
    key: 'housewife',
    label: '살림·육아 주부',
    emoji: '🍳',
    demo: '3050 기혼여성',
    motive: '가족건강·살림 실용',
    channel: '네이버 카페/블로그·인스타',
    color: 'bg-rose-100 text-rose-800',
  },
  natepan_ranking: {
    key: 'issue_women',
    label: '이슈·공감형',
    emoji: '💬',
    demo: '2040 여성',
    motive: '화제성·후기 공감',
    channel: '인스타·블로그 체험단',
    color: 'bg-pink-100 text-pink-800',
  },
  musinsa_best: {
    key: 'fashion',
    label: '패션 트렌드세터',
    emoji: '🧥',
    demo: '2030 남녀',
    motive: '스타일·트렌드',
    channel: '인스타·무신사·당근',
    color: 'bg-violet-100 text-violet-800',
  },
  dcinside_realtime: {
    key: 'hobby',
    label: '취미·매니아',
    emoji: '🎮',
    demo: '1030',
    motive: '덕질·스펙·가성비',
    channel: '커뮤니티·유튜브',
    color: 'bg-emerald-100 text-emerald-800',
  },
  ppomppu_main: {
    key: 'deal',
    label: '핫딜·가성비',
    emoji: '💸',
    demo: '3050 남성',
    motive: '최저가·가성비',
    channel: '쿠팡·뽐뿌·가격비교',
    color: 'bg-amber-100 text-amber-800',
  },
  naver_tvtime: {
    key: 'tv',
    label: 'TV 홈쇼핑 시청자',
    emoji: '📺',
    demo: '4060',
    motive: '방송효과·신뢰',
    channel: '홈쇼핑·네이버쇼핑',
    color: 'bg-orange-100 text-orange-800',
  },
  aliex_best: {
    key: 'early',
    label: '얼리어답터·초저가',
    emoji: '🅰',
    demo: '2040',
    motive: '신기템·초저가',
    channel: '쿠팡·스마트스토어',
    color: 'bg-cyan-100 text-cyan-800',
  },
  naver_shopping_hot: {
    key: 'search',
    label: '검색 실수요',
    emoji: '🔍',
    demo: '전연령',
    motive: '실수요·비교구매',
    channel: '네이버쇼핑·쿠팡',
    color: 'bg-blue-100 text-blue-800',
  },
  naver_search_trend: {
    key: 'search',
    label: '검색 실수요',
    emoji: '🔍',
    demo: '전연령',
    motive: '실수요·정보탐색',
    channel: '네이버쇼핑·쿠팡',
    color: 'bg-blue-100 text-blue-800',
  },
}

const UNKNOWN_PERSONA: Persona = {
  key: 'unknown',
  label: '미분류',
  emoji: '❔',
  demo: '—',
  motive: '—',
  channel: '범용(네이버쇼핑·쿠팡)',
  color: 'bg-gray-100 text-gray-600',
}

interface SourceCnt {
  source: string
  cnt: number
}

interface AudienceRow {
  product_id: string
  canonical_name: string
  category_top: string
  category_mid: string | null
  brand: string | null
  intent_label: string | null
  description: string | null
  alias_count: number
  last_seen_at: string
  distinct_sources: number
  total_alias_hits: number
  sources: SourceCnt[]
}

// 상품 1개의 source set → 페르소나 가중치 합산 + 분류
interface PersonaWeight {
  persona: Persona
  weight: number
  share: number
}
interface Analyzed {
  row: AudienceRow
  weights: PersonaWeight[]
  topPersona: Persona
  topShare: number
  isClearTarget: boolean // 타겟 명확형 vs 광범위형
}

function analyze(row: AudienceRow): Analyzed {
  const byKey = new Map<string, PersonaWeight>()
  let totalWeight = 0
  for (const sc of row.sources ?? []) {
    const p = SOURCE_PERSONA[sc.source] ?? UNKNOWN_PERSONA
    totalWeight += sc.cnt
    const existing = byKey.get(p.key)
    if (existing) existing.weight += sc.cnt
    else byKey.set(p.key, { persona: p, weight: sc.cnt, share: 0 })
  }
  const weights = [...byKey.values()].sort((a, b) => b.weight - a.weight)
  for (const w of weights) w.share = totalWeight > 0 ? w.weight / totalWeight : 0

  const top = weights[0]
  const topPersona = top?.persona ?? UNKNOWN_PERSONA
  const topShare = top?.share ?? 0
  // 타겟 명확형: 최상위 페르소나 비중 ≥ 60% 이고 페르소나 종류 ≤ 2
  const realPersonaCount = weights.filter((w) => w.persona.key !== 'unknown').length
  const isClearTarget = topShare >= 0.6 && realPersonaCount <= 2 && topPersona.key !== 'unknown'

  return { row, weights, topPersona, topShare, isClearTarget }
}

async function fetchAudience(days: number) {
  const sb = createAdminClient()
  // RPC 는 DB(supabase/audience_persona_rpc.sql)에 존재하나 generated 타입 미반영 — gen:types 시 캐스팅 제거
  const { data, error } = await sb.rpc('jimscanner_trends_audience' as never, {
    days_window: days,
    result_limit: 300,
  } as never)
  if (error) return { rows: [] as AudienceRow[], error: error.message }
  return { rows: (data ?? []) as AudienceRow[], error: null as string | null }
}

const DAYS_OPTIONS = [
  { v: 7, label: '7일' },
  { v: 14, label: '14일' },
  { v: 30, label: '30일' },
  { v: 60, label: '60일 (기본)' },
] as const

const TYPE_OPTIONS = [
  { v: '', label: '전체' },
  { v: 'clear', label: '🎯 타겟 명확형' },
  { v: 'broad', label: '🌐 광범위형' },
] as const

function buildHref(current: Record<string, string>, override: Record<string, string | null>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/audience' + (qs ? `?${qs}` : '')
}

export default async function AudiencePage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; type?: string; persona?: string }>
}) {
  const sp = await searchParams
  const days = parseInt(sp.days ?? '60', 10)
  const validDays = DAYS_OPTIONS.some((d) => d.v === days) ? days : 60
  const typeFilter = sp.type === 'clear' || sp.type === 'broad' ? sp.type : ''
  const personaFilter = sp.persona ?? ''

  const current: Record<string, string> = {
    days: String(validDays),
    type: typeFilter,
    persona: personaFilter,
  }

  const { rows, error } = await fetchAudience(validDays)
  const analyzed = rows.map(analyze)

  // 페르소나별 전역 집계 (칩 필터용)
  const personaTotals = new Map<string, { persona: Persona; products: number }>()
  for (const a of analyzed) {
    const seen = new Set<string>()
    for (const w of a.weights) {
      if (w.persona.key === 'unknown' || seen.has(w.persona.key)) continue
      seen.add(w.persona.key)
      const t = personaTotals.get(w.persona.key)
      if (t) t.products += 1
      else personaTotals.set(w.persona.key, { persona: w.persona, products: 1 })
    }
  }
  const personaList = [...personaTotals.values()].sort((a, b) => b.products - a.products)

  // 필터 적용
  let filtered = analyzed
  if (typeFilter === 'clear') filtered = filtered.filter((a) => a.isClearTarget)
  if (typeFilter === 'broad') filtered = filtered.filter((a) => !a.isClearTarget)
  if (personaFilter) filtered = filtered.filter((a) => a.weights.some((w) => w.persona.key === personaFilter))

  const clearCount = analyzed.filter((a) => a.isClearTarget).length
  const broadCount = analyzed.length - clearCount

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">👥 커뮤니티 출처 → 페르소나 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            상품이 <strong>어느 커뮤니티에서 떴는가</strong>로 타겟 고객·구매동기·판매 채널을 역추정
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <div className="rounded border border-indigo-200 bg-indigo-50 px-4 py-3 text-xs text-indigo-900">
        출처=인구집단 사전은 <code>docs/source-persona-map.md</code> 참고. 출처별 alias 등장 횟수를
        페르소나로 합산 → <strong>타겟 명확형</strong>(단일 집단 ≥60%)과 <strong>광범위형</strong>(다집단 분산)으로 분리.
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
                className={`px-2 py-1 text-xs rounded ${validDays === d.v ? 'bg-indigo-100 text-indigo-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
              >
                {d.label}
              </Link>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">유형</span>
            {TYPE_OPTIONS.map((t) => (
              <Link
                key={t.v || 'all'}
                href={buildHref(current, { type: t.v || null })}
                className={`px-2 py-1 text-xs rounded ${typeFilter === t.v ? 'bg-black text-white font-semibold' : 'text-gray-500 hover:text-black'}`}
              >
                {t.label}
              </Link>
            ))}
          </div>
        </div>
        {personaList.length > 0 && (
          <div className="flex flex-wrap gap-1 border-t border-gray-100 pt-2">
            <Link
              href={buildHref(current, { persona: null })}
              className={`px-2 py-1 text-xs rounded ${personaFilter === '' ? 'bg-black text-white font-semibold' : 'text-gray-500 hover:text-black'}`}
            >
              전체 페르소나
            </Link>
            {personaList.map((p) => (
              <Link
                key={p.persona.key}
                href={buildHref(current, { persona: p.persona.key })}
                className={`px-2 py-1 text-xs rounded ${personaFilter === p.persona.key ? 'ring-2 ring-offset-1 ring-black ' + p.persona.color : p.persona.color + ' opacity-80 hover:opacity-100'}`}
              >
                {p.persona.emoji} {p.persona.label} ({p.products})
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="출처 보유 상품" value={analyzed.length} />
        <Kpi label="🎯 타겟 명확형" value={clearCount} highlight={clearCount > 0} />
        <Kpi label="🌐 광범위형" value={broadCount} />
        <Kpi label="식별 페르소나" value={personaList.length} />
      </section>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          RPC 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            RPC <code>jimscanner_trends_audience</code> 미적용 가능성. supabase/audience_persona_rpc.sql 적용 필요.
          </p>
        </div>
      )}

      {!error && filtered.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">조건에 맞는 상품 없음</div>
          <div className="text-xs text-gray-400">
            커뮤니티 source 가 누적된 alias 가 아직 적을 수 있음. 기간을 60일로 늘려보기.
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((a) => (
            <div
              key={a.row.product_id}
              className={`rounded border p-3 ${
                a.isClearTarget ? 'border-indigo-200 bg-indigo-50/40' : 'border-gray-200'
              }`}
            >
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Link
                      href={`/admin/trend-radar/products/${a.row.product_id}`}
                      className="text-sm font-semibold hover:underline"
                    >
                      {a.row.canonical_name}
                    </Link>
                    {a.isClearTarget ? (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-600 text-white font-medium">
                        🎯 타겟 명확
                      </span>
                    ) : (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-200 text-gray-700 font-medium">
                        🌐 광범위
                      </span>
                    )}
                    {a.row.intent_label && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">
                        🏷 {a.row.intent_label}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-gray-500">
                    {a.row.brand ? `${a.row.brand} · ` : ''}
                    {a.row.category_top}
                    {a.row.category_mid ? ` / ${a.row.category_mid}` : ''} · alias {a.row.alias_count}건 · 출처{' '}
                    {a.row.distinct_sources}종
                  </div>

                  {/* 페르소나 칩 + 소구/채널 */}
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {a.weights.map((w) => (
                      <span
                        key={w.persona.key + w.persona.label}
                        className={`text-xs px-2 py-0.5 rounded ${w.persona.color}`}
                        title={`${w.persona.demo} · 동기 ${w.persona.motive} · 채널 ${w.persona.channel}`}
                      >
                        {w.persona.emoji} {w.persona.label} {Math.round(w.share * 100)}%
                      </span>
                    ))}
                  </div>

                  {/* 추천 액션 (최상위 페르소나 기준) */}
                  {a.topPersona.key !== 'unknown' && (
                    <div className="text-[11px] text-gray-600 pt-1">
                      <span className="text-gray-400">소구 앵글</span> {a.topPersona.motive}{' '}
                      <span className="text-gray-300">·</span>{' '}
                      <span className="text-gray-400">채널</span> {a.topPersona.channel}{' '}
                      <span className="text-gray-300">·</span>{' '}
                      <span className="text-gray-400">타겟</span> {a.topPersona.demo}
                    </div>
                  )}

                  {/* raw source 펼침 */}
                  <div className="text-[10px] text-gray-400 font-mono pt-0.5">
                    {(a.row.sources ?? []).map((s) => `${s.source}×${s.cnt}`).join('  ·  ')}
                  </div>
                </div>

                <div className="text-right flex-shrink-0">
                  <div className="text-2xl font-bold font-mono text-indigo-700">{a.row.total_alias_hits}</div>
                  <div className="text-[10px] text-gray-400">출처 hit</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 사전 범례 */}
      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-2">
        <div className="font-semibold text-gray-700">📖 출처 → 페르소나 사전</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-1">
          {Object.entries(SOURCE_PERSONA).map(([src, p]) => (
            <div key={src} className="flex items-center gap-2">
              <code className="text-[10px] text-gray-400 w-36 shrink-0">{src}</code>
              <span className={`text-[11px] px-1.5 py-0.5 rounded ${p.color}`}>
                {p.emoji} {p.label}
              </span>
              <span className="text-[11px] text-gray-500 truncate">
                {p.demo} · {p.motive} · {p.channel}
              </span>
            </div>
          ))}
        </div>
        <div className="text-gray-400 pt-1">
          분류: 최상위 페르소나 비중 ≥ 60% &amp; 페르소나 종류 ≤ 2 → 타겟 명확형. 상세: docs/source-persona-map.md
        </div>
      </section>
    </div>
  )
}

function Kpi({ label, value, highlight = false }: { label: string; value: number | string; highlight?: boolean }) {
  return (
    <div className={`rounded border p-3 ${highlight ? 'border-indigo-300 bg-indigo-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${highlight ? 'text-indigo-700' : ''}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}
