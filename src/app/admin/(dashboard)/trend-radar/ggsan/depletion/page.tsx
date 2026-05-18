import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface DepletionRow {
  goods_no: string
  title: string
  cate_cd: string | null
  cate_label: string | null
  brand: string | null
  price_krw: number | null
  image_url: string | null
  detail_url: string | null
  is_imminent_current: boolean
  depletion_velocity: number
  flips_21d: number
  last_flip_at: string | null
  imminent_streak: number
  latest_day: string | null
  depletion_velocity_score: number
}

interface CateBurnRow {
  cate_cd: string | null
  cate_label: string | null
  sku_count: number
  avg_velocity: number
  imminent_now: number
  total_flips_21d: number
}

interface SnapshotRow {
  goods_no: string
  captured_at: string
  is_imminent: boolean
}

const PAGE_SIZE = 50

async function fetchData(opts: { cat: string; minVelocity: number; page: number }) {
  const sb = createAdminClient()
  // MV 미반영 타입 — `as never` 캐스팅 (CLAUDE.md 의 RPC type workaround 동일 패턴)
  let q = sb
    .from('jimscanner_ggsan_depletion_mv' as never)
    .select('*', { count: 'exact' })
    .gt('depletion_velocity_score', opts.minVelocity)
  if (opts.cat) q = q.eq('cate_cd', opts.cat)
  q = q.order('depletion_velocity_score', { ascending: false })
  const offset = (opts.page - 1) * PAGE_SIZE
  q = q.range(offset, offset + PAGE_SIZE - 1)
  const { data, count, error } = await q
  const rows = ((data ?? []) as unknown as DepletionRow[]) ?? []
  return { rows, total: count ?? 0, error: error?.message ?? null }
}

async function fetchHeatmap() {
  const sb = createAdminClient()
  const { data, error } = await sb
    .from('jimscanner_ggsan_depletion_by_cate' as never)
    .select('*')
  const rows = ((data ?? []) as unknown as CateBurnRow[]) ?? []
  rows.sort((a, b) => (b.avg_velocity ?? 0) - (a.avg_velocity ?? 0))
  return { heatmap: rows, error: error?.message ?? null }
}

async function fetchRecentFlips(goodsNos: string[]) {
  if (goodsNos.length === 0) return new Map<string, SnapshotRow[]>()
  const sb = createAdminClient()
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()
  const { data } = await sb
    .from('jimscanner_ggsan_snapshots' as never)
    .select('goods_no, captured_at, is_imminent')
    .in('goods_no', goodsNos)
    .gt('captured_at', since)
    .order('captured_at', { ascending: true })
    .limit(2000)
  const rows = ((data ?? []) as unknown as SnapshotRow[]) ?? []
  const map = new Map<string, SnapshotRow[]>()
  for (const r of rows) {
    const arr = map.get(r.goods_no) ?? []
    arr.push(r)
    map.set(r.goods_no, arr)
  }
  return map
}

function buildHref(current: Record<string, string>, override: Record<string, string | null>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/ggsan/depletion' + (qs ? `?${qs}` : '')
}

function lifecycleStage(velocity: number, streak: number): { label: string; color: string } {
  if (velocity >= 0.5) return { label: 'early', color: 'bg-emerald-100 text-emerald-800' }
  if (streak >= 7) return { label: 'peak', color: 'bg-amber-100 text-amber-800' }
  if (streak >= 14) return { label: 'declining', color: 'bg-gray-200 text-gray-700' }
  return { label: '—', color: 'bg-gray-100 text-gray-500' }
}

function Sparkline({ points, width = 60, height = 18 }: { points: SnapshotRow[]; width?: number; height?: number }) {
  if (!points || points.length < 2) {
    return <span className="text-[10px] text-gray-300">—</span>
  }
  const xs = points.map((p, i) => i / Math.max(points.length - 1, 1))
  const ys = points.map((p) => (p.is_imminent ? 1 : 0))
  const path = xs
    .map((x, i) => `${i === 0 ? 'M' : 'L'}${(x * width).toFixed(1)},${(height - ys[i] * (height - 2) - 1).toFixed(1)}`)
    .join(' ')
  const lastImminent = ys[ys.length - 1] === 1
  return (
    <svg width={width} height={height} className="inline-block align-middle">
      <path d={path} fill="none" stroke={lastImminent ? '#dc2626' : '#9ca3af'} strokeWidth="1.5" />
      {ys.map((y, i) =>
        y === 1 ? (
          <circle
            key={i}
            cx={(xs[i] * width).toFixed(1)}
            cy={(height - y * (height - 2) - 1).toFixed(1)}
            r="1.5"
            fill="#dc2626"
          />
        ) : null,
      )}
    </svg>
  )
}

function HeatCell({ row, max }: { row: CateBurnRow; max: number }) {
  const ratio = max > 0 ? (row.avg_velocity ?? 0) / max : 0
  const bg = ratio > 0.7 ? 'bg-red-500' : ratio > 0.4 ? 'bg-amber-400' : ratio > 0.15 ? 'bg-amber-200' : 'bg-gray-100'
  const text = ratio > 0.4 ? 'text-white' : 'text-gray-800'
  return (
    <div className={`${bg} ${text} rounded px-2 py-2 text-xs flex flex-col`}>
      <div className="font-semibold truncate" title={row.cate_label ?? row.cate_cd ?? ''}>
        {row.cate_label ?? row.cate_cd}
      </div>
      <div className="text-[10px] opacity-90 font-mono">
        v={(row.avg_velocity ?? 0).toFixed(3)} · 🔥{row.imminent_now} · flips {row.total_flips_21d}
      </div>
      <div className="text-[10px] opacity-75">SKU {row.sku_count}</div>
    </div>
  )
}

export default async function GgsanDepletionPage({
  searchParams,
}: {
  searchParams: Promise<{ cat?: string; minv?: string; page?: string }>
}) {
  const sp = await searchParams
  const cat = sp.cat ?? ''
  const minVelocity = Math.max(0, parseFloat(sp.minv ?? '0') || 0)
  const page = Math.max(1, parseInt(sp.page ?? '1', 10) || 1)

  const current: Record<string, string> = {
    cat,
    minv: minVelocity > 0 ? String(minVelocity) : '',
    page: String(page),
  }

  const [{ rows, total, error }, { heatmap, error: heatErr }] = await Promise.all([
    fetchData({ cat, minVelocity, page }),
    fetchHeatmap(),
  ])

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const flipsByGoods = await fetchRecentFlips(rows.map((r) => r.goods_no))

  const maxAvgVelocity = heatmap.reduce((m, r) => Math.max(m, r.avg_velocity ?? 0), 0)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">⚡ 임박 전환 속도 (Depletion Velocity)</h1>
          <p className="text-sm text-gray-500 mt-1">
            ggsan 도매 스냅샷 시계열 — 다른 셀러들이 빠르게 쓸어담는 SKU 가 위에 뜬다 (인사이더 선행지표)
          </p>
        </div>
        <Link href="/admin/trend-radar/ggsan" className="text-sm text-gray-700 hover:text-black underline">
          ← ggsan 카탈로그
        </Link>
      </header>

      <div className="rounded border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900 space-y-1">
        <div>
          <strong>V0 한계</strong> · stock_label 적재 전이라 진입은 <code>is_imminent</code> false→true 일자 차이의 1/d 기반 7d 이동평균.
        </div>
        <div>
          매일 KST 02:00 ggsan refresh cron 직후 <code>jimscanner_ggsan_snapshot_now()</code> 호출 → 매일 1회{' '}
          <code>jimscanner_ggsan_depletion_refresh()</code> 로 MV 갱신.
        </div>
      </div>

      {(error || heatErr) && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          마이그레이션 미적용 가능성: <code className="font-mono text-xs">{error ?? heatErr}</code>
          <p className="text-xs mt-2 text-red-700">
            <code>supabase/ggsan_depletion_velocity.sql</code> 을 DB에 적용 필요.
          </p>
        </div>
      )}

      {/* 카테고리 burn-rate 히트맵 */}
      <section>
        <h2 className="text-sm font-semibold mb-2">카테고리별 burn-rate</h2>
        {heatmap.length === 0 ? (
          <div className="text-xs text-gray-400 border border-dashed border-gray-300 p-6 rounded">
            스냅샷 누적 부족 (최소 2일치 필요)
          </div>
        ) : (
          <div className="grid grid-cols-3 md:grid-cols-5 lg:grid-cols-7 gap-2">
            {heatmap.map((h) => (
              <Link
                key={h.cate_cd ?? 'na'}
                href={buildHref(current, { cat: h.cate_cd ?? null, page: null })}
                className={`block ${cat === h.cate_cd ? 'ring-2 ring-black' : ''}`}
              >
                <HeatCell row={h} max={maxAvgVelocity} />
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* 필터 */}
      <div className="flex flex-wrap items-center gap-3 border-t border-gray-100 pt-4">
        <Link
          href={buildHref(current, { cat: null, page: null })}
          className={`px-2 py-1 text-xs rounded ${cat === '' ? 'bg-black text-white' : 'text-gray-500 hover:text-black'}`}
        >
          전체 카테고리
        </Link>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">최소 velocity</span>
          {[0, 0.1, 0.25, 0.5].map((v) => (
            <Link
              key={v}
              href={buildHref(current, { minv: v > 0 ? String(v) : null, page: null })}
              className={`px-2 py-1 text-xs rounded ${Math.abs(minVelocity - v) < 0.001 ? 'bg-amber-100 text-amber-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
            >
              ≥ {v.toFixed(2)}
            </Link>
          ))}
        </div>
        <div className="ml-auto text-xs text-gray-500">
          {total.toLocaleString()}건 · {page}/{totalPages} 페이지
        </div>
      </div>

      {/* 속도 상위 SKU 카드 리스트 */}
      {rows.length === 0 && !error ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">전환 데이터 부족</div>
          <div className="text-xs text-gray-400">
            최소 2일치 스냅샷 누적이 있어야 false→true 전환을 탐지함.
            <br />
            매일 02:00 자동 또는 어드민 “갱신” 버튼 후 다음날 다시 확인.
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((r, i) => {
            const stage = lifecycleStage(r.depletion_velocity, r.imminent_streak)
            const points = flipsByGoods.get(r.goods_no) ?? []
            return (
              <a
                key={r.goods_no}
                href={r.detail_url ?? '#'}
                target="_blank"
                rel="noopener"
                className={`block rounded border overflow-hidden hover:shadow-sm transition-all ${
                  r.is_imminent_current
                    ? 'border-red-200 bg-red-50/40 hover:bg-red-50'
                    : 'border-gray-200 hover:bg-gray-50'
                }`}
              >
                <div className="flex items-start gap-3 p-3">
                  <div className="w-8 text-center text-sm font-mono text-gray-400 pt-1">{(page - 1) * PAGE_SIZE + i + 1}</div>
                  <div className="w-16 h-16 bg-gray-100 rounded overflow-hidden flex-shrink-0 relative">
                    {r.image_url && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={r.image_url} alt="" loading="lazy" className="w-full h-full object-cover" />
                    )}
                    {r.is_imminent_current && (
                      <span className="absolute top-0 left-0 bg-red-600 text-white text-[9px] px-1 leading-tight rounded-br">
                        임박
                      </span>
                    )}
                  </div>
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="text-sm font-medium leading-snug" title={r.title}>
                      {r.title}
                    </div>
                    <div className="text-xs text-gray-500 flex items-center gap-2 flex-wrap">
                      <span>{r.cate_label ?? r.cate_cd}</span>
                      <span>·</span>
                      <span className="font-mono">{r.goods_no}</span>
                      {r.brand && (
                        <>
                          <span>·</span>
                          <span>{r.brand}</span>
                        </>
                      )}
                      <span className={`px-1.5 py-0.5 rounded text-[10px] ${stage.color}`}>
                        🔄 {stage.label}
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-3 text-[11px] pt-1 items-center">
                      <span className="bg-gray-100 text-gray-700 px-2 py-0.5 rounded font-mono">
                        v={r.depletion_velocity.toFixed(3)}
                      </span>
                      {r.flips_21d > 0 && (
                        <span className="bg-blue-50 text-blue-800 px-2 py-0.5 rounded">
                          flips {r.flips_21d}× / 21d
                        </span>
                      )}
                      {r.imminent_streak > 0 && (
                        <span className="bg-red-100 text-red-700 px-2 py-0.5 rounded">
                          🔥 streak {r.imminent_streak}d
                        </span>
                      )}
                      {r.last_flip_at && (
                        <span className="text-gray-400 font-mono">last flip {r.last_flip_at.slice(0, 10)}</span>
                      )}
                      <span title="최근 30일 imminent 전환 sparkline">
                        <Sparkline points={points} />
                      </span>
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0 space-y-1">
                    <div className="text-base font-bold">
                      {r.price_krw ? `${r.price_krw.toLocaleString()}원` : <span className="text-gray-400 text-xs">가격 X</span>}
                    </div>
                    <div className="text-2xl font-bold font-mono text-amber-700">
                      {r.depletion_velocity_score.toFixed(2)}
                    </div>
                    <div className="text-[10px] text-gray-500 font-mono">
                      velocity score
                    </div>
                  </div>
                </div>
              </a>
            )
          })}
        </div>
      )}

      {/* 페이지네이션 */}
      {totalPages > 1 && (
        <nav className="flex items-center justify-center gap-1 pt-4">
          {page > 1 && (
            <Link href={buildHref(current, { page: String(page - 1) })} className="px-3 py-1 text-sm rounded border border-gray-200 hover:bg-gray-50">
              이전
            </Link>
          )}
          {Array.from({ length: Math.min(7, totalPages) }, (_, i) => {
            let n: number
            if (totalPages <= 7) n = i + 1
            else if (page <= 4) n = i + 1
            else if (page >= totalPages - 3) n = totalPages - 6 + i
            else n = page - 3 + i
            return (
              <Link
                key={n}
                href={buildHref(current, { page: String(n) })}
                className={`px-3 py-1 text-sm rounded ${n === page ? 'bg-black text-white' : 'border border-gray-200 hover:bg-gray-50'}`}
              >
                {n}
              </Link>
            )
          })}
          {page < totalPages && (
            <Link href={buildHref(current, { page: String(page + 1) })} className="px-3 py-1 text-sm rounded border border-gray-200 hover:bg-gray-50">
              다음
            </Link>
          )}
        </nav>
      )}

      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 Depletion Velocity 공식</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          depletion_velocity = AVG ( 1 / days_to_imminent ) over flips in last 21d
          <br />
          imminent_streak = 최근 연속 imminent=true 일수
          <br />
          depletion_velocity_score = depletion_velocity + imminent_streak × 0.05
        </code>
        <div className="pt-2">
          recommend RPC final_score 에 <code>+ depletion_velocity_score × 2.0</code> 가중치 합산.
        </div>
      </section>
    </div>
  )
}
