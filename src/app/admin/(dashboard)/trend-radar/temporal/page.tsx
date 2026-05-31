import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { RadialClock, DowBars } from './RadialClock'

export const dynamic = 'force-dynamic'

interface SignatureRow {
  product_id: string
  total_events: number
  night_events: number
  weekend_events: number
  community_events: number
  search_events: number
  night_ratio: number | null
  weekend_ratio: number | null
  community_share: number | null
  hour_entropy: number | null
  hour_histogram: number[] | null
  dow_histogram: number[] | null
  archetype: 'impulse' | 'planned' | 'mixed' | 'unknown'
}

type Archetype = SignatureRow['archetype']

const ARCHETYPE_META: Record<Archetype, { label: string; badge: string; playbook: string }> = {
  impulse: {
    label: '충동형',
    badge: 'bg-violet-100 text-violet-700 border-violet-200',
    playbook: '히어로 이미지·번들 강조 · 야간/주말 노출 · 한정수량 카피 · 썸네일 임팩트',
  },
  planned: {
    label: '계획형',
    badge: 'bg-blue-100 text-blue-700 border-blue-200',
    playbook: '스펙·리뷰·비교표 강조 · 평일 주간 검색 대응 · 상세 신뢰요소·인증',
  },
  mixed: {
    label: '혼합형',
    badge: 'bg-amber-100 text-amber-700 border-amber-200',
    playbook: '히어로 + 스펙 병행 · 썸네일 후킹 + 상세 신뢰 보강',
  },
  unknown: {
    label: '데이터 부족',
    badge: 'bg-gray-100 text-gray-500 border-gray-200',
    playbook: '수집 누적 대기 (이벤트 4건 미만)',
  },
}

const ARCHETYPE_ORDER: Archetype[] = ['impulse', 'mixed', 'planned', 'unknown']

async function fetchData() {
  const sb = createAdminClient()

  // 마이그레이션 후 존재하는 뷰 — 타입 미생성이라 as any 캐스팅.
  const { data: sigs } = await (sb as any)
    .from('jimscanner_trends_temporal_signature')
    .select(
      'product_id, total_events, night_events, weekend_events, community_events, search_events, night_ratio, weekend_ratio, community_share, hour_entropy, hour_histogram, dow_histogram, archetype',
    )
    .order('total_events', { ascending: false })
    .limit(300)

  const rows = (sigs ?? []) as SignatureRow[]
  if (rows.length === 0) return { rows: [], byId: new Map<string, any>(), counts: {} as Record<string, number> }

  const ids = rows.map((r) => r.product_id)
  const { data: prods } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top')
    .in('id', ids)
  const byId = new Map((prods ?? []).map((p: any) => [p.id, p]))

  const counts: Record<string, number> = {}
  for (const r of rows) counts[r.archetype] = (counts[r.archetype] ?? 0) + 1

  return { rows, byId, counts }
}

function pct(v: number | null): string {
  if (v == null) return '—'
  return `${Math.round(v * 100)}%`
}

export default async function TemporalSignaturePage() {
  const { rows, byId, counts } = await fetchData()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">수요 시간대 지문</h1>
          <p className="text-sm text-gray-500 mt-1">
            KST 시×요일 분포로 본 <b>충동 vs 계획</b> 구매 아키타입 · 야간(21–02)·주말·커뮤니티 집중 → 충동형
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 아키타입 요약 + 플레이북 */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {(['impulse', 'mixed', 'planned'] as Archetype[]).map((a) => {
          const m = ARCHETYPE_META[a]
          return (
            <div key={a} className={`rounded-lg border p-4 ${m.badge}`}>
              <div className="flex items-baseline justify-between">
                <span className="font-semibold">{m.label}</span>
                <span className="text-2xl font-bold tabular-nums">{counts[a] ?? 0}</span>
              </div>
              <p className="text-xs mt-2 leading-relaxed opacity-90">
                <b>리스팅 플레이북:</b> {m.playbook}
              </p>
            </div>
          )
        })}
      </section>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 시간 지문 데이터 없음. cron 누적 후 다시 방문 (또는 뷰 마이그레이션 미적용).
        </div>
      ) : (
        <section className="space-y-3">
          {ARCHETYPE_ORDER.flatMap((a) =>
            rows
              .filter((r) => r.archetype === a)
              .map((r) => {
                const p = byId.get(r.product_id) ?? {}
                const m = ARCHETYPE_META[r.archetype]
                const hours = r.hour_histogram ?? new Array(24).fill(0)
                const dow = r.dow_histogram ?? new Array(7).fill(0)
                return (
                  <div
                    key={r.product_id}
                    className="rounded-lg border border-gray-200 p-4 flex flex-col md:flex-row md:items-center gap-4"
                  >
                    <RadialClock hours={hours} />
                    <DowBars dow={dow} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Link
                          href={`/admin/trend-radar/products/${r.product_id}`}
                          className="font-semibold truncate hover:underline"
                        >
                          {(p as any).canonical_name ?? '?'}
                        </Link>
                        <span className={`text-xs rounded border px-2 py-0.5 ${m.badge}`}>{m.label}</span>
                        <span className="text-xs text-gray-400">{(p as any).category_top ?? ''}</span>
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1 mt-2 text-xs text-gray-600">
                        <span>이벤트 <b className="tabular-nums">{r.total_events}</b></span>
                        <span>야간비중 <b className="tabular-nums">{pct(r.night_ratio)}</b></span>
                        <span>주말비중 <b className="tabular-nums">{pct(r.weekend_ratio)}</b></span>
                        <span>커뮤니티 <b className="tabular-nums">{pct(r.community_share)}</b></span>
                        <span>
                          시간집중 <b className="tabular-nums">{r.hour_entropy != null ? r.hour_entropy.toFixed(2) : '—'}</b>
                          <span className="text-gray-400"> (낮을수록 집중)</span>
                        </span>
                      </div>
                      <p className="text-xs text-gray-500 mt-1.5">→ {m.playbook}</p>
                    </div>
                  </div>
                )
              }),
          )}
        </section>
      )}

      <section className="rounded border border-dashed border-gray-300 p-4 text-xs text-gray-500 space-y-1">
        <p>
          <b className="text-gray-700">읽는 법:</b> 라디얼은 24시간(0시 상단, 시계방향) 수집량 — <span className="text-violet-600">보라</span>=야간(21–02).
          막대는 요일별 — <span className="text-violet-600">보라</span>=주말. 커뮤니티(ppomppu·82cook·natepan·dcinside·clien·뽐·블로그·뉴스)는
          야간·주말에, DataLab 검색은 평일 주간에 쏠리는 차이로 충동/계획을 가른다.
        </p>
        <p>
          <b className="text-gray-700">아키타입 규칙:</b> 야간≥40% 또는 주말≥45% 또는 커뮤니티≥60% → 충동형 ·
          커뮤니티≤30% &amp; 야간≤20% &amp; 주말≤30% → 계획형 · 그 외 혼합형 (이벤트 4건 미만은 데이터 부족).
        </p>
      </section>
    </div>
  )
}
