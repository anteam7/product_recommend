import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import type { Tables } from '@/lib/supabase'
import { summarizePersona, type DemographicCell } from '@/lib/trends/demographics'

export const dynamic = 'force-dynamic'

type PinRow = Tables<'jimscanner_trends_pins'>

async function fetchData() {
  const sb = createAdminClient()

  // 기존 jimscanner_trends_pins (Phase A 부터 존재) 사용 — 향후 v4 product 단위 핀 테이블 추가 가능.
  const { data: pins } = await sb
    .from('jimscanner_trends_pins')
    .select('keyword, source, notes, pinned_at')
    .order('pinned_at', { ascending: false })

  // 페르소나 배지용 — 키워드별 1줄 요약 ("30대 여성·모바일 47%")
  const { data: demoCells } = await (sb as unknown as {
    from: (t: string) => {
      select: (cols: string) => Promise<{ data: Array<DemographicCell & { collected_at: string }> | null }>
    }
  })
    .from('jimscanner_trends_demographics')
    .select('keyword, age, gender, device, ratio_normalized, collected_at')
  const latestByKw = new Map<string, string>()
  for (const r of demoCells ?? []) {
    const prev = latestByKw.get(r.keyword)
    if (!prev || r.collected_at > prev) latestByKw.set(r.keyword, r.collected_at)
  }
  const cellsByKw = new Map<string, DemographicCell[]>()
  for (const r of demoCells ?? []) {
    if (latestByKw.get(r.keyword) !== r.collected_at) continue
    const arr = cellsByKw.get(r.keyword) ?? []
    arr.push({ keyword: r.keyword, age: r.age, gender: r.gender, device: r.device, ratio_normalized: r.ratio_normalized })
    cellsByKw.set(r.keyword, arr)
  }
  const personaByKw = new Map<string, { label: string; channel: string }>()
  for (const [kw, cells] of cellsByKw) {
    const s = summarizePersona(cells)
    if (s) personaByKw.set(kw, { label: s.primaryLabel, channel: s.adChannel })
  }

  return { pins: (pins ?? []) as PinRow[], personaByKw }
}

export default async function PinsPage() {
  const { pins, personaByKw } = await fetchData()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">핀한 상품 후보</h1>
          <p className="text-sm text-gray-500 mt-1">
            위탁 검토 후보. 메모 + 검토 상태 토글은 다음 버전.
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
            const persona = personaByKw.get(p.keyword)
            return (
              <div key={`${p.source}::${p.keyword}`} className="px-4 py-3 grid grid-cols-12 items-center text-sm">
                <div className="col-span-6">
                  <div className="font-medium">{p.keyword}</div>
                  {persona && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                        {persona.label}
                      </span>
                      <span className="inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700">
                        광고: {persona.channel}
                      </span>
                    </div>
                  )}
                  {p.notes && <div className="text-xs text-gray-500 mt-1">{p.notes}</div>}
                </div>
                <div className="col-span-3 text-xs text-gray-500">{p.source}</div>
                <div className="col-span-3 text-right text-xs text-gray-400 font-mono">
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
