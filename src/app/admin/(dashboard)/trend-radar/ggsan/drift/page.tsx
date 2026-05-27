import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

type Severity = 'HIGH' | 'MID' | 'LOW'

interface DriftRow {
  id: string
  goods_no: string
  attr: string
  old_value: string | null
  new_value: string | null
  severity: Severity
  reason: string | null
  similarity: number | null
  changed_at: string
  resolved: boolean
}

interface InterceptRow extends DriftRow {
  drift_id: string
  current_title: string | null
  current_image_url: string | null
  current_cate_label: string | null
  current_brand: string | null
  detail_url: string | null
  listing_id: string | null
  seller_product_id: number | null
  product_id: number | null
  registered_title: string | null
  listing_status: string | null
  listing_displayable: boolean | null
}

const SEVERITY_STYLE: Record<Severity, { label: string; cls: string }> = {
  HIGH: { label: 'HIGH', cls: 'bg-red-600 text-white' },
  MID: { label: 'MID', cls: 'bg-amber-500 text-white' },
  LOW: { label: 'LOW', cls: 'bg-zinc-300 text-zinc-800' },
}

const SEVERITY_RANK: Record<Severity, number> = { HIGH: 3, MID: 2, LOW: 1 }

const FILTERS = [
  { v: '', label: '전체' },
  { v: 'HIGH', label: 'HIGH 만' },
  { v: 'MID', label: 'HIGH+MID' },
  { v: 'INTERCEPT', label: '쿠팡 등록 SKU 만' },
  { v: 'UNRESOLVED', label: '미확인 만' },
] as const

async function fetchData(filter: string) {
  // 신규 테이블 — generated types 갱신 전까지 임시 캐스팅
  const sb = createAdminClient() as unknown as {
    from: (t: string) => ReturnType<ReturnType<typeof createAdminClient>['from']>
  }

  // 최근 7일 timeline
  let driftQ = sb
    .from('jimscanner_ggsan_meta_drift')
    .select('*')
    .gte('changed_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
    .order('changed_at', { ascending: false })
    .limit(500)
  if (filter === 'HIGH') driftQ = driftQ.eq('severity', 'HIGH')
  if (filter === 'MID') driftQ = driftQ.in('severity', ['HIGH', 'MID'])
  if (filter === 'UNRESOLVED') driftQ = driftQ.eq('resolved', false)
  const { data: drifts } = await driftQ

  // 인터셉트 (쿠팡 등록 SKU 와 drift 가 겹치는 항목 — 빨간 카드)
  const { data: intercepts } = await sb
    .from('jimscanner_ggsan_meta_drift_intercepts')
    .select('*')
    .not('listing_id', 'is', null)
    .order('severity', { ascending: false })
    .order('changed_at', { ascending: false })
    .limit(100)

  // severity 별 카운트
  const counts: Record<Severity, number> = { HIGH: 0, MID: 0, LOW: 0 }
  for (const d of (drifts ?? []) as unknown as DriftRow[]) {
    if (d.severity in counts) counts[d.severity] += 1
  }

  return {
    drifts: (drifts ?? []) as unknown as DriftRow[],
    intercepts: (intercepts ?? []) as unknown as InterceptRow[],
    counts,
  }
}

function truncate(s: string | null | undefined, n = 60) {
  if (!s) return ''
  if (s.length <= n) return s
  return s.slice(0, n) + '…'
}

function fmtTime(iso: string) {
  return iso.slice(0, 16).replace('T', ' ')
}

export default async function GgsanDriftPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>
}) {
  const sp = await searchParams
  const filter = sp.filter ?? ''
  const { drifts, intercepts, counts } = await fetchData(filter)

  // 인터셉트 필터: 등록된 SKU 만
  const showOnlyIntercepts = filter === 'INTERCEPT'
  const visibleDrifts = showOnlyIntercepts
    ? drifts.filter((d) => intercepts.some((i) => i.goods_no === d.goods_no && i.attr === d.attr))
    : drifts

  // 인터셉트 정렬: severity desc, changed_at desc
  const sortedIntercepts = [...intercepts].sort((a, b) => {
    const sd = (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0)
    if (sd !== 0) return sd
    return b.changed_at.localeCompare(a.changed_at)
  })

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">ggsan 메타 드리프트 알림</h1>
          <p className="text-sm text-gray-500 mt-1">
            도매몰이 통보 없이 제목·이미지·카테고리·브랜드·옵션을 바꾼 SKU 를
            attr 단위로 추적. 쿠팡에 이미 등록된 SKU 의 변경은 빨간 인터셉트로 표시.
          </p>
        </div>
        <Link
          href="/admin/trend-radar/ggsan"
          className="text-sm text-gray-700 hover:text-black underline"
        >
          ← ggsan 카탈로그
        </Link>
      </header>

      {/* 요약 카드 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="rounded border border-red-200 bg-red-50 p-3">
          <div className="text-xs text-red-700">쿠팡 등록 SKU 인터셉트</div>
          <div className="text-2xl font-bold text-red-700 mt-1">{sortedIntercepts.length}</div>
          <div className="text-[10px] text-red-500 mt-1">최근 14일</div>
        </div>
        <div className="rounded border border-red-200 p-3">
          <div className="text-xs text-red-700">HIGH</div>
          <div className="text-2xl font-bold text-red-700 mt-1">{counts.HIGH}</div>
          <div className="text-[10px] text-red-500 mt-1">image_url / brand</div>
        </div>
        <div className="rounded border border-amber-200 p-3">
          <div className="text-xs text-amber-700">MID</div>
          <div className="text-2xl font-bold text-amber-700 mt-1">{counts.MID}</div>
          <div className="text-[10px] text-amber-500 mt-1">title 의미변화 / 옵션</div>
        </div>
        <div className="rounded border border-zinc-200 p-3">
          <div className="text-xs text-zinc-700">LOW</div>
          <div className="text-2xl font-bold text-zinc-700 mt-1">{counts.LOW}</div>
          <div className="text-[10px] text-zinc-500 mt-1">사소 변경</div>
        </div>
      </div>

      {/* 필터 */}
      <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 pb-3">
        {FILTERS.map((f) => {
          const params = new URLSearchParams()
          if (f.v) params.set('filter', f.v)
          const href =
            '/admin/trend-radar/ggsan/drift' + (params.toString() ? `?${params.toString()}` : '')
          return (
            <Link
              key={f.v}
              href={href}
              className={`px-3 py-1 text-xs rounded ${filter === f.v ? 'bg-black text-white font-semibold' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
            >
              {f.label}
            </Link>
          )
        })}
      </div>

      {/* 인터셉트 — 빨간 카드 (쿠팡 등록 SKU 의 drift) */}
      {sortedIntercepts.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold text-red-700">
            ⚠ 쿠팡 등록 SKU 인터셉트 ({sortedIntercepts.length})
          </h2>
          <p className="text-xs text-gray-500">
            이미 쿠팡에 등록된 위탁 리스팅과 ggsan 원본의 메타가 어긋남 — 아이템위너 박탈·정책위반·이미지 오노출 위험.
            'Coupang 리스팅 동기화' 액션으로 코드 사이드 재등록 트리거.
          </p>
          <div className="space-y-2">
            {sortedIntercepts.map((row) => {
              const sev = SEVERITY_STYLE[row.severity] ?? SEVERITY_STYLE.LOW
              return (
                <div
                  key={row.drift_id}
                  className="rounded border-2 border-red-300 bg-red-50/50 p-3 grid grid-cols-12 gap-3 items-start"
                >
                  <div className="col-span-1 flex flex-col items-start gap-1">
                    <span className={`inline-block px-2 py-0.5 text-[10px] rounded font-semibold ${sev.cls}`}>
                      {sev.label}
                    </span>
                    <span className="text-[10px] font-mono text-zinc-500">{row.attr}</span>
                  </div>
                  <div className="col-span-7">
                    <div className="text-xs text-gray-500 mb-1">
                      <span className="font-mono">{row.goods_no}</span>
                      {row.current_cate_label && (
                        <span className="ml-2">· {row.current_cate_label}</span>
                      )}
                      {row.current_brand && <span className="ml-2">· {row.current_brand}</span>}
                    </div>
                    <div className="text-sm font-medium text-zinc-800">
                      {truncate(row.registered_title ?? row.current_title, 80)}
                    </div>
                    <div className="text-xs text-gray-600 mt-1 space-y-0.5">
                      <div>
                        <span className="text-red-600 font-semibold">이전:</span>{' '}
                        <span className="font-mono">{truncate(row.old_value, 80)}</span>
                      </div>
                      <div>
                        <span className="text-emerald-700 font-semibold">현재:</span>{' '}
                        <span className="font-mono">{truncate(row.new_value, 80)}</span>
                      </div>
                      {row.reason && (
                        <div className="text-[11px] text-gray-500 italic">↳ {row.reason}</div>
                      )}
                    </div>
                  </div>
                  <div className="col-span-2 text-[11px] text-gray-500">
                    <div className="font-mono">{fmtTime(row.changed_at)}</div>
                    {row.listing_status && (
                      <div className="mt-1">
                        쿠팡:{' '}
                        <span className="font-semibold">{row.listing_status}</span>
                      </div>
                    )}
                    {row.seller_product_id && (
                      <div className="font-mono text-gray-400">#{row.seller_product_id}</div>
                    )}
                  </div>
                  <div className="col-span-2 flex flex-col gap-1">
                    {row.detail_url && (
                      <a
                        href={row.detail_url}
                        target="_blank"
                        rel="noopener"
                        className="text-xs text-zinc-700 hover:text-black underline text-right"
                      >
                        ggsan 원본 ↗
                      </a>
                    )}
                    <Link
                      href={`/admin/coupang-publish?q=${encodeURIComponent(row.goods_no)}`}
                      className="text-xs px-2 py-1 bg-red-600 text-white rounded text-center hover:bg-red-700"
                    >
                      Coupang 리스팅 동기화
                    </Link>
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* Timeline — 최근 7일 전체 drift */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">최근 7일 drift 타임라인 ({visibleDrifts.length})</h2>
        {visibleDrifts.length === 0 ? (
          <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 text-sm">
            조건에 맞는 drift 없음. 매일 KST 02:00 자동 수집 시 ggsan-detail-dump 가 신규 변경을 적재함.
          </div>
        ) : (
          <div className="rounded border border-gray-200 divide-y divide-gray-100">
            {visibleDrifts.map((d) => {
              const sev = SEVERITY_STYLE[d.severity] ?? SEVERITY_STYLE.LOW
              return (
                <div key={d.id} className="px-4 py-3 grid grid-cols-12 items-start text-sm gap-2">
                  <div className="col-span-1">
                    <span className={`inline-block px-2 py-0.5 text-[10px] rounded font-semibold ${sev.cls}`}>
                      {sev.label}
                    </span>
                  </div>
                  <div className="col-span-1 text-xs font-mono text-zinc-600">{d.attr}</div>
                  <div className="col-span-2 text-xs font-mono text-zinc-500">{d.goods_no}</div>
                  <div className="col-span-6 text-xs text-gray-700 space-y-0.5">
                    <div>
                      <span className="text-red-600">−</span> {truncate(d.old_value, 100)}
                    </div>
                    <div>
                      <span className="text-emerald-700">+</span> {truncate(d.new_value, 100)}
                    </div>
                    {d.reason && (
                      <div className="text-[11px] text-gray-400 italic">{d.reason}</div>
                    )}
                  </div>
                  <div className="col-span-2 text-right text-[11px] text-gray-500 font-mono">
                    {fmtTime(d.changed_at)}
                    {d.resolved && (
                      <div className="text-emerald-600 mt-1">✓ 확인됨</div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      <div className="text-[11px] text-gray-400 pt-4 border-t border-gray-100">
        severity 룰 — HIGH: image_url / brand · MID: title 의미변화(jaccard&lt;0.6 또는 임베딩 cos&lt;0.85), 옵션 추가/삭제
        · LOW: 그 외. 일일 디지스트는 LLM Daily Brief 에 합류.
      </div>
    </div>
  )
}
