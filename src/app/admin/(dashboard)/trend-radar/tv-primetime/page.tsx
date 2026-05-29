import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// ── 골든타임 가중 MD 확신도 보드 ───────────────────────────────
// jimscanner_tv_primetime_conviction RPC (슬롯 시각 가중 점수화) +
// jimscanner_tv_ggsan_match RPC (도매 매칭) 를 조인해
// "골든타임 고확신 × 도매가능 = 선제소싱 1순위" 사분면을 그린다.

interface ConvictionRow {
  keyword: string
  slot_count: number
  conviction: number
  prime_count: number
  prime_share: number
  repeat_days: number
  distinct_slots: number
  first_seen: string
  last_seen: string
  top_slot: string | null
  top_slot_hour: number | null
}

interface MatchRow {
  keyword: string
  goods_no: string
  ggsan_title: string
  price_krw: number | null
  is_imminent: boolean
  detail_url: string | null
  sim: number
}

const DAYS_OPTIONS = [
  { v: 7, label: '7일' },
  { v: 14, label: '14일' },
  { v: 30, label: '30일' },
] as const

async function fetchConviction(days: number): Promise<ConvictionRow[]> {
  const sb = createAdminClient()
  // 신규 RPC — 생성된 타입에 아직 없어 캐스팅
  const { data, error } = await (sb.rpc as any)('jimscanner_tv_primetime_conviction', {
    days_window: days,
  })
  if (error) {
    console.error('primetime rpc error', error)
    return []
  }
  return (data ?? []) as ConvictionRow[]
}

async function fetchGgsanMatches(days: number): Promise<Map<string, { hasImminent: boolean; best: MatchRow }>> {
  const sb = createAdminClient()
  const { data, error } = await (sb.rpc as any)('jimscanner_tv_ggsan_match', {
    days_window: days,
    min_sim: 0.2,
    per_keyword_limit: 3,
    result_limit: 500,
  })
  const map = new Map<string, { hasImminent: boolean; best: MatchRow }>()
  if (error) {
    console.error('ggsan rpc error', error)
    return map
  }
  for (const r of (data ?? []) as MatchRow[]) {
    const cur = map.get(r.keyword)
    if (!cur) {
      map.set(r.keyword, { hasImminent: r.is_imminent, best: r })
    } else {
      if (r.is_imminent) cur.hasImminent = true
      if (r.sim > cur.best.sim) cur.best = r
    }
  }
  return map
}

// top_slot(HH:MM) 기준 지금부터 다음 방영까지 카운트다운 (KST 가정, 데이터가 KST 슬롯)
function nextShowLabel(topSlot: string | null): string {
  if (!topSlot) return '—'
  const [h, m] = topSlot.split(':').map((x) => parseInt(x, 10))
  if (Number.isNaN(h) || Number.isNaN(m)) return topSlot
  const now = new Date()
  const target = new Date(now)
  target.setHours(h, m, 0, 0)
  if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1)
  const diffMin = Math.round((target.getTime() - now.getTime()) / 60000)
  const hh = Math.floor(diffMin / 60)
  const mm = diffMin % 60
  return hh > 0 ? `${hh}시간 ${mm}분 후` : `${mm}분 후`
}

function slotBadge(hour: number | null): { label: string; cls: string } {
  if (hour == null) return { label: '?', cls: 'bg-gray-100 text-gray-500' }
  if (hour >= 18 && hour <= 23) return { label: '프라임', cls: 'bg-red-100 text-red-700' }
  if (hour >= 0 && hour <= 6) return { label: '새벽', cls: 'bg-gray-100 text-gray-500' }
  return { label: '주간', cls: 'bg-amber-100 text-amber-700' }
}

export default async function TvPrimetimePage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>
}) {
  const sp = await searchParams
  const daysRaw = parseInt(sp.days ?? '14', 10)
  const days = DAYS_OPTIONS.some((d) => d.v === daysRaw) ? daysRaw : 14

  const [rows, matchMap] = await Promise.all([
    fetchConviction(days),
    fetchGgsanMatches(days),
  ])

  // 사분면 분류용 임계값: 확신도 중앙값 / ggsan 매칭 여부
  const convictions = rows.map((r) => r.conviction).sort((a, b) => a - b)
  const median =
    convictions.length > 0 ? convictions[Math.floor(convictions.length / 2)] : 0
  const maxConv = Math.max(1, ...rows.map((r) => r.conviction))

  const enriched = rows.map((r) => {
    const match = matchMap.get(r.keyword)
    const highConv = r.conviction >= median && median > 0
    const sourceable = !!match
    return {
      ...r,
      hasMatch: sourceable,
      hasImminent: match?.hasImminent ?? false,
      bestMatch: match?.best ?? null,
      quadrant:
        highConv && sourceable
          ? 'q1' // 선제소싱 1순위
          : highConv
            ? 'q2' // 고확신·도매미발견
            : sourceable
              ? 'q3' // 도매가능·저확신
              : 'q4',
    }
  })

  const q1 = enriched.filter((e) => e.quadrant === 'q1')
  const primeKw = enriched.filter((e) => e.prime_share >= 0.5).length
  const sourceableKw = enriched.filter((e) => e.hasMatch).length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">TV 골든타임 확신도 — 선제소싱 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            홈쇼핑 MD 가 황금시간대(18~23시)에 반복 배정한 슬롯 = <strong>검증된 고확신 수요</strong>.
            방영 전 선제 소싱 윈도우를 만든다.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 기간 필터 */}
      <div className="flex flex-wrap items-center gap-3 rounded border border-gray-200 px-4 py-3">
        <span className="text-xs text-gray-500">기간</span>
        {DAYS_OPTIONS.map((d) => (
          <Link
            key={d.v}
            href={`/admin/trend-radar/tv-primetime?days=${d.v}`}
            className={`px-2 py-1 text-xs rounded ${
              days === d.v
                ? 'bg-amber-100 text-amber-700 font-semibold'
                : 'text-gray-500 hover:text-black'
            }`}
          >
            {d.label}
          </Link>
        ))}
        <span className="ml-auto text-xs text-gray-400">
          가중치 프라임(18~23시)=1.0 · 주간=0.5 · 새벽(0~6시)=0.15
        </span>
      </div>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="스코어된 상품" value={enriched.length} />
        <Kpi label="프라임 우세 (share ≥ 50%)" value={primeKw} />
        <Kpi label="도매 매칭 가능" value={sourceableKw} />
        <Kpi label="🎯 선제소싱 1순위" value={q1.length} highlight={q1.length > 0} />
      </section>

      {/* 사분면 — 가로축 확신도 × 세로축 도매 매칭여부 */}
      <section>
        <h2 className="text-sm font-semibold mb-2">
          선제소싱 사분면{' '}
          <span className="text-xs font-normal text-gray-500">
            (→ 확신도 / ↑ 도매 매칭 · 중앙값 {median.toFixed(1)} 기준)
          </span>
        </h2>
        <div className="relative rounded border border-gray-200 bg-gray-50/60 h-80 overflow-hidden">
          {/* 사분면 라벨 */}
          <div className="absolute top-2 left-2 text-[11px] text-gray-400">도매가능 · 저확신</div>
          <div className="absolute top-2 right-2 text-[11px] text-red-500 font-semibold">
            🎯 골든타임 고확신 × 도매가능 = 선제소싱 1순위
          </div>
          <div className="absolute bottom-2 left-2 text-[11px] text-gray-400">저확신 · 도매미발견</div>
          <div className="absolute bottom-2 right-2 text-[11px] text-gray-400">고확신 · 도매미발견</div>
          {/* 십자선 */}
          <div className="absolute left-1/2 top-0 bottom-0 border-l border-dashed border-gray-300" />
          <div className="absolute top-1/2 left-0 right-0 border-t border-dashed border-gray-300" />
          {/* 점 */}
          {enriched.map((e) => {
            const x = (e.conviction / maxConv) * 96 + 2 // 2~98%
            const y = e.hasMatch
              ? 8 + (e.hasImminent ? 0 : 18) // 상단 영역
              : 62 + (e.prime_share >= 0.5 ? 0 : 16) // 하단 영역
            const isQ1 = e.quadrant === 'q1'
            return (
              <div
                key={e.keyword}
                className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-full ${
                  isQ1 ? 'bg-red-500' : e.hasMatch ? 'bg-amber-500' : 'bg-gray-400'
                }`}
                style={{
                  left: `${x}%`,
                  top: `${y + 6}%`,
                  width: isQ1 ? 12 : 8,
                  height: isQ1 ? 12 : 8,
                  opacity: isQ1 ? 0.95 : 0.6,
                }}
                title={`${e.keyword} · 확신도 ${e.conviction.toFixed(1)} · 프라임 ${(e.prime_share * 100).toFixed(0)}%${e.hasMatch ? ' · 도매O' : ''}`}
              />
            )
          })}
        </div>
        <div className="text-xs text-gray-500 mt-2 flex gap-4">
          <span><span className="inline-block w-3 h-3 rounded-full bg-red-500 align-middle mr-1" />선제소싱 1순위</span>
          <span><span className="inline-block w-3 h-3 rounded-full bg-amber-500 align-middle mr-1" />도매 매칭 있음</span>
          <span><span className="inline-block w-3 h-3 rounded-full bg-gray-400 align-middle mr-1" />도매 미발견</span>
        </div>
      </section>

      {/* 확신도 랭킹 테이블 */}
      <section>
        <h2 className="text-sm font-semibold mb-2">
          MD 확신도 랭킹 <span className="text-xs font-normal text-gray-500">(상위 100 · 골든타임 가중 합)</span>
        </h2>
        {enriched.length === 0 ? (
          <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
            <div>아직 슬롯 데이터 없음</div>
            <div className="text-xs text-gray-400">
              매일 KST 04:10 + 17:10 자동 수집. 며칠 누적 후 확신도가 분리됩니다.
            </div>
          </div>
        ) : (
          <div className="rounded border border-gray-200 divide-y divide-gray-100">
            <div className="grid grid-cols-12 text-xs text-gray-500 px-3 py-2 bg-gray-50">
              <div className="col-span-1">#</div>
              <div className="col-span-4">상품명</div>
              <div className="col-span-1 text-right">확신도</div>
              <div className="col-span-1 text-right">프라임%</div>
              <div className="col-span-1 text-right">반복일</div>
              <div className="col-span-2 text-right">다음 방영</div>
              <div className="col-span-2 text-right">도매</div>
            </div>
            {enriched.slice(0, 100).map((e, i) => {
              const badge = slotBadge(e.top_slot_hour)
              return (
                <div
                  key={e.keyword}
                  className={`grid grid-cols-12 px-3 py-2 text-sm items-center ${
                    e.quadrant === 'q1' ? 'bg-red-50' : ''
                  }`}
                >
                  <div className="col-span-1 font-mono text-gray-400">{i + 1}</div>
                  <div className="col-span-4 truncate" title={e.keyword}>
                    {e.quadrant === 'q1' && <span className="mr-1">🎯</span>}
                    {e.keyword}
                  </div>
                  <div className="col-span-1 text-right font-mono font-bold">
                    {e.conviction.toFixed(1)}
                  </div>
                  <div className="col-span-1 text-right font-mono text-gray-600">
                    {(e.prime_share * 100).toFixed(0)}%
                  </div>
                  <div className="col-span-1 text-right font-mono text-gray-600">
                    {e.repeat_days}일
                  </div>
                  <div className="col-span-2 text-right text-xs">
                    <span className={`px-1.5 py-0.5 rounded mr-1 ${badge.cls}`}>{badge.label}</span>
                    <span className="text-gray-500">{nextShowLabel(e.top_slot)}</span>
                  </div>
                  <div className="col-span-2 text-right text-xs">
                    {e.bestMatch ? (
                      <a
                        href={e.bestMatch.detail_url ?? '#'}
                        target="_blank"
                        rel="noopener"
                        className="text-amber-700 hover:underline"
                        title={e.bestMatch.ggsan_title}
                      >
                        {e.hasImminent && <span className="text-red-600 mr-1">🔥</span>}
                        {e.bestMatch.price_krw ? `${e.bestMatch.price_krw.toLocaleString()}원` : '도매O'}
                      </a>
                    ) : (
                      <span className="text-gray-300">미발견</span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div>
          <strong>확신도</strong> = ∑(슬롯 골든타임 가중치). MD 가 18~23시에 반복 배정할수록 검증된 고확신 수요.
        </div>
        <div>
          <strong>의사결정:</strong> 프라임% 높고 반복일수 많은 상품 중 ggsan 도매 매칭(특히 🔥 임박특가)이 있으면
          방영 전 선제 소싱 1순위. 다음 방영 카운트다운 안에 발주 결정.
        </div>
      </section>
    </div>
  )
}

function Kpi({ label, value, highlight = false }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div className={`rounded border p-3 ${highlight ? 'border-red-300 bg-red-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${highlight ? 'text-red-700' : ''}`}>
        {value.toLocaleString()}
      </div>
    </div>
  )
}
