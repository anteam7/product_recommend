import { createAdminClient } from '@/lib/auth/admin-supabase'

// 소싱 채널 차익 보드 — 국내도매 vs 해외직소싱 랜디드코스트 비교
// 동일 canonical 상품을 어느 소싱 경로가 가장 싸게 들이는지 한 화면에 비교한다.
// 쿠팡 손익분기가 = (landed_cost + SHIP) / (1 - FEE)  ← coupang_pricing_model 상수 재사용
export const dynamic = 'force-dynamic'

// coupang_pricing_model 상수 (기타영양제 73137 실판매수수료 기준, 결제비 포함)
const COUPANG_SHIP = 3000
const COUPANG_FEE = 0.106

const DOMESTIC = new Set(['domeggook', 'ownerclan'])

function breakeven(landed: number | null): number | null {
  if (landed == null) return null
  return Math.round((landed + COUPANG_SHIP) / (1 - COUPANG_FEE))
}

function won(n: number | null): string {
  if (n == null) return '—'
  return Math.round(n).toLocaleString('ko-KR') + '원'
}

interface SupplierRow {
  product_id: string
  supplier_source: string | null
  price_krw: number | null
  price_original: number | null
  moq: number | null
  lead_time_days: number | null
  inventory_status: string | null
}

interface Chan {
  source: string
  landed: number
  moq: number
  lead: number | null
  domestic: boolean
}

type BadgeTone = 'green' | 'amber' | 'blue'
interface Badge {
  tone: BadgeTone
  label: string
}

interface BoardRow {
  pid: string
  name: string
  channelCount: number
  chans: Chan[]
  minDomestic: number | null
  minOverseas: number | null
  best: number | null
  gapPct: number | null
  badges: Badge[]
}

export default async function SourcingArbitrageBoard() {
  const sb = createAdminClient()

  let suppliers: SupplierRow[] = []
  let products: Record<string, unknown>[] = []
  let loadError: string | null = null
  try {
    const sres = await (sb as any)
      .from('jimscanner_trends_supplier')
      .select(
        'product_id, supplier_source, price_krw, price_original, moq, lead_time_days, inventory_status'
      )
    if (sres.error) throw sres.error
    suppliers = (sres.data ?? []) as SupplierRow[]
    // canonical 상품 테이블 (이름 표시용) — 컬럼 네이밍 방어적 처리
    const pres = await (sb as any).from('jimscanner_trends_products').select('*')
    products = (pres.data ?? []) as Record<string, unknown>[]
  } catch (e) {
    loadError = e instanceof Error ? e.message : String(e)
  }

  // product_id -> 표시 이름
  const nameOf = new Map<string, string>()
  for (const p of products) {
    const id = (p.id ?? p.product_id) as string | undefined
    if (!id) continue
    const nm =
      (p.canonical_name as string) ||
      (p.title as string) ||
      (p.name as string) ||
      (p.brand as string) ||
      String(id).slice(0, 8)
    nameOf.set(id, nm)
  }

  // product_id 별 채널 집계
  const byProduct = new Map<string, SupplierRow[]>()
  for (const s of suppliers) {
    if (!s.product_id || s.price_krw == null) continue
    const arr = byProduct.get(s.product_id) ?? []
    arr.push(s)
    byProduct.set(s.product_id, arr)
  }

  const minLanded = (arr: SupplierRow[]): number | null =>
    arr.length ? Math.min(...arr.map((c) => Number(c.price_krw))) : null

  const rows: BoardRow[] = []
  for (const [pid, chans] of byProduct.entries()) {
    const domestic = chans.filter((c) => DOMESTIC.has(c.supplier_source ?? ''))
    const overseas = chans.filter((c) => !DOMESTIC.has(c.supplier_source ?? ''))
    const minDomestic = minLanded(domestic)
    const minOverseas = minLanded(overseas)
    const best = minLanded(chans)

    let gapPct: number | null = null
    if (minDomestic != null && minOverseas != null && minDomestic > 0) {
      gapPct = Math.round(((minDomestic - minOverseas) / minDomestic) * 1000) / 10
    }

    const instantConsign = domestic.some(
      (c) => (c.moq ?? 1) <= 1 && (c.lead_time_days ?? 0) <= 1
    )
    const overseasBulk = overseas.some((c) => (c.moq ?? 1) > 1)

    const badges: Badge[] = []
    // ① 해외직소싱이 국내도매보다 15%+ 싸 → 사입전환 가치
    if (gapPct != null && gapPct >= 15) {
      badges.push({ tone: 'green', label: '사입전환 -' + gapPct + '%' })
    }
    // ② 국내도매 미연결(해외만) → 위탁 불가한 발굴공백
    if (minDomestic == null && minOverseas != null) {
      badges.push({ tone: 'amber', label: '위탁불가·발굴공백' })
    }
    // ③ MOQ1·리드0 위탁 vs MOQ高 해외사입 트레이드오프
    if (instantConsign && overseasBulk) {
      badges.push({ tone: 'blue', label: '위탁즉시 vs 사입MOQ' })
    }

    rows.push({
      pid,
      name: nameOf.get(pid) ?? String(pid).slice(0, 8),
      channelCount: chans.length,
      chans: chans
        .map(
          (c): Chan => ({
            source: c.supplier_source ?? '?',
            landed: Number(c.price_krw),
            moq: c.moq ?? 1,
            lead: c.lead_time_days ?? null,
            domestic: DOMESTIC.has(c.supplier_source ?? ''),
          })
        )
        .sort((a, b) => a.landed - b.landed),
      minDomestic,
      minOverseas,
      best,
      gapPct,
      badges,
    })
  }

  // 정렬: 차익(해외가 싼 정도) 큰 순 → 발굴공백 → 채널수
  rows.sort((a, b) => {
    const ga = a.gapPct ?? -999
    const gb = b.gapPct ?? -999
    if (gb !== ga) return gb - ga
    return b.channelCount - a.channelCount
  })

  const toneClass: Record<BadgeTone, string> = {
    green: 'bg-emerald-100 text-emerald-800',
    amber: 'bg-amber-100 text-amber-800',
    blue: 'bg-sky-100 text-sky-800',
  }

  return (
    <div className="space-y-4 p-6">
      <header>
        <h1 className="text-2xl font-bold">소싱 채널 차익 보드</h1>
        <p className="mt-1 text-sm text-gray-500">
          동일 상품을 어느 소싱 경로가 가장 싸게 들이는가 — 국내도매(domeggook·ownerclan) vs
          해외직소싱(1688·aliexpress·temu)의 랜디드코스트 횡비교. 쿠팡 손익분기가는 (랜디드코스트 +{' '}
          {won(COUPANG_SHIP)}) ÷ (1 − {Math.round(COUPANG_FEE * 1000) / 10}%) 로 계산.
        </p>
      </header>

      {loadError && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          데이터 로드 경고: {loadError}
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left">
            <tr>
              <th className="px-3 py-2">상품</th>
              <th className="px-3 py-2 text-right">채널</th>
              <th className="px-3 py-2 text-right">국내최저</th>
              <th className="px-3 py-2 text-right">해외최저</th>
              <th className="px-3 py-2 text-right">국내↔해외 갭</th>
              <th className="px-3 py-2 text-right">최저 손익분기가</th>
              <th className="px-3 py-2">채널별 랜디드코스트</th>
              <th className="px-3 py-2">시그널</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className="px-3 py-6 text-center text-gray-500" colSpan={8}>
                  소싱 채널 데이터가 없습니다.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.pid} className="border-t border-gray-100 align-top">
                  <td className="px-3 py-2 font-medium">{r.name}</td>
                  <td className="px-3 py-2 text-right">{r.channelCount}</td>
                  <td className="px-3 py-2 text-right">{won(r.minDomestic)}</td>
                  <td className="px-3 py-2 text-right">{won(r.minOverseas)}</td>
                  <td className="px-3 py-2 text-right">
                    {r.gapPct == null ? (
                      '—'
                    ) : (
                      <span className={r.gapPct >= 0 ? 'text-emerald-700' : 'text-rose-700'}>
                        {r.gapPct > 0 ? '해외 -' + r.gapPct + '%' : r.gapPct + '%'}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">{won(breakeven(r.best))}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {r.chans.map((c, i) => (
                        <span
                          key={i}
                          className={
                            'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs ' +
                            (c.domestic
                              ? 'bg-slate-100 text-slate-700'
                              : 'bg-indigo-50 text-indigo-700')
                          }
                          title={'MOQ ' + c.moq + (c.lead != null ? ' · 리드 ' + c.lead + '일' : '')}
                        >
                          {c.source} {won(c.landed)}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {r.badges.length === 0 ? (
                        <span className="text-xs text-gray-400">—</span>
                      ) : (
                        r.badges.map((b, i) => (
                          <span
                            key={i}
                            className={
                              'rounded px-1.5 py-0.5 text-xs font-medium ' + toneClass[b.tone]
                            }
                          >
                            {b.label}
                          </span>
                        ))
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
