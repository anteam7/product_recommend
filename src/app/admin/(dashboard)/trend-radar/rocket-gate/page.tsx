import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface SaturationRow {
  id: number
  category: string | null
  keyword: string
  rocket_share: number
  rocket_fresh_share: number
  jet_share: number
  pb_in_rocket_share: number
  total_listings: number
  rocket_count: number
  rocket_fresh_count: number
  jet_count: number
  pb_count: number
  zone: 'green' | 'yellow' | 'red' | null
  sampled_at: string
}

interface DeltaRow {
  keyword: string
  category: string | null
  rocket_share: number
  prev_share: number | null
  delta: number | null
  sampled_at: string
  prev_at: string | null
}

async function fetchData() {
  const sb = createAdminClient() as any

  const { data: latest } = await sb
    .from('jimscanner_rocket_saturation_latest')
    .select('*')
    .order('rocket_share', { ascending: true })
    .limit(500)

  const { data: deltas } = await sb
    .from('jimscanner_rocket_saturation_weekly_delta')
    .select('*')
    .order('delta', { ascending: false })
    .limit(500)

  // ggsan SKU 카운트 매칭: category 또는 키워드 trigram 매칭은 비싸니 cate_label 매칭으로 단순화
  const { data: ggsanCounts } = await sb
    .from('jimscanner_ggsan_products')
    .select('cate_label')
    .eq('status', 'active')
    .not('cate_label', 'is', null)
    .limit(20000)

  const ggsanByCat = new Map<string, number>()
  for (const r of (ggsanCounts ?? []) as { cate_label: string }[]) {
    ggsanByCat.set(r.cate_label, (ggsanByCat.get(r.cate_label) ?? 0) + 1)
  }

  return {
    rows: ((latest ?? []) as SaturationRow[]),
    deltas: ((deltas ?? []) as DeltaRow[]).filter((d) => d.prev_share != null && d.delta != null),
    ggsanByCat,
  }
}

function fmtPct(v: number | null | undefined) {
  if (v == null) return '—'
  return `${(v * 100).toFixed(1)}%`
}

function zoneClasses(zone: string | null): { bar: string; chip: string; label: string } {
  if (zone === 'green') return { bar: 'bg-emerald-500', chip: 'bg-emerald-50 text-emerald-700 border-emerald-200', label: '진입가능' }
  if (zone === 'yellow') return { bar: 'bg-amber-500', chip: 'bg-amber-50 text-amber-700 border-amber-200', label: '경합' }
  if (zone === 'red') return { bar: 'bg-rose-500', chip: 'bg-rose-50 text-rose-700 border-rose-200', label: '위험' }
  return { bar: 'bg-gray-300', chip: 'bg-gray-50 text-gray-600 border-gray-200', label: '—' }
}

export default async function RocketGatePage() {
  const { rows, deltas, ggsanByCat } = await fetchData()

  const greenCount = rows.filter((r) => r.zone === 'green').length
  const yellowCount = rows.filter((r) => r.zone === 'yellow').length
  const redCount = rows.filter((r) => r.zone === 'red').length

  // 사분면: 진입가능 × ggsan 공급 풍부 (≥10개)
  const quadrant = rows.filter((r) => {
    if (r.zone !== 'green') return false
    const cat = r.category ?? ''
    return (ggsanByCat.get(cat) ?? 0) >= 10
  })

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">🚀 로켓 점유율 게이트</h1>
          <p className="text-sm text-gray-500 mt-1">
            쿠팡 SERP 1페이지(상위 36) 로켓·로켓프레시·로켓직구 점유율 — 위탁 진입 가능 여부의 1차 게이트
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard label="샘플된 키워드" value={rows.length} hint="latest unique" />
        <KpiCard label="🟢 진입가능 (<40%)" value={greenCount} hint="위탁 진입 후보" valueClass="text-emerald-600" />
        <KpiCard label="🟡 경합존 (40-70%)" value={yellowCount} hint="신중 검토" valueClass="text-amber-600" />
        <KpiCard label="🔴 위험존 (>70%)" value={redCount} hint="진입 금지" valueClass="text-rose-600" />
      </section>

      {/* 사분면 강조: 진입가능 × ggsan 공급 풍부 */}
      <section className="rounded border border-emerald-300 bg-emerald-50/50 p-4">
        <h2 className="text-sm font-semibold text-emerald-800 mb-2">
          ⭐ 진입가능존 × ggsan 공급 풍부 ({quadrant.length}개 카테고리)
        </h2>
        <p className="text-xs text-emerald-700 mb-3">
          로켓 점유율 &lt; 40% AND ggsan 활성 SKU ≥ 10 — 위탁 셀러가 즉시 시도해 볼 만한 사분면.
        </p>
        {quadrant.length === 0 ? (
          <div className="text-sm text-emerald-700/70 py-2">아직 매칭 없음. 더 샘플링하거나 ggsan 카탈로그 보강 필요.</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {quadrant.map((r) => (
              <div key={r.id} className="flex items-center justify-between bg-white rounded border border-emerald-200 px-3 py-2 text-sm">
                <div>
                  <div className="font-medium">{r.keyword}</div>
                  <div className="text-xs text-gray-500">{r.category ?? '—'} · ggsan {ggsanByCat.get(r.category ?? '') ?? 0} SKU</div>
                </div>
                <div className="text-right">
                  <div className="font-mono font-bold text-emerald-700">{fmtPct(r.rocket_share)}</div>
                  <div className="text-xs text-gray-400">로켓 점유율</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 색띠 막대 보드 */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-2">카테고리/키워드별 로켓 점유율</h2>
        {rows.length === 0 ? (
          <div className="rounded border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500">
            <p>아직 샘플링된 데이터가 없습니다.</p>
            <p className="mt-2 text-xs">
              로컬 수집 실행:{' '}
              <code className="px-1 bg-gray-100 rounded">
                node --env-file=.env.local scripts/coupang-rocket-saturation.mjs
              </code>
            </p>
            <p className="mt-1 text-xs text-gray-400">
              (Chrome remote-debugging-port=9222 선행 필요 — 스크립트 헤더 참고)
            </p>
          </div>
        ) : (
          <div className="rounded border border-gray-200 divide-y divide-gray-100 text-sm">
            <div className="grid grid-cols-12 px-3 py-2 bg-gray-50 text-xs text-gray-500">
              <div className="col-span-3">키워드 / 카테고리</div>
              <div className="col-span-4">점유율 막대</div>
              <div className="col-span-1 text-right">총</div>
              <div className="col-span-1 text-right">로켓</div>
              <div className="col-span-1 text-right">프레시</div>
              <div className="col-span-1 text-right">직구</div>
              <div className="col-span-1 text-right">ggsan SKU</div>
            </div>
            {rows.map((r) => {
              const z = zoneClasses(r.zone)
              const widthPct = Math.max(2, Math.round(r.rocket_share * 100))
              return (
                <div key={r.id} className="grid grid-cols-12 px-3 py-2 items-center">
                  <div className="col-span-3">
                    <div className="font-medium truncate">{r.keyword}</div>
                    <div className="text-xs text-gray-500 truncate">{r.category ?? '—'}</div>
                  </div>
                  <div className="col-span-4">
                    <div className="relative h-5 bg-gray-100 rounded overflow-hidden">
                      <div
                        className={`absolute inset-y-0 left-0 ${z.bar}`}
                        style={{ width: `${widthPct}%` }}
                      />
                      <div className="absolute inset-0 flex items-center justify-between px-2 text-[10px]">
                        <span className={`px-1 rounded border ${z.chip}`}>{z.label}</span>
                        <span className="font-mono font-bold text-gray-700">{fmtPct(r.rocket_share)}</span>
                      </div>
                      {/* zone 경계선 (40%, 70%) */}
                      <div className="absolute inset-y-0 border-r border-dashed border-amber-300" style={{ left: '40%' }} />
                      <div className="absolute inset-y-0 border-r border-dashed border-rose-300" style={{ left: '70%' }} />
                    </div>
                  </div>
                  <div className="col-span-1 text-right font-mono text-gray-600">{r.total_listings}</div>
                  <div className="col-span-1 text-right font-mono text-gray-600">{r.rocket_count}</div>
                  <div className="col-span-1 text-right font-mono text-gray-600">{r.rocket_fresh_count}</div>
                  <div className="col-span-1 text-right font-mono text-gray-600">{r.jet_count}</div>
                  <div className="col-span-1 text-right font-mono text-gray-500">
                    {ggsanByCat.get(r.category ?? '') ?? '—'}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* 주간 델타 */}
      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-2">
          주간 점유율 델타{' '}
          <span className="text-xs font-normal text-gray-500 ml-1">
            (직전 5일 이전 가장 최근 sample 대비)
          </span>
        </h2>
        {deltas.length === 0 ? (
          <div className="text-sm text-gray-500 px-3 py-3">아직 비교용 이전 sample 부족.</div>
        ) : (
          <div className="rounded border border-gray-200 divide-y divide-gray-100 text-sm">
            <div className="grid grid-cols-12 px-3 py-2 bg-gray-50 text-xs text-gray-500">
              <div className="col-span-4">키워드</div>
              <div className="col-span-2 text-right">현재</div>
              <div className="col-span-2 text-right">이전</div>
              <div className="col-span-2 text-right">델타</div>
              <div className="col-span-2 text-right">샘플 시각</div>
            </div>
            {deltas.slice(0, 30).map((d) => {
              const delta = d.delta ?? 0
              const cls = delta > 0.03 ? 'text-rose-600' : delta < -0.03 ? 'text-emerald-600' : 'text-gray-500'
              const arrow = delta > 0.01 ? '↑' : delta < -0.01 ? '↓' : '→'
              return (
                <div key={d.keyword} className="grid grid-cols-12 px-3 py-2 items-center">
                  <div className="col-span-4">
                    <div className="font-medium truncate">{d.keyword}</div>
                    <div className="text-xs text-gray-500 truncate">{d.category ?? '—'}</div>
                  </div>
                  <div className="col-span-2 text-right font-mono">{fmtPct(d.rocket_share)}</div>
                  <div className="col-span-2 text-right font-mono text-gray-500">{fmtPct(d.prev_share)}</div>
                  <div className={`col-span-2 text-right font-mono font-bold ${cls}`}>
                    {arrow} {fmtPct(Math.abs(delta))}
                  </div>
                  <div className="col-span-2 text-right text-xs text-gray-400">{d.sampled_at?.slice(5, 16)}</div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      <section className="rounded border border-dashed border-gray-300 p-4 text-xs text-gray-500 space-y-1">
        <div>
          <strong className="text-gray-700">읽는 법:</strong>{' '}
          🟢 진입가능존 (&lt;40%) — 위탁 셀러가 노출 경쟁 가능 ·
          🟡 경합존 (40-70%) — 가격·리뷰로만 비집고 들어감 ·
          🔴 위험존 (&gt;70%) — 로켓 직영이 카탈로그 점유, 사실상 진입 불가.
        </div>
        <div>
          <strong className="text-gray-700">수집:</strong>{' '}
          <code className="px-1 bg-gray-100 rounded">node --env-file=.env.local scripts/coupang-rocket-saturation.mjs</code>
          {' '}— Chrome CDP attach 방식, 위클리 cron 권장.
        </div>
      </section>
    </div>
  )
}

function KpiCard({ label, value, hint, valueClass }: { label: string; value: number; hint: string; valueClass?: string }) {
  return (
    <div className="rounded border border-gray-200 p-4">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-3xl font-bold mt-1 ${valueClass ?? ''}`}>{value.toLocaleString()}</div>
      <div className="text-xs text-gray-400 mt-1">{hint}</div>
    </div>
  )
}
