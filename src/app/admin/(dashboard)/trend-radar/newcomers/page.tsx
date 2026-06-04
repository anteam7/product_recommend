import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

const WINDOWS = [24, 48, 72] as const
type Window = (typeof WINDOWS)[number]

interface NewcomerRow {
  product_id: string
  canonical_name: string
  category_top: string
  category_mid: string | null
  brand: string | null
  first_seen_at: string
  last_seen_at: string
  age_hours: number
  alias_count: number
  source_count: number
  sources: string[]
  early_consensus: number
  commerce_score: number
  supplier_score: number
  ggsan_match: boolean
  ggsan_top_title: string
  recency: number
  cold_start_score: number
}

async function fetchNewcomers(hours: Window) {
  const sb = createAdminClient()
  // jimscanner_newcomer_radar 는 마이그레이션(supabase/newcomer_radar_rpc.sql) 후 존재.
  // 생성된 타입에 아직 없어 as any 캐스팅 (CLAUDE.md 가이드).
  const { data, error } = await (sb as any).rpc('jimscanner_newcomer_radar', {
    hours_window: hours,
    min_sources: 1,
    ggsan_min_sim: 0.3,
    result_limit: 100,
  })
  if (error) return { rows: [] as NewcomerRow[], error: error.message }
  return { rows: (data ?? []) as NewcomerRow[], error: null }
}

function fmtAge(hours: number): string {
  if (hours < 1) return '방금'
  if (hours < 24) return `${Math.round(hours)}h 전`
  const d = Math.floor(hours / 24)
  const h = Math.round(hours % 24)
  return h > 0 ? `${d}일 ${h}h 전` : `${d}일 전`
}

export default async function NewcomersPage({
  searchParams,
}: {
  searchParams: Promise<{ h?: string }>
}) {
  const sp = await searchParams
  const hours = (WINDOWS.includes(Number(sp.h) as Window) ? Number(sp.h) : 72) as Window

  const { rows, error } = await fetchNewcomers(hours)

  const withGgsan = rows.filter((r) => r.ggsan_match).length
  const multiSource = rows.filter((r) => r.source_count >= 2).length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">🌱 신상 조기포착 — 콜드스타트</h1>
          <p className="text-sm text-gray-500 mt-1">
            막 등장한 신규 상품을 <strong>velocity 매몰 없이</strong> 초기 신호(출처 폭·다출처 합의·커머스/공급)로 끌어올림
            <br />
            <span className="text-xs">
              메인 레이더는 점수 시계열 기울기에 의존 → 이력 얇은 신상은 성숙 상품에 밀려 늦게 보임. 그 cold-start 편향을 정면 해소.
            </span>
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 메인 레이더
        </Link>
      </header>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard label={`신상 (≤${hours}h)`} value={rows.length} hint="first_seen 기준" />
        <KpiCard label="다출처 (≥2)" value={multiSource} hint="초기 합의 신호" />
        <KpiCard label="ggsan 매칭" value={withGgsan} hint="즉시 소싱 가능" />
        <KpiCard
          label="윈도우"
          value={hours}
          hint="시간 (h)"
        />
      </section>

      {/* 윈도우 탭 */}
      <nav className="flex gap-2 border-b border-gray-200">
        {WINDOWS.map((w) => (
          <Link
            key={w}
            href={`/admin/trend-radar/newcomers?h=${w}`}
            className={`px-3 py-2 text-sm ${
              hours === w
                ? 'border-b-2 border-black font-semibold text-black'
                : 'text-gray-500 hover:text-black'
            }`}
          >
            최근 {w}h
          </Link>
        ))}
      </nav>

      {error && (
        <div className="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          RPC 미적용 또는 오류: <code className="font-mono">{error}</code>
          <br />
          <span className="text-xs">
            <code>supabase/newcomer_radar_rpc.sql</code> 마이그레이션을 적용하세요.
          </span>
        </div>
      )}

      {/* 카드 리스트 */}
      <section>
        {rows.length === 0 && !error ? (
          <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
            <p className="text-base font-medium">최근 {hours}h 내 신규 등장 상품이 없습니다</p>
            <p className="text-sm mt-2">
              수집 cron 이 새 키워드를 canonical product 로 매핑하면 여기에 즉시 표시됩니다.
            </p>
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {rows.map((r, i) => (
              <Link
                key={r.product_id}
                href={`/admin/trend-radar/products/${r.product_id}`}
                className="block rounded border border-gray-200 p-4 hover:bg-gray-50 transition-colors"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-gray-400 font-mono text-xs">#{i + 1}</span>
                      <span className="font-semibold truncate">{r.canonical_name}</span>
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      {r.category_top}
                      {r.category_mid ? ` · ${r.category_mid}` : ''}
                      {r.brand ? ` · ${r.brand}` : ''}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-mono font-bold text-lg leading-none">
                      {Math.round(r.cold_start_score)}
                    </div>
                    <div className="text-[10px] text-gray-400 mt-0.5">cold-start</div>
                  </div>
                </div>

                {/* 배지 */}
                <div className="flex flex-wrap gap-1.5 mt-3">
                  <Badge tone="blue">⏱ {fmtAge(r.age_hours)}</Badge>
                  <Badge tone={r.source_count >= 2 ? 'green' : 'gray'}>
                    📡 출처 {r.source_count}
                  </Badge>
                  {r.early_consensus > 0 && <Badge tone="gray">합의 {r.early_consensus}</Badge>}
                  {r.ggsan_match ? (
                    <Badge tone="green">🛒 ggsan 매칭</Badge>
                  ) : (
                    <Badge tone="gray">ggsan 미매칭</Badge>
                  )}
                  {r.commerce_score > 0 && <Badge tone="gray">commerce {Math.round(r.commerce_score)}</Badge>}
                  {r.supplier_score > 0 && <Badge tone="gray">supplier {Math.round(r.supplier_score)}</Badge>}
                </div>

                {r.sources.length > 0 && (
                  <div className="text-[11px] text-gray-400 mt-2 truncate">
                    {r.sources.join(' · ')}
                  </div>
                )}
                {r.ggsan_match && r.ggsan_top_title && (
                  <div className="text-[11px] text-emerald-700 mt-1 truncate">
                    ↳ {r.ggsan_top_title}
                  </div>
                )}
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function KpiCard({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-3xl font-bold mt-1">{value.toLocaleString()}</div>
      <div className="text-xs text-gray-400 mt-1">{hint}</div>
    </div>
  )
}

function Badge({
  children,
  tone,
}: {
  children: React.ReactNode
  tone: 'blue' | 'green' | 'gray'
}) {
  const cls =
    tone === 'blue'
      ? 'bg-blue-50 text-blue-700 border-blue-200'
      : tone === 'green'
        ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
        : 'bg-gray-50 text-gray-600 border-gray-200'
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] ${cls}`}>
      {children}
    </span>
  )
}
