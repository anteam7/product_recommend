import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import type { Tables } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

type PinRow = Tables<'jimscanner_trends_pins'>

type DecayRow = {
  keyword: string
  source: string
  final_score_latest: number | null
  final_slope_window: number | null
  competition_score_latest: number | null
  pin_health_score: number | null
  pin_quadrant: string | null
}

async function fetchData(filter: string | undefined) {
  const sb = createAdminClient()

  const { data: pins } = await sb
    .from('jimscanner_trends_pins')
    .select('keyword, source, notes, pinned_at')
    .order('pinned_at', { ascending: false })

  // decay: RPC 미적용/오류시 빈 배열 fallback. 빌드 통과를 위해 as any.
  const { data: decay } = await (sb.rpc as any)('jimscanner_pin_decay', {
    days_window: 14,
  })

  const decayMap = new Map<string, DecayRow>()
  if (Array.isArray(decay)) {
    for (const d of decay as DecayRow[]) {
      decayMap.set(`${d.source}::${d.keyword}`, d)
    }
  }

  let merged = (pins ?? []).map((p) => ({
    pin: p as PinRow,
    health: decayMap.get(`${p.source}::${p.keyword}`) ?? null,
  }))

  if (filter && filter !== 'all') {
    merged = merged.filter((m) => m.health?.pin_quadrant === filter)
  }

  return { merged }
}

function quadrantBadge(q: string | null | undefined) {
  switch (q) {
    case 'alive':
      return { label: '살아있음', cls: 'bg-green-100 text-green-800 border-green-300' }
    case 'slowing':
      return { label: '둔화', cls: 'bg-yellow-100 text-yellow-800 border-yellow-300' }
    case 'saturated':
      return { label: '포화', cls: 'bg-orange-100 text-orange-800 border-orange-300' }
    case 'dead':
      return { label: '소멸', cls: 'bg-red-100 text-red-800 border-red-300' }
    default:
      return { label: '미분류', cls: 'bg-gray-100 text-gray-600 border-gray-300' }
  }
}

const FILTERS: Array<{ key: string; label: string }> = [
  { key: 'all', label: '전체' },
  { key: 'alive', label: '살아있음' },
  { key: 'slowing', label: '둔화' },
  { key: 'saturated', label: '포화' },
  { key: 'dead', label: '소멸' },
]

export default async function PinsPage({
  searchParams,
}: {
  searchParams?: Promise<{ filter?: string; sort?: string }>
}) {
  const sp = (await searchParams) ?? {}
  const filter = sp.filter ?? 'all'
  const sort = sp.sort ?? 'decay' // decay | pinned_at

  const { merged } = await fetchData(filter)

  const sorted = merged.slice().sort((a, b) => {
    if (sort === 'decay') {
      return (b.health?.pin_health_score ?? -1) - (a.health?.pin_health_score ?? -1)
    }
    return (b.pin.pinned_at ?? '').localeCompare(a.pin.pinned_at ?? '')
  })

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">핀한 상품 후보</h1>
          <p className="text-sm text-gray-500 mt-1">
            위탁 검토 후보. 핀 부패도 (14d) 와 사분면 라벨이 함께 보임.
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <Link
            href="/admin/trend-radar/pin-watchdog"
            className="px-2 py-1 rounded border border-gray-300 text-gray-700 hover:bg-gray-50"
          >
            워치독 보드 →
          </Link>
          <Link href="/admin/trend-radar" className="text-gray-700 hover:text-black underline">
            ← 대시보드
          </Link>
        </div>
      </header>

      <div className="flex flex-wrap gap-3 items-center text-sm">
        <div className="flex gap-1">
          {FILTERS.map((f) => (
            <Link
              key={f.key}
              href={`/admin/trend-radar/pins?filter=${f.key}&sort=${sort}`}
              className={`px-2 py-1 rounded border ${
                filter === f.key
                  ? 'bg-black text-white border-black'
                  : 'border-gray-300 text-gray-700 hover:bg-gray-50'
              }`}
            >
              {f.label}
            </Link>
          ))}
        </div>
        <div className="flex gap-1 ml-4">
          <span className="text-xs text-gray-500 self-center mr-1">정렬:</span>
          {(['decay', 'pinned_at'] as const).map((s) => (
            <Link
              key={s}
              href={`/admin/trend-radar/pins?filter=${filter}&sort=${s}`}
              className={`px-2 py-1 rounded border ${
                sort === s
                  ? 'bg-gray-800 text-white border-gray-800'
                  : 'border-gray-300 text-gray-700 hover:bg-gray-50'
              }`}
            >
              {s === 'decay' ? '부패도↓' : '핀 시각↓'}
            </Link>
          ))}
        </div>
      </div>

      {sorted.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">핀한 항목 없음</p>
          <p className="text-sm mt-2">
            대시보드 / 디테일 페이지에서 핀 토글.
            <br />
            현재 필터: <code>{filter}</code>
          </p>
        </div>
      ) : (
        <div className="rounded border border-gray-200 divide-y divide-gray-100">
          {sorted.map(({ pin: p, health }) => {
            const b = quadrantBadge(health?.pin_quadrant)
            return (
              <div
                key={`${p.source}::${p.keyword}`}
                className="px-4 py-3 grid grid-cols-12 items-center text-sm"
              >
                <div className="col-span-5">
                  <div className="font-medium">{p.keyword}</div>
                  {p.notes && <div className="text-xs text-gray-500 mt-1">{p.notes}</div>}
                </div>
                <div className="col-span-2 text-xs text-gray-500">{p.source}</div>
                <div className="col-span-2 text-right font-mono text-xs">
                  부패 <span className="font-semibold">{health?.pin_health_score?.toFixed(0) ?? '—'}</span>
                  <div className="text-gray-400">
                    slope {health?.final_slope_window?.toFixed(2) ?? '—'}
                  </div>
                </div>
                <div className="col-span-2 text-center">
                  <span className={`inline-block px-2 py-0.5 rounded border text-xs ${b.cls}`}>
                    {b.label}
                  </span>
                </div>
                <div className="col-span-1 text-right text-xs text-gray-400 font-mono">
                  {p.pinned_at?.slice(0, 10)}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
