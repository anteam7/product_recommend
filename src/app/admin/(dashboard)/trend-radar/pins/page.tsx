import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import type { Tables } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

type PinRow = Tables<'jimscanner_trends_pins'>
type EntryPhase = 'rush' | 'saturating' | 'cooling' | 'stable' | 'unknown'

const PHASE_BADGE: Record<EntryPhase, { label: string; cls: string }> = {
  rush:       { label: '🚀 골드러시', cls: 'bg-red-100 text-red-800 border-red-200' },
  saturating: { label: '⚠️ 포화시작',  cls: 'bg-amber-100 text-amber-800 border-amber-200' },
  cooling:    { label: '❄️ 식어감',     cls: 'bg-sky-100 text-sky-800 border-sky-200' },
  stable:     { label: '✓ 안정',       cls: 'bg-gray-100 text-gray-700 border-gray-200' },
  unknown:    { label: '?',           cls: 'bg-gray-50 text-gray-500 border-gray-200' },
}

async function fetchData() {
  const sb = createAdminClient()

  const { data: pins } = await sb
    .from('jimscanner_trends_pins')
    .select('keyword, source, notes, pinned_at')
    .order('pinned_at', { ascending: false })

  const pinRows = (pins ?? []) as PinRow[]
  const keywords = pinRows.map((p) => p.keyword)

  let phaseMap = new Map<string, EntryPhase>()
  if (keywords.length > 0) {
    const { data: phases } = await (sb as any)
      .from('serp_entry_velocity_v')
      .select('keyword, entry_phase')
      .in('keyword', keywords)
    for (const r of (phases ?? []) as { keyword: string; entry_phase: EntryPhase }[]) {
      phaseMap.set(r.keyword, r.entry_phase)
    }
  }

  return { pins: pinRows, phaseMap }
}

export default async function PinsPage() {
  const { pins, phaseMap } = await fetchData()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">핀한 상품 후보</h1>
          <p className="text-sm text-gray-500 mt-1">
            위탁 검토 후보. 진입속도 phase 배지로 골드러시·포화 변곡점 표시.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {pins.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">핀한 항목 없음</p>
          <p className="text-sm mt-2">
            대시보드 / 디테일 페이지에서 핀 토글 (다음 PR-4.5).
            <br />
            현재는 기존 v3 트렌드 레이더의 키워드 핀만 노출.
          </p>
        </div>
      ) : (
        <div className="rounded border border-gray-200 divide-y divide-gray-100">
          {pins.map((p) => {
            const phase = phaseMap.get(p.keyword)
            const badge = phase ? PHASE_BADGE[phase] : null
            return (
              <div key={`${p.source}::${p.keyword}`} className="px-4 py-3 grid grid-cols-12 items-center text-sm">
                <div className="col-span-5">
                  <div className="font-medium flex items-center gap-2">
                    <span>{p.keyword}</span>
                    {badge && (
                      <span className={`inline-block px-2 py-0.5 text-xs rounded border ${badge.cls}`}>
                        {badge.label}
                      </span>
                    )}
                  </div>
                  {p.notes && <div className="text-xs text-gray-500 mt-1">{p.notes}</div>}
                </div>
                <div className="col-span-3 text-xs text-gray-500">{p.source}</div>
                <div className="col-span-2 text-xs">
                  {phase && (
                    <Link
                      href={`/admin/trend-radar/seller-entry`}
                      className="text-blue-600 hover:underline"
                    >
                      진입속도 →
                    </Link>
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
