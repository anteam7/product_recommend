import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import type { Tables } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

type PinRow = Tables<'jimscanner_trends_pins'>

interface IpRiskLite {
  keyword: string
  risk_grade: string
  risk_score: number
  top_mark_name: string | null
  top_mark_applicant: string | null
}

async function fetchData() {
  const sb = createAdminClient()

  // 기존 jimscanner_trends_pins (Phase A 부터 존재) 사용 — 향후 v4 product 단위 핀 테이블 추가 가능.
  const { data: pins } = await sb
    .from('jimscanner_trends_pins')
    .select('keyword, source, notes, pinned_at')
    .order('pinned_at', { ascending: false })

  const pinRows = (pins ?? []) as PinRow[]

  // KIPRIS IP 리스크 합치기 (신설 테이블 — generated 타입 미반영, as never)
  const keywords = Array.from(new Set(pinRows.map((p) => p.keyword).filter(Boolean)))
  let ipMap = new Map<string, IpRiskLite>()
  if (keywords.length > 0) {
    const { data: ipRows } = (await sb
      .from('jimscanner_ip_risk' as never)
      .select('keyword, risk_grade, risk_score, top_mark_name, top_mark_applicant')
      .in('keyword', keywords)
      .order('risk_score', { ascending: false })) as { data: IpRiskLite[] | null }
    for (const r of ipRows ?? []) {
      if (!ipMap.has(r.keyword)) ipMap.set(r.keyword, r)
    }
  }

  return { pins: pinRows, ipMap }
}

function ipBadge(grade: string | undefined) {
  if (grade === 'block') return { label: '🛑 IP block', cls: 'bg-red-100 text-red-800 border-red-200' }
  if (grade === 'caution') return { label: '⚠️ IP caution', cls: 'bg-amber-100 text-amber-800 border-amber-200' }
  if (grade === 'safe') return { label: '✓ IP safe', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' }
  return null
}

export default async function PinsPage() {
  const { pins, ipMap } = await fetchData()

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
            const ip = ipMap.get(p.keyword)
            const badge = ipBadge(ip?.risk_grade)
            return (
              <div key={`${p.source}::${p.keyword}`} className="px-4 py-3 grid grid-cols-12 items-center text-sm">
                <div className="col-span-6">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium">{p.keyword}</span>
                    {badge && (
                      <span
                        className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${badge.cls}`}
                        title={ip?.top_mark_name ? `${ip.top_mark_name}${ip.top_mark_applicant ? ` (${ip.top_mark_applicant})` : ''}` : ''}
                      >
                        {badge.label}
                      </span>
                    )}
                  </div>
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
