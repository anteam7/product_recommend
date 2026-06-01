import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { computeViableFloor, MIN_MARGIN_PCT, SHIP } from '@/lib/coupang/price'

export const dynamic = 'force-dynamic'

// 직배(소비자 직구) 공급원 — 위탁 셀러가 가격에서 직접 깨지는 위협 축
const DIRECT_SOURCES = ['aliexpress', 'temu', '1688']
// 국내 위탁 도매원가 후보 (바닥가 계산 기준)
const WHOLESALE_SOURCES = ['domeggook', 'ownerclan', 'ggsan']

interface SupplierRow {
  product_id: string
  supplier_source: string
  supplier_url: string | null
  title: string | null
  price_krw: number | null
}

interface ProductRow {
  id: string
  canonical_name: string
  category_top: string
}

type Zone = 'red' | 'yellow' | 'amber' | 'green'

interface ThreatRow {
  id: string
  name: string
  category: string
  dome: number // 국내 도매원가 (바닥가 계산 입력)
  floor: number // 내 viable 쿠팡 바닥가
  directBest: number // 알리/테무/1688 직배 최저가
  directSource: string
  directUrl: string | null
  penetration: number // directBest / floor
  zone: Zone
}

function zoneOf(penetration: number): Zone {
  if (penetration <= 1.0) return 'red' // 직배 ≤ 내 바닥가 → 회피
  if (penetration <= 1.3) return 'yellow' // 박리 구간
  if (penetration <= 1.5) return 'amber' // 주의
  return 'green' // 국내 프리미엄 여지
}

const ZONE_META: Record<Zone, { label: string; bar: string; chip: string; desc: string }> = {
  red: { label: '회피', bar: 'bg-red-500', chip: 'bg-red-100 text-red-700', desc: '직배가 ≤ 내 바닥가 — 등록하면 가격에서 진다' },
  yellow: { label: '박리', bar: 'bg-yellow-400', chip: 'bg-yellow-100 text-yellow-800', desc: '직배가가 바닥가의 1.0~1.3x — 마진 얇음' },
  amber: { label: '주의', bar: 'bg-amber-400', chip: 'bg-amber-100 text-amber-800', desc: '직배가가 바닥가의 1.3~1.5x — 여지 적음' },
  green: { label: '프리미엄', bar: 'bg-emerald-500', chip: 'bg-emerald-100 text-emerald-700', desc: '직배가 > 바닥가 1.5x — 국내 프리미엄 가능' },
}

async function fetchData() {
  const sb = createAdminClient()

  const { data: suppliers } = await sb
    .from('jimscanner_trends_supplier')
    .select('product_id, supplier_source, supplier_url, title, price_krw')
    .order('collected_at', { ascending: false })
    .limit(5000)

  const rows = (suppliers ?? []) as SupplierRow[]
  if (rows.length === 0) return { threats: [], white: [] }

  // product_id 별로 최저 도매가 / 최저 직배가 집계
  const agg = new Map<
    string,
    { dome: number | null; direct: { price: number; source: string; url: string | null } | null; hasDirect: boolean }
  >()

  for (const r of rows) {
    const price = typeof r.price_krw === 'number' ? r.price_krw : null
    let cur = agg.get(r.product_id)
    if (!cur) {
      cur = { dome: null, direct: null, hasDirect: false }
      agg.set(r.product_id, cur)
    }
    const src = (r.supplier_source ?? '').toLowerCase()
    if (DIRECT_SOURCES.includes(src)) {
      cur.hasDirect = true
      if (price !== null && price > 0 && (cur.direct === null || price < cur.direct.price)) {
        cur.direct = { price, source: src, url: r.supplier_url }
      }
    } else if (WHOLESALE_SOURCES.includes(src)) {
      if (price !== null && price > 0 && (cur.dome === null || price < cur.dome)) {
        cur.dome = price
      }
    }
  }

  const ids = [...agg.keys()]
  const { data: prods } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name, category_top')
    .in('id', ids)
  const byId = new Map(((prods ?? []) as ProductRow[]).map((p) => [p.id, p]))

  const threats: ThreatRow[] = []
  const white: { id: string; name: string; category: string; dome: number | null; floor: number | null }[] = []

  for (const [id, a] of agg) {
    const p = byId.get(id)
    if (!p) continue
    const name = p.canonical_name ?? '?'
    const category = p.category_top ?? 'all'

    // 직배 row 가 없는 상품 = 직구 무방비 화이트존 (국내전 유리)
    if (!a.hasDirect || !a.direct) {
      const floor = a.dome !== null ? computeViableFloor(a.dome) : null
      white.push({ id, name, category, dome: a.dome, floor })
      continue
    }

    // 직배는 있는데 국내 도매원가가 없으면 바닥가 계산 불가 → 화이트존에 보류 표시
    if (a.dome === null) {
      white.push({ id, name, category, dome: null, floor: null })
      continue
    }

    const floor = computeViableFloor(a.dome)
    if (floor === null) continue
    const penetration = a.direct.price / floor
    threats.push({
      id,
      name,
      category,
      dome: a.dome,
      floor,
      directBest: a.direct.price,
      directSource: a.direct.source,
      directUrl: a.direct.url,
      penetration,
      zone: zoneOf(penetration),
    })
  }

  // 위협 큰 순(침투율 낮은 순 = 빨강 먼저)
  threats.sort((x, y) => x.penetration - y.penetration)
  white.sort((x, y) => x.name.localeCompare(y.name))

  return { threats, white }
}

const won = (n: number) => '₩' + Math.round(n).toLocaleString('ko-KR')

export default async function DumpingThreatPage() {
  const { threats, white } = await fetchData()

  const counts: Record<Zone, number> = { red: 0, yellow: 0, amber: 0, green: 0 }
  for (const t of threats) counts[t.zone]++

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">직구 덤핑 위협 게이트</h1>
          <p className="mt-1 text-sm text-gray-500">
            알리·테무·1688 직배 도착가 vs 내 쿠팡 바닥가(도매원가+수수료 {(0.106 * 100).toFixed(1)}%+배송 {won(SHIP)}+최소마진{' '}
            {(MIN_MARGIN_PCT * 100).toFixed(0)}%). 침투율 = 직배가 ÷ 내 바닥가.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 underline hover:text-black">
          ← 대시보드
        </Link>
      </header>

      {/* 존 요약 */}
      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {(['red', 'yellow', 'amber', 'green'] as Zone[]).map((z) => (
          <div key={z} className="rounded border border-gray-200 p-3">
            <div className="flex items-center gap-2">
              <span className={`inline-block h-3 w-3 rounded-full ${ZONE_META[z].bar}`} />
              <span className="text-xs font-medium text-gray-600">{ZONE_META[z].label}</span>
            </div>
            <div className="mt-1 text-2xl font-bold">{counts[z]}</div>
            <div className="mt-1 text-[11px] leading-tight text-gray-400">{ZONE_META[z].desc}</div>
          </div>
        ))}
      </section>

      {threats.length === 0 && white.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          아직 supplier 데이터 없음. cron 누적 후 다시 방문.
        </div>
      ) : null}

      {/* 위협 보드 */}
      {threats.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold">위협 보드 ({threats.length})</h2>
          <div className="divide-y divide-gray-100 rounded border border-gray-200">
            {threats.map((t) => {
              const meta = ZONE_META[t.zone]
              // 바닥가 = 100% 기준, 직배가 위치를 막대로. 최대 200% 까지 표시.
              const pct = Math.min(t.penetration, 2) / 2 * 100
              return (
                <div key={t.id} className="grid grid-cols-12 items-center gap-2 px-3 py-2 text-sm">
                  <div className="col-span-4 min-w-0">
                    <Link href={`/admin/trend-radar/products/${t.id}`} className="block truncate font-medium hover:underline">
                      {t.name}
                    </Link>
                    <div className="text-[11px] text-gray-400">{t.category}</div>
                  </div>
                  <div className="col-span-1">
                    <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${meta.chip}`}>{meta.label}</span>
                  </div>
                  <div className="col-span-4">
                    <div className="relative h-3 w-full overflow-hidden rounded bg-gray-100">
                      <div className={`h-full ${meta.bar}`} style={{ width: `${pct}%` }} />
                      {/* 바닥가(100%) 기준선 = 막대 중앙(직배=바닥가) */}
                      <div className="absolute top-0 h-full border-l border-gray-400" style={{ left: '50%' }} />
                    </div>
                    <div className="mt-0.5 text-[10px] text-gray-400">바닥가 {won(t.floor)} · 직배 {won(t.directBest)} ({t.directSource})</div>
                  </div>
                  <div className="col-span-2 text-right font-mono text-xs">
                    <span className={t.penetration <= 1 ? 'font-bold text-red-600' : 'text-gray-700'}>
                      {(t.penetration * 100).toFixed(0)}%
                    </span>
                  </div>
                  <div className="col-span-1 text-right">
                    {t.directUrl ? (
                      <a
                        href={t.directUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[11px] text-blue-600 hover:underline"
                      >
                        직배↗
                      </a>
                    ) : (
                      <span className="text-[11px] text-gray-300">—</span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* 화이트존: 직구 무방비 */}
      {white.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold">
            화이트존 — 직구 무방비 ({white.length}){' '}
            <span className="font-normal text-gray-400">알리·테무·1688 직배 row 없음 = 국내전 유리</span>
          </h2>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-3">
            {white.map((w) => (
              <Link
                key={w.id}
                href={`/admin/trend-radar/products/${w.id}`}
                className="rounded border border-emerald-200 bg-emerald-50/40 px-3 py-2 hover:bg-emerald-50"
              >
                <div className="truncate text-sm font-medium">{w.name}</div>
                <div className="text-[11px] text-gray-500">
                  {w.category}
                  {w.floor !== null ? ` · 바닥가 ${won(w.floor)}` : ' · 도매원가 미확보'}
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
