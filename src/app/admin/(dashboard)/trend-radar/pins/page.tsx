import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import type { Tables } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

type PinRow = Tables<'jimscanner_trends_pins'>

interface ChannelTopRow {
  goods_no: string
  top1_channel: string
  top1_margin_pct: number
  top2_channel: string | null
  top2_margin_pct: number | null
  margin_delta_pct: number
}

const CHANNEL_OPTIONS = [
  { value: '', label: '전체 채널' },
  { value: 'coupang', label: '쿠팡' },
  { value: 'naver_smartstore', label: '네이버 스토어' },
  { value: '11st', label: '11번가' },
  { value: 'gmarket', label: '지마켓' },
  { value: 'auction', label: '옥션' },
] as const

const CHANNEL_LABELS: Record<string, string> = {
  coupang: '쿠팡',
  naver_smartstore: '네이버 스토어',
  '11st': '11번가',
  gmarket: '지마켓',
  auction: '옥션',
}

const CHANNEL_BADGE: Record<string, string> = {
  coupang: 'bg-orange-100 text-orange-800 border-orange-200',
  naver_smartstore: 'bg-green-100 text-green-800 border-green-200',
  '11st': 'bg-red-100 text-red-800 border-red-200',
  gmarket: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  auction: 'bg-yellow-100 text-yellow-800 border-yellow-200',
}

async function fetchData() {
  const sb = createAdminClient()

  const { data: pins } = await sb
    .from('jimscanner_trends_pins')
    .select('keyword, source, notes, pinned_at')
    .order('pinned_at', { ascending: false })

  const pinRows = (pins ?? []) as PinRow[]

  // 각 핀의 keyword 를 SKU 식별자로 사용해 채널 매칭 (channel_match_top RPC)
  const keywords = pinRows.map((p) => p.keyword).filter(Boolean)
  let channelMap = new Map<string, ChannelTopRow>()
  if (keywords.length > 0) {
    const { data: ch } = await sb.rpc('jimscanner_channel_match_top' as never, {
      goods_nos: keywords,
    } as never)
    const rows = (ch ?? []) as ChannelTopRow[]
    for (const r of rows) channelMap.set(r.goods_no, r)
  }

  return { pins: pinRows, channelMap }
}

export default async function PinsPage({
  searchParams,
}: {
  searchParams: Promise<{ channel?: string }>
}) {
  const sp = await searchParams
  const channelFilter = sp.channel ?? ''

  const { pins, channelMap } = await fetchData()

  const filtered = channelFilter
    ? pins.filter((p) => channelMap.get(p.keyword)?.top1_channel === channelFilter)
    : pins

  function filterHref(ch: string): string {
    const params = new URLSearchParams()
    if (ch) params.set('channel', ch)
    const qs = params.toString()
    return '/admin/trend-radar/pins' + (qs ? `?${qs}` : '')
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">핀한 상품 후보</h1>
          <p className="text-sm text-gray-500 mt-1">
            위탁 검토 후보. 채널 필터로 Top1 추천 채널 기준 좁히기.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 채널 필터 드롭다운 */}
      <div className="flex flex-wrap items-center gap-2 rounded border border-gray-200 px-4 py-3">
        <span className="text-xs text-gray-500">채널 필터:</span>
        {CHANNEL_OPTIONS.map((opt) => (
          <Link
            key={opt.value || 'all'}
            href={filterHref(opt.value)}
            className={`px-2 py-1 text-xs rounded ${
              channelFilter === opt.value
                ? 'bg-black text-white font-semibold'
                : 'text-gray-500 hover:text-black'
            }`}
          >
            {opt.label}
          </Link>
        ))}
        <span className="ml-auto text-xs text-gray-400">
          {filtered.length} / {pins.length} 핀
        </span>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">
            {channelFilter ? '해당 채널 추천 핀 없음' : '핀한 항목 없음'}
          </p>
          <p className="text-sm mt-2">
            대시보드 / 디테일 페이지에서 핀 토글. 채널 추천은 supabase/channel_metrics.sql RPC 기반.
          </p>
        </div>
      ) : (
        <div className="rounded border border-gray-200 divide-y divide-gray-100">
          {filtered.map((p) => {
            const ch = channelMap.get(p.keyword)
            return (
              <div key={`${p.source}::${p.keyword}`} className="px-4 py-3 grid grid-cols-12 items-center text-sm gap-2">
                <div className="col-span-5">
                  <div className="font-medium">{p.keyword}</div>
                  {p.notes && <div className="text-xs text-gray-500 mt-1">{p.notes}</div>}
                </div>
                <div className="col-span-2 text-xs text-gray-500">{p.source}</div>
                <div className="col-span-3 text-xs">
                  {ch ? (
                    <div className="flex items-center gap-1 flex-wrap">
                      <span
                        className={`px-2 py-0.5 rounded border text-[11px] font-semibold ${
                          CHANNEL_BADGE[ch.top1_channel] ?? 'bg-gray-100 text-gray-700 border-gray-200'
                        }`}
                      >
                        {CHANNEL_LABELS[ch.top1_channel] ?? ch.top1_channel}
                      </span>
                      <span className="font-mono text-gray-600">
                        {Number(ch.top1_margin_pct).toFixed(1)}%
                      </span>
                      <span className="text-[10px] text-gray-400">
                        Δ{Number(ch.margin_delta_pct).toFixed(1)}pp
                      </span>
                    </div>
                  ) : (
                    <span className="text-[10px] text-gray-400">채널 매칭 없음</span>
                  )}
                </div>
                <div className="col-span-2 text-right text-xs text-gray-400 font-mono">
                  {p.pinned_at?.slice(0, 16)}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
