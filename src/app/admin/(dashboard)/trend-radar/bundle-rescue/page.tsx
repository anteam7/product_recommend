import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

// ─── 마진 상수 (coupang-recompute-margins.mjs / coupang-register-bundle.mjs 와 동기화) ───
const SHIP = 3000 // ggsan 주문당 1회 부과되는 고정 배송비 (N개에 분산되는 구조적 마진 레버)
const FEE = 0.106 // 쿠팡 판매수수료 (기타영양제 73137, 결제비 포함) — coupang_pricing_model
const VAT_DIVISOR = 11 // 부가세 = 판매가 / 11
const MAX_PACK = 6 // 흑자전환을 탐색할 최대 묶음수
const DEFAULT_TARGET = 0.25 // 목표 마진율 (기본 25%)
const DEFAULT_UNIT_MARKUP = 2.0 // tiered_msp 부재 시 단가 추정 배수 (도매가 × N) — 결과는 (추정)으로 표기

const TARGET_OPTIONS = [
  { v: 0.15, label: '15%' },
  { v: 0.2, label: '20%' },
  { v: 0.25, label: '25% (기본)' },
  { v: 0.3, label: '30%' },
] as const

interface RecommendRow {
  goods_no: string
  title: string
  cate_cd: string | null
  cate_label: string | null
  price_krw: number | null // jimscanner_ggsan_products.price_krw = 도매가(원)
  is_imminent: boolean
  image_url: string | null
  detail_url: string | null
  tv_score: number
  search_score: number
  final_score: number
  tv_match_count: number
  tv_top_keyword: string
  search_match_count: number
  search_top_keyword: string
}

/** 판매가 P, 묶음수 N 에서의 실마진(원). coupang-register-bundle.mjs 와 동일 공식(부가세 포함). */
function marginAt(price: number, dome: number, pack: number): number {
  const fee = Math.round(price * FEE)
  const vat = Math.round(price / VAT_DIVISOR)
  const realCost = dome * pack + SHIP
  return price - realCost - fee - vat
}

interface PackResult {
  pack: number
  price: number // 권장(=절대준수 최저) 판매가
  margin: number
  marginRate: number
  estimated: boolean // 단가 추정 여부 (tiered_msp 부재)
}

/** 후보별 pack=1..MAX 의 마진 곡선 + 흑자전환 최소 N 역산 */
function analyze(
  dome: number,
  tiered: Record<string, number> | null,
  target: number,
): { curve: PackResult[]; rescueN: number | null; singleRate: number } {
  const tieredAt = (n: number): number | undefined =>
    tiered?.[String(n)] ?? tiered?.[n as unknown as string]
  const mspUnit = tieredAt(1)

  const curve: PackResult[] = []
  for (let n = 1; n <= MAX_PACK; n++) {
    const floor = tieredAt(n)
    let price: number
    let estimated = false
    if (floor != null) {
      price = floor // N개 묶음 절대준수가 (tiered_msp) — 이 밑으로는 등록 불가
    } else if (mspUnit != null) {
      price = mspUnit * n // 단가 MSP × N (볼륨 tier 부재 시)
    } else {
      price = Math.round((dome * DEFAULT_UNIT_MARKUP * n) / 10) * 10 // MSP 전무 → 추정 단가
      estimated = true
    }
    const margin = marginAt(price, dome, n)
    curve.push({ pack: n, price, margin, marginRate: margin / price, estimated })
  }

  const single = curve[0]
  const rescue = curve.find((c) => c.marginRate >= target)
  return { curve, rescueN: rescue ? rescue.pack : null, singleRate: single.marginRate }
}

async function fetchData(opts: { days: number; target: number; cate: string }) {
  const sb = createAdminClient()
  // 1) 수요 검증 후보 — recommend 페이지와 동일 RPC (DB 존재, generated 타입 미반영 → 캐스팅)
  const { data, error } = await sb.rpc('jimscanner_ggsan_recommend' as never, {
    days_window: opts.days,
    min_sim: 0.2,
    min_score: 0.5,
    result_limit: 200,
  } as never)
  if (error) return { rows: [] as RecommendRow[], mspMap: {} as Record<string, Record<string, number> | null>, error: error.message }

  let rows = ((data ?? []) as RecommendRow[]).filter((r) => (r.price_krw ?? 0) > 0)
  if (opts.cate) rows = rows.filter((r) => r.cate_cd === opts.cate)

  // 2) tiered_msp 조인 (raw_payload) — supplier(jimscanner_ggsan_products) 배치 조회
  const mspMap: Record<string, Record<string, number> | null> = {}
  const ids = rows.map((r) => r.goods_no)
  if (ids.length > 0) {
    const { data: gp } = await sb
      .from('jimscanner_ggsan_products')
      .select('goods_no, raw_payload')
      .in('goods_no', ids)
    for (const g of (gp ?? []) as { goods_no: string; raw_payload: { tiered_msp?: Record<string, number> } | null }[]) {
      mspMap[g.goods_no] = g.raw_payload?.tiered_msp ?? null
    }
  }
  return { rows, mspMap, error: null as string | null }
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
  return '/admin/trend-radar/bundle-rescue' + (qs ? `?${qs}` : '')
}

export default async function BundleRescuePage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; target?: string; cate?: string }>
}) {
  const sp = await searchParams
  const days = parseInt(sp.days ?? '30', 10)
  const validDays = [7, 14, 30, 60].includes(days) ? days : 30
  const targetRaw = parseFloat(sp.target ?? String(DEFAULT_TARGET))
  const target = TARGET_OPTIONS.some((t) => Math.abs(t.v - targetRaw) < 0.001) ? targetRaw : DEFAULT_TARGET
  const cate = sp.cate ?? ''
  const current: Record<string, string> = { days: String(validDays), target: String(target), cate }

  const { rows, mspMap, error } = await fetchData({ days: validDays, target, cate })

  // 후보 분석
  const analyzed = rows.map((r) => {
    const dome = r.price_krw as number
    const { curve, rescueN, singleRate } = analyze(dome, mspMap[r.goods_no] ?? null, target)
    return { row: r, dome, curve, rescueN, singleRate }
  })

  // ① 흑자전환 후보: 단품(N=1)은 목표 미달인데 N≥2 묶음에서 목표 통과 → 핵심 산출물
  const rescues = analyzed
    .filter((a) => a.rescueN != null && a.rescueN >= 2 && a.singleRate < target)
    .sort((a, b) => (a.rescueN! - b.rescueN!) || (b.row.final_score - a.row.final_score))
  // ② 단품으로도 목표 통과 (묶음 불필요)
  const alreadyOk = analyzed.filter((a) => a.singleRate >= target)
  // ③ MAX_PACK 까지도 목표 미달 (묶음으로도 회생 불가)
  const unrescuable = analyzed.filter((a) => a.rescueN == null)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">📦 배송비 분산 번들 흑자전환 보드</h1>
          <p className="text-sm text-gray-500 mt-1">
            수요는 검증됐으나 단품 마진이 얇은 후보 → 고정 배송비 {SHIP.toLocaleString()}원이 N개에 분산될 때
            목표 마진율({Math.round(target * 100)}%)을 넘기는 <strong>최소 묶음수 N</strong> 역산
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <div className="rounded border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-900 space-y-1">
        <div>
          <strong>판매가 = N개 묶음 절대준수 최저가(tiered_msp)</strong> 기준 — 가장 공격적인 경쟁 가격에서도
          흑자가 되는 최소 묶음수를 보여줍니다. tiered_msp 부재 시 단가 MSP×N, 그마저 없으면 도매가×
          {DEFAULT_UNIT_MARKUP}×N <strong>(추정)</strong>.
        </div>
        <div>
          margin(N) = price_N − 도매×N − {SHIP.toLocaleString()} − price_N×{FEE} − price_N/{VAT_DIVISOR}
          (수수료+부가세 포함, register-bundle 과 동일)
        </div>
      </div>

      {/* 필터 */}
      <div className="rounded border border-gray-200 px-4 py-3 space-y-3">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">기간</span>
            {[7, 14, 30, 60].map((d) => (
              <Link
                key={d}
                href={buildHref(current, { days: String(d) })}
                className={`px-2 py-1 text-xs rounded ${validDays === d ? 'bg-blue-100 text-blue-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
              >
                {d}일
              </Link>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">목표 마진율</span>
            {TARGET_OPTIONS.map((t) => (
              <Link
                key={t.v}
                href={buildHref(current, { target: String(t.v) })}
                className={`px-2 py-1 text-xs rounded ${Math.abs(target - t.v) < 0.001 ? 'bg-blue-100 text-blue-700 font-semibold' : 'text-gray-500 hover:text-black'}`}
              >
                {t.label}
              </Link>
            ))}
          </div>
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
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="분석 후보" value={analyzed.length} />
        <Kpi label="🎯 흑자전환 가능" value={rescues.length} highlight={rescues.length > 0} />
        <Kpi label="단품 OK (묶음 불필요)" value={alreadyOk.length} />
        <Kpi label="회생 불가" value={unrescuable.length} />
      </section>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          RPC 에러: <code className="font-mono text-xs">{error}</code>
        </div>
      )}

      {/* ① 흑자전환 보드 (핵심) */}
      <section className="space-y-2">
        <h2 className="text-sm font-bold text-gray-800">
          🎯 흑자전환 후보 — 단품 적자/얇음 → 묶으면 목표 통과
        </h2>
        {rescues.length === 0 ? (
          <div className="rounded border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500">
            조건에 맞는 흑자전환 후보 없음. 목표 마진율을 낮추거나 기간/카테고리를 조정해 보세요.
          </div>
        ) : (
          <div className="space-y-3">
            {rescues.map((a) => {
              const best = a.curve[a.rescueN! - 1]
              return (
                <div key={a.row.goods_no} className="rounded border border-emerald-200 bg-emerald-50/30 overflow-hidden">
                  <div className="flex items-start gap-3 p-3">
                    <div className="w-16 h-16 bg-gray-100 rounded overflow-hidden flex-shrink-0">
                      {a.row.image_url && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={a.row.image_url} alt="" loading="lazy" className="w-full h-full object-cover" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0 space-y-1">
                      <a
                        href={a.row.detail_url ?? '#'}
                        target="_blank"
                        rel="noopener"
                        className="text-sm font-medium leading-snug hover:underline block truncate"
                        title={a.row.title}
                      >
                        {a.row.title}
                      </a>
                      <div className="text-xs text-gray-500">
                        {a.row.cate_label ?? a.row.cate_cd} · {a.row.goods_no} · 도매 {a.dome.toLocaleString()}원
                      </div>
                      <div className="flex flex-wrap gap-2 text-xs pt-0.5">
                        {a.row.tv_match_count > 0 && (
                          <span className="bg-amber-100 text-amber-800 px-2 py-0.5 rounded">
                            📺 TV &quot;{a.row.tv_top_keyword}&quot;
                          </span>
                        )}
                        {a.row.search_match_count > 0 && (
                          <span className="bg-blue-100 text-blue-800 px-2 py-0.5 rounded">
                            🔍 검색 &quot;{a.row.search_top_keyword}&quot;
                          </span>
                        )}
                        <span className="text-gray-400">score {Number(a.row.final_score).toFixed(1)}</span>
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <div className="text-[10px] text-gray-500">흑자전환 최소</div>
                      <div className="text-2xl font-bold text-emerald-700">{a.rescueN}개</div>
                      <div className="text-xs text-gray-600">
                        {best.price.toLocaleString()}원 · 마진 {Math.round(best.marginRate * 100)}%
                        {best.estimated && <span className="text-amber-600"> (추정)</span>}
                      </div>
                    </div>
                  </div>

                  {/* pack 곡선 */}
                  <div className="px-3 pb-2 overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-gray-400">
                          <th className="text-left font-normal py-1">묶음</th>
                          {a.curve.map((c) => (
                            <th key={c.pack} className="text-right font-normal px-2">
                              {c.pack}개
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td className="text-left text-gray-500 py-0.5">판매가</td>
                          {a.curve.map((c) => (
                            <td key={c.pack} className="text-right px-2 font-mono text-gray-600">
                              {c.price.toLocaleString()}
                            </td>
                          ))}
                        </tr>
                        <tr>
                          <td className="text-left text-gray-500 py-0.5">마진율</td>
                          {a.curve.map((c) => (
                            <td
                              key={c.pack}
                              className={`text-right px-2 font-mono font-semibold ${
                                c.marginRate >= target
                                  ? 'text-emerald-600'
                                  : c.marginRate < 0
                                    ? 'text-red-600'
                                    : 'text-gray-400'
                              }`}
                            >
                              {Math.round(c.marginRate * 100)}%
                            </td>
                          ))}
                        </tr>
                      </tbody>
                    </table>
                  </div>

                  {/* 등록 커맨드 (복사) */}
                  <div className="px-3 pb-3">
                    <code className="block bg-gray-900 text-gray-100 px-3 py-2 rounded text-[11px] font-mono overflow-x-auto whitespace-nowrap select-all">
                      node scripts/coupang-register-bundle.mjs --base={a.row.goods_no} --pack={a.rescueN}{' '}
                      --price={best.price} --option=&quot;{a.rescueN}개&quot; --title=&quot;{a.row.title} {a.rescueN}개&quot;
                    </code>
                    <div className="text-[10px] text-gray-400 mt-1">
                      ↑ 클릭으로 전체 선택 · --title 은 name_creation_rules 검토 후 다듬어 사용 · 실행 후 --apply 추가
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* ② 단품 OK / ③ 회생 불가 요약 */}
      <section className="grid md:grid-cols-2 gap-4">
        <SummaryList
          title="✅ 단품으로도 목표 통과 (묶음 불필요)"
          items={alreadyOk.map((a) => ({
            goods_no: a.row.goods_no,
            title: a.row.title,
            note: `단품 마진 ${Math.round(a.singleRate * 100)}%`,
          }))}
          tone="emerald"
        />
        <SummaryList
          title={`⚠️ ${MAX_PACK}개 묶음으로도 회생 불가`}
          items={unrescuable.map((a) => ({
            goods_no: a.row.goods_no,
            title: a.row.title,
            note: `${MAX_PACK}개 마진 ${Math.round(a.curve[MAX_PACK - 1].marginRate * 100)}%`,
          }))}
          tone="red"
        />
      </section>
    </div>
  )
}

function Kpi({ label, value, highlight = false }: { label: string; value: number | string; highlight?: boolean }) {
  return (
    <div className={`rounded border p-3 ${highlight ? 'border-emerald-300 bg-emerald-50' : 'border-gray-200'}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${highlight ? 'text-emerald-700' : ''}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}

function SummaryList({
  title,
  items,
  tone,
}: {
  title: string
  items: { goods_no: string; title: string; note: string }[]
  tone: 'emerald' | 'red'
}) {
  const border = tone === 'emerald' ? 'border-emerald-200' : 'border-red-200'
  return (
    <div className={`rounded border ${border} p-3`}>
      <div className="text-sm font-semibold text-gray-700 mb-2">
        {title} <span className="text-gray-400 font-normal">({items.length})</span>
      </div>
      {items.length === 0 ? (
        <div className="text-xs text-gray-400">없음</div>
      ) : (
        <ul className="space-y-1 max-h-64 overflow-y-auto">
          {items.map((it) => (
            <li key={it.goods_no} className="flex justify-between gap-2 text-xs">
              <span className="truncate text-gray-700" title={it.title}>
                {it.title}
              </span>
              <span className="text-gray-400 flex-shrink-0 font-mono">{it.note}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
