import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface RecallMatch {
  recall_id: string
  product_name: string | null
  maker: string | null
  reason: string | null
  ingredient: string | null
  notice_date: string | null
  source_url: string | null
  match_kind: 'product' | 'ingredient'
  goods_no: string
  ggsan_title: string
  cate_cd: string | null
  cate_label: string | null
  detail_url: string | null
  image_url: string | null
  is_imminent: boolean
  sim: number
}

const SIM_OPTIONS = [
  { v: 0.2, label: '0.20 (느슨)' },
  { v: 0.3, label: '0.30 (기본)' },
  { v: 0.4, label: '0.40 (차단선)' },
  { v: 0.5, label: '0.50 (엄격)' },
] as const

const DAYS_OPTIONS = [
  { v: 90, label: '90일' },
  { v: 180, label: '180일' },
  { v: 365, label: '365일 (기본)' },
  { v: 730, label: '2년' },
] as const

// final_score 안전 필터(ggsan_recommend) 의 RED 차단 임계값과 동일
const RED_THRESHOLD = 0.4

async function fetchMatches(opts: { minSim: number; days: number }) {
  const sb = createAdminClient()
  // RPC는 DB(supabase/recall_block_watch.sql)에 존재 — generated 타입 미반영이라 캐스팅
  const { data, error } = await sb.rpc('jimscanner_mfds_recall_match' as never, {
    min_sim: opts.minSim,
    days_window: opts.days,
    result_limit: 300,
  } as never)
  if (error) return { rows: [] as RecallMatch[], error: error.message }
  return { rows: (data ?? []) as RecallMatch[], error: null as string | null }
}

interface Group {
  goods_no: string
  ggsan_title: string
  cate_label: string | null
  cate_cd: string | null
  detail_url: string | null
  image_url: string | null
  is_imminent: boolean
  bestSim: number
  matches: RecallMatch[]
}

function groupByGoods(rows: RecallMatch[]): Group[] {
  const map = new Map<string, Group>()
  for (const r of rows) {
    let g = map.get(r.goods_no)
    if (!g) {
      g = {
        goods_no: r.goods_no,
        ggsan_title: r.ggsan_title,
        cate_label: r.cate_label,
        cate_cd: r.cate_cd,
        detail_url: r.detail_url,
        image_url: r.image_url,
        is_imminent: r.is_imminent,
        bestSim: 0,
        matches: [],
      }
      map.set(r.goods_no, g)
    }
    g.matches.push(r)
    if (Number(r.sim) > g.bestSim) g.bestSim = Number(r.sim)
  }
  return [...map.values()].sort((a, b) => b.bestSim - a.bestSim)
}

function buildHref(current: Record<string, string>, override: Record<string, string | null>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/safety-gate' + (qs ? `?${qs}` : '')
}

export default async function SafetyGatePage({
  searchParams,
}: {
  searchParams: Promise<{ sim?: string; days?: string }>
}) {
  const sp = await searchParams
  const sim = parseFloat(sp.sim ?? '0.3')
  const validSim = SIM_OPTIONS.some((s) => Math.abs(s.v - sim) < 0.001) ? sim : 0.3
  const days = parseInt(sp.days ?? '365', 10)
  const validDays = DAYS_OPTIONS.some((d) => d.v === days) ? days : 365

  const current: Record<string, string> = {
    sim: String(validSim),
    days: String(validDays),
  }

  const { rows, error } = await fetchMatches({ minSim: validSim, days: validDays })
  const groups = groupByGoods(rows)

  const redGroups = groups.filter((g) => g.bestSim >= RED_THRESHOLD)
  const watchGroups = groups.filter((g) => g.bestSim < RED_THRESHOLD)
  const ingredientCount = rows.filter((r) => r.match_kind === 'ingredient').length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🛑 회수·판매중지 사전차단 게이트</h1>
          <p className="text-sm text-gray-500 mt-1">
            식약처 회수·판매중지·원료금지 공고 ↔ ggsan 후보 매칭. <strong className="text-red-600">RED = 발행/판매 금지</strong> · pg_trgm similarity
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 필터 */}
      <div className="flex flex-wrap items-center gap-4 rounded border border-gray-200 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">공고 기간</span>
          {DAYS_OPTIONS.map((d) => (
            <Link
              key={d.v}
              href={buildHref(current, { days: String(d.v) })}
              className={`px-2 py-1 text-xs rounded ${validDays === d.v ? 'bg-red-100 text-red-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
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
              className={`px-2 py-1 text-xs rounded ${Math.abs(validSim - s.v) < 0.001 ? 'bg-red-100 text-red-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
            >
              {s.label}
            </Link>
          ))}
        </div>
      </div>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="🛑 RED 차단 (sim ≥ 0.40)" value={redGroups.length} danger={redGroups.length > 0} />
        <Kpi label="⚠️ 관찰 후보" value={watchGroups.length} />
        <Kpi label="원료금지 매칭" value={ingredientCount} />
        <Kpi label="매칭 row" value={rows.length} />
      </section>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          RPC 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            RPC <code>jimscanner_mfds_recall_match</code> 미적용 가능성. supabase/recall_block_watch.sql 적용 필요.
            데이터는 <code>/api/cron/collect-mfds-recall</code> 가 적재.
          </p>
        </div>
      )}

      {!error && groups.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">✅ 회수·금지 매칭 후보 없음</div>
          <div className="text-xs text-gray-400">
            현재 ggsan 후보 중 식약처 회수·판매중지·원료금지 공고와 매칭되는 제품이 없습니다.
            <br />
            데이터 미적재 시: <code>node --env-file=.env.local scripts/run-crons.mjs collect-mfds-recall</code> · MFDS_API_KEY 필요.
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {redGroups.length > 0 && (
            <Section title="🛑 RED — 발행/판매 즉시 차단" subtitle="ggsan_recommend final_score 에서도 자동 제외됨">
              {redGroups.map((g) => (
                <GateCard key={g.goods_no} g={g} red />
              ))}
            </Section>
          )}
          {watchGroups.length > 0 && (
            <Section title="⚠️ 관찰 — 유사도 낮음, 수동 확인 권장" subtitle={`sim < ${RED_THRESHOLD} — 동명이품 가능성`}>
              {watchGroups.map((g) => (
                <GateCard key={g.goods_no} g={g} red={false} />
              ))}
            </Section>
          )}
        </div>
      )}

      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div>
          <strong>차단 기준:</strong> 회수 제품명 또는 사용금지 원료명을 ggsan title 과 pg_trgm
          <code> similarity()</code> 매칭. sim ≥ {RED_THRESHOLD} → RED (자동 추천 제외).
        </div>
        <div>
          <strong>근거 데이터:</strong> 식약처 식품안전나라 회수·판매중지 공고
          (<code>jimscanner_market_raw.source = &apos;mfds_recall&apos;</code>).
          회수사유·제조사·공고일은 아래 카드의 근거 영역 참조.
        </div>
      </section>
    </div>
  )
}

function Section({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-2">
        <h2 className="text-base font-semibold">{title}</h2>
        <span className="text-xs text-gray-400">{subtitle}</span>
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  )
}

function GateCard({ g, red }: { g: Group; red: boolean }) {
  return (
    <div className={`rounded border overflow-hidden ${red ? 'border-red-300 bg-red-50/50' : 'border-amber-200 bg-amber-50/30'}`}>
      <div className="flex items-start gap-3 p-3">
        <div className="w-16 h-16 bg-gray-100 rounded overflow-hidden flex-shrink-0 relative">
          {g.image_url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={g.image_url} alt="" loading="lazy" className="w-full h-full object-cover" />
          )}
          <span className={`absolute top-0 left-0 text-white text-[9px] px-1 leading-tight rounded-br ${red ? 'bg-red-600' : 'bg-amber-500'}`}>
            {red ? 'RED' : '관찰'}
          </span>
        </div>
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            {g.detail_url ? (
              <a href={g.detail_url} target="_blank" rel="noopener" className="text-sm font-medium leading-snug hover:underline" title={g.ggsan_title}>
                {g.ggsan_title}
              </a>
            ) : (
              <span className="text-sm font-medium leading-snug">{g.ggsan_title}</span>
            )}
            {g.is_imminent && (
              <span className="text-[10px] bg-red-600 text-white px-1.5 py-0.5 rounded">🔥 발행/임박</span>
            )}
          </div>
          <div className="text-xs text-gray-500">
            {g.cate_label ?? g.cate_cd} · {g.goods_no} · best sim{' '}
            <span className={`font-mono font-semibold ${red ? 'text-red-700' : 'text-amber-700'}`}>{g.bestSim.toFixed(3)}</span>
          </div>

          {/* 회수 근거 카드 */}
          <div className="space-y-1.5 pt-1">
            {g.matches
              .sort((a, b) => Number(b.sim) - Number(a.sim))
              .map((m, i) => (
                <div key={`${m.recall_id}-${m.match_kind}-${i}`} className="rounded border border-gray-200 bg-white px-3 py-2 text-xs space-y-0.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${m.match_kind === 'ingredient' ? 'bg-purple-100 text-purple-700' : 'bg-red-100 text-red-700'}`}>
                      {m.match_kind === 'ingredient' ? '🧪 원료금지' : '📦 제품명'}
                    </span>
                    <span className="font-medium text-gray-800">
                      {m.match_kind === 'ingredient' ? m.ingredient : m.product_name}
                    </span>
                    <span className="font-mono text-gray-400">sim {Number(m.sim).toFixed(3)}</span>
                  </div>
                  {m.reason && (
                    <div className="text-gray-600">
                      <span className="text-gray-400">회수사유:</span> {m.reason}
                    </div>
                  )}
                  <div className="flex gap-3 text-gray-500 flex-wrap">
                    {m.maker && <span>제조사: {m.maker}</span>}
                    {m.notice_date && <span>공고일: {m.notice_date}</span>}
                    {m.source_url && (
                      <a href={m.source_url} target="_blank" rel="noopener" className="text-blue-600 hover:underline">
                        원문 →
                      </a>
                    )}
                  </div>
                </div>
              ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function Kpi({ label, value, danger = false }: { label: string; value: number | string; danger?: boolean }) {
  return (
    <div className={`rounded border p-3 ${danger ? 'border-red-400 bg-red-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${danger ? 'text-red-700' : ''}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}
