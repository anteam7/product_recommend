import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import type { Tables } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

type PinRow = Tables<'jimscanner_trends_pins'>

interface GiftIntentRow {
  keyword: string
  gift_share: number
  occasion_breakdown: Record<string, number>
  sample_count: number
  computed_at: string
}

const OCCASIONS = [
  '선물',
  '기념일',
  '집들이',
  '졸업',
  '입학',
  '어버이날',
  '발렌타인',
  '화이트데이',
  '빼빼로데이',
  '생일',
  '돌잔치',
  '웨딩',
]

async function fetchData() {
  const sb = createAdminClient()

  const [pinsRes, giftRes] = await Promise.all([
    sb
      .from('jimscanner_trends_pins')
      .select('keyword, source, notes, pinned_at')
      .order('pinned_at', { ascending: false }),
    (sb as any)
      .from('jimscanner_gift_intent_scores')
      .select('keyword, gift_share, occasion_breakdown, sample_count, computed_at')
      .order('computed_at', { ascending: false })
      .limit(2000),
  ])

  const pins = (pinsRes.data ?? []) as PinRow[]

  // gift_intent: 키워드별 최신만
  const seen = new Set<string>()
  const giftByKw = new Map<string, GiftIntentRow>()
  for (const r of (giftRes.data ?? []) as GiftIntentRow[]) {
    if (seen.has(r.keyword)) continue
    seen.add(r.keyword)
    giftByKw.set(r.keyword, r)
  }
  return { pins, giftByKw }
}

export default async function PinsPage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string; occasion?: string }>
}) {
  const { pins, giftByKw } = await fetchData()
  const params = await searchParams
  const sort = params.sort ?? 'pinned_at'
  const occasionFilter = params.occasion ?? ''

  const enriched = pins.map((p) => {
    const gift = giftByKw.get(p.keyword)
    return {
      ...p,
      gift_share: gift?.gift_share ?? 0,
      occasion_breakdown: gift?.occasion_breakdown ?? {},
    }
  })

  const filtered = occasionFilter
    ? enriched.filter((p) => (p.occasion_breakdown?.[occasionFilter] ?? 0) > 0)
    : enriched

  const sorted = [...filtered].sort((a, b) => {
    if (sort === 'gift') return b.gift_share - a.gift_share
    return (b.pinned_at ?? '').localeCompare(a.pinned_at ?? '')
  })

  function linkFor(opts: { sort?: string; occasion?: string }) {
    const sp = new URLSearchParams()
    const s = opts.sort ?? sort
    const o = opts.occasion ?? occasionFilter
    if (s && s !== 'pinned_at') sp.set('sort', s)
    if (o) sp.set('occasion', o)
    const qs = sp.toString()
    return qs ? `?${qs}` : '/admin/trend-radar/pins'
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">핀한 상품 후보</h1>
          <p className="text-sm text-gray-500 mt-1">
            위탁 검토 후보. Gift-friendly 정렬과 occasion 필터로 마진 윈도우 큰 후보를 우선 확인.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 정렬 + occasion 필터 */}
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <div className="flex gap-1">
          <Link
            href={linkFor({ sort: 'pinned_at' })}
            className={`px-2 py-1 rounded border text-xs ${
              sort === 'pinned_at' ? 'bg-black text-white border-black' : 'border-gray-300 text-gray-700'
            }`}
          >
            최신
          </Link>
          <Link
            href={linkFor({ sort: 'gift' })}
            className={`px-2 py-1 rounded border text-xs ${
              sort === 'gift' ? 'bg-violet-600 text-white border-violet-600' : 'border-gray-300 text-gray-700'
            }`}
          >
            🎁 Gift-friendly
          </Link>
        </div>
        <div className="flex flex-wrap gap-1">
          <Link
            href={linkFor({ occasion: '' })}
            className={`px-2 py-1 rounded border text-xs ${
              occasionFilter === '' ? 'bg-black text-white border-black' : 'border-gray-300 text-gray-700'
            }`}
          >
            전체
          </Link>
          {OCCASIONS.map((o) => (
            <Link
              key={o}
              href={linkFor({ occasion: o })}
              className={`px-2 py-1 rounded border text-xs ${
                occasionFilter === o ? 'bg-violet-600 text-white border-violet-600' : 'border-gray-300 text-gray-700'
              }`}
            >
              {o}
            </Link>
          ))}
        </div>
      </div>

      {sorted.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">
            {occasionFilter ? `'${occasionFilter}' 매칭 핀 없음` : '핀한 항목 없음'}
          </p>
          <p className="text-sm mt-2">
            대시보드 / 디테일 페이지에서 핀 토글.
            <br />
            Gift Intent 점수는 <Link href="/admin/trend-radar/gift-intent" className="underline">/admin/trend-radar/gift-intent</Link> 에서 확인.
          </p>
        </div>
      ) : (
        <div className="rounded border border-gray-200 divide-y divide-gray-100">
          {sorted.map((p) => {
            const sharePct = (p.gift_share * 100).toFixed(0)
            const topOccasions = Object.entries(p.occasion_breakdown ?? {})
              .sort((a, b) => b[1] - a[1])
              .slice(0, 3)
            return (
              <div
                key={`${p.source}::${p.keyword}`}
                className="px-4 py-3 grid grid-cols-12 items-center text-sm gap-2"
              >
                <div className="col-span-5">
                  <div className="font-medium">{p.keyword}</div>
                  {p.notes && <div className="text-xs text-gray-500 mt-1">{p.notes}</div>}
                </div>
                <div className="col-span-2 text-xs text-gray-500">{p.source}</div>
                <div className="col-span-3 flex flex-wrap gap-1">
                  {topOccasions.map(([k, v]) => (
                    <span
                      key={k}
                      className="px-1.5 py-0.5 rounded bg-violet-50 border border-violet-200 text-violet-700 text-[10px]"
                    >
                      {k} {(v * 100).toFixed(0)}%
                    </span>
                  ))}
                </div>
                <div className="col-span-1 text-right text-xs font-mono">
                  {p.gift_share > 0 ? (
                    <span className="text-violet-700">{sharePct}%</span>
                  ) : (
                    <span className="text-gray-300">—</span>
                  )}
                </div>
                <div className="col-span-1 text-right text-[10px] text-gray-400 font-mono">
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
