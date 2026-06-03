import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { SHIP, FEE_RATE, computeHeadroom } from '@/lib/coupang/price'

export const dynamic = 'force-dynamic'

// jimscanner_trends_wtp 는 generated 타입 미반영 — supabase/trends_wtp.sql 적용 후 `npm run gen:types` 시 `as any` 제거.
interface WtpRow {
  product_id: string
  wtp_low: number | null
  wtp_mid: number | null
  wtp_high: number | null
  sample_count: number
  confidence: number
  evidence: { method?: string; tv_anchors?: unknown[]; explicit_prices?: unknown[]; modifiers?: unknown[] } | null
  computed_at: string
}

interface FitRow {
  productId: string
  name: string
  category: string
  wtpLow: number | null
  wtpMid: number | null
  wtpHigh: number | null
  confidence: number
  sampleCount: number
  method: string
  dome: number | null
  floor: number | null
  headroom: number | null
  headroomPct: number | null
  verdict: 'kill' | 'tight' | 'power' | 'unknown'
}

const TARGET_MARGIN = 3000 // 위탁 최소 목표 마진(원) — 필수 바닥가 산정 기준

async function fetchFitRows(): Promise<{ rows: FitRow[]; error: string | null }> {
  const sb = createAdminClient()

  // 최신 WTP 만 (product_id 별 latest)
  const { data: wtpData, error: wtpErr } = await sb
    .from('jimscanner_trends_wtp' as never)
    .select('product_id, wtp_low, wtp_mid, wtp_high, sample_count, confidence, evidence, computed_at')
    .order('computed_at', { ascending: false })
    .limit(3000)

  if (wtpErr) return { rows: [], error: wtpErr.message }

  const latestWtp = new Map<string, WtpRow>()
  for (const w of ((wtpData ?? []) as unknown as WtpRow[])) {
    if (!latestWtp.has(w.product_id)) latestWtp.set(w.product_id, w)
  }

  const ids = [...latestWtp.keys()]
  if (ids.length === 0) return { rows: [], error: null }

  const { data: prods } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top')
    .in('id', ids)
  const byId = new Map((prods ?? []).map((p: { id: string; canonical_name: string; category_top: string }) => [p.id, p]))

  // 도매 원가: 상품별 최저 ggsan 도매가 (가장 보수적인 바닥가 산정)
  const { data: supplier } = await sb
    .from('jimscanner_trends_supplier')
    .select('product_id, price_krw')
    .in('product_id', ids)
  const domeById = new Map<string, number>()
  for (const s of (supplier ?? []) as { product_id: string; price_krw: number | null }[]) {
    if (s.price_krw == null) continue
    const cur = domeById.get(s.product_id)
    if (cur == null || s.price_krw < cur) domeById.set(s.product_id, s.price_krw)
  }

  const rows: FitRow[] = ids.map((id) => {
    const w = latestWtp.get(id)!
    const p = byId.get(id) as { canonical_name?: string; category_top?: string } | undefined
    const dome = domeById.get(id) ?? null
    const { floor, headroom, headroomPct, verdict } =
      dome == null
        ? { floor: null, headroom: null, headroomPct: null, verdict: 'unknown' as const }
        : computeHeadroom(w.wtp_high, dome, TARGET_MARGIN)
    return {
      productId: id,
      name: p?.canonical_name ?? '?',
      category: p?.category_top ?? '—',
      wtpLow: w.wtp_low,
      wtpMid: w.wtp_mid,
      wtpHigh: w.wtp_high,
      confidence: Number(w.confidence ?? 0),
      sampleCount: w.sample_count ?? 0,
      method: w.evidence?.method ?? 'regex_v1',
      dome,
      floor: floor != null && Number.isFinite(floor) ? floor : null,
      headroom,
      headroomPct,
      verdict,
    }
  })

  // 헤드룸 넓은 순 (가격결정력 큰 순), 미산정은 뒤로
  rows.sort((a, b) => {
    const av = a.headroom ?? Number.NEGATIVE_INFINITY
    const bv = b.headroom ?? Number.NEGATIVE_INFINITY
    return bv - av
  })

  return { rows, error: null }
}

const won = (n: number | null) => (n == null ? '—' : `${Math.round(n).toLocaleString()}원`)

const VERDICT_META: Record<FitRow['verdict'], { label: string; cls: string }> = {
  power: { label: '💪 가격결정력', cls: 'bg-emerald-100 text-emerald-800' },
  tight: { label: '⚠️ 박빙', cls: 'bg-amber-100 text-amber-800' },
  kill: { label: '☠️ 마진불가', cls: 'bg-red-100 text-red-800' },
  unknown: { label: '… 데이터부족', cls: 'bg-gray-100 text-gray-500' },
}

export default async function PriceFitPage() {
  const { rows, error } = await fetchFitRows()

  const killCount = rows.filter((r) => r.verdict === 'kill').length
  const powerCount = rows.filter((r) => r.verdict === 'power').length
  const tightCount = rows.filter((r) => r.verdict === 'tight').length

  // 헤드룸 막대 정규화 기준 (양수 헤드룸 최대값)
  const maxHeadroom = Math.max(1, ...rows.map((r) => Math.max(0, r.headroom ?? 0)))

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">💰 WTP 가격핏 게이트</h1>
          <p className="text-sm text-gray-500 mt-1">
            수요측 지불의사(WTP) 천장 vs 쿠팡 필수 바닥가(도매+SHIP {SHIP.toLocaleString()}·FEE {(FEE_RATE * 100).toFixed(1)}%·VAT) —
            <strong> 헤드룸 = WTP천장 − 필수바닥가</strong>. 음수면 애초에 마진이 안 나는 상품(조기 킬).
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Kpi label="평가 상품" value={rows.length} />
        <Kpi label="💪 가격결정력" value={powerCount} tone="emerald" />
        <Kpi label="⚠️ 박빙(<15%)" value={tightCount} tone="amber" />
        <Kpi label="☠️ 마진불가" value={killCount} tone="red" />
      </section>

      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
          조회 에러: <code className="font-mono text-xs">{error}</code>
          <p className="text-xs mt-2 text-red-700">
            테이블 <code>jimscanner_trends_wtp</code> 미적용 가능성 — supabase/trends_wtp.sql 적용 필요.
          </p>
        </div>
      )}

      {!error && rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">아직 WTP 추출 데이터 없음</div>
          <div className="text-xs text-gray-400">
            <code>node scripts/trends-extract-wtp.mjs</code> 실행 후 누적됨 (recompute 크론 스텝).
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => {
            const vm = VERDICT_META[r.verdict]
            const barPct = r.headroom != null && r.headroom > 0 ? Math.min(100, (r.headroom / maxHeadroom) * 100) : 0
            return (
              <div
                key={r.productId}
                className={`rounded border p-3 ${r.verdict === 'kill' ? 'border-red-200 bg-red-50/40' : 'border-gray-200'}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium leading-snug" title={r.name}>
                      {r.name}
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      {r.category} · 근거 {r.sampleCount}건 · 신뢰도 {(r.confidence * 100).toFixed(0)}% · {r.method}
                    </div>
                  </div>
                  <span className={`shrink-0 text-xs px-2 py-0.5 rounded font-semibold ${vm.cls}`}>{vm.label}</span>
                </div>

                {/* 헤드룸 막대: 바닥가(회색) → 헤드룸(초록/빨강) */}
                <div className="mt-2">
                  <div className="h-3 w-full rounded bg-gray-100 overflow-hidden flex">
                    <div className="h-full bg-gray-300" style={{ width: '38%' }} title={`필수 바닥가 ${won(r.floor)}`} />
                    <div
                      className={`h-full ${r.verdict === 'kill' ? 'bg-red-400' : 'bg-emerald-400'}`}
                      style={{ width: `${(barPct / 100) * 62}%` }}
                      title={`헤드룸 ${won(r.headroom)}`}
                    />
                  </div>
                  <div className="mt-1 grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px] font-mono text-gray-600">
                    <span>도매 {won(r.dome)}</span>
                    <span>바닥가 {won(r.floor)}</span>
                    <span>
                      WTP {won(r.wtpLow)}/<strong>{won(r.wtpMid)}</strong>/{won(r.wtpHigh)}
                    </span>
                    <span className={r.headroom != null && r.headroom < 0 ? 'text-red-600 font-semibold' : 'text-emerald-700 font-semibold'}>
                      헤드룸 {won(r.headroom)}
                      {r.headroomPct != null && ` (${r.headroomPct}%)`}
                    </span>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 필수 바닥가 공식</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          floor = (도매 + SHIP {SHIP.toLocaleString()} + 목표마진 {TARGET_MARGIN.toLocaleString()}) / (1 − FEE {FEE_RATE} − 1/11)
          <br />
          headroom = wtp_high − floor · verdict = headroom&lt;0 ? 킬 : (headroom/wtp&lt;15% ? 박빙 : 결정력)
        </code>
        <p className="pt-1">
          WTP 밴드는 키워드/alias 가격수식어(가성비·1만원대·프리미엄)와 naver_tvtime 방송 판매가 앵커에서 역추출 (supabase/trends_wtp.sql).
        </p>
      </section>
    </div>
  )
}

function Kpi({ label, value, tone }: { label: string; value: number; tone?: 'emerald' | 'amber' | 'red' }) {
  const toneCls =
    tone === 'emerald' ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
    : tone === 'amber' ? 'border-amber-300 bg-amber-50 text-amber-700'
    : tone === 'red' ? 'border-red-300 bg-red-50 text-red-700'
    : 'border-gray-200'
  return (
    <div className={`rounded border p-3 ${toneCls}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-2xl font-bold mt-1">{value.toLocaleString()}</div>
    </div>
  )
}
