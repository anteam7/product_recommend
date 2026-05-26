import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import type { Tables } from '@/lib/supabase'

export const dynamic = 'force-dynamic'

type PinRow = Tables<'jimscanner_trends_pins'>

// 6주 PB 점유율 1차미분 ≥ 5%p = '신규 PB 진입 감지' 알림.
const PB_GROWTH_ALERT_THRESHOLD = 0.05

interface PbGrowthRow {
  keyword: string
  platform: string
  share_now: number
  share_old: number | null
  share_growth: number | null
  captured_now: string
  captured_old: string | null
}

async function fetchData() {
  const sb = createAdminClient()

  const { data: pins } = await sb
    .from('jimscanner_trends_pins')
    .select('keyword, source, notes, pinned_at')
    .order('pinned_at', { ascending: false })

  // PB 진입 감지 (마이그레이션 적용 전엔 빈 배열).
  let pbAlerts: PbGrowthRow[] = []
  try {
    const { data } = await (sb as any)
      .from('jimscanner_pb_penetration_growth')
      .select('keyword, platform, share_now, share_old, share_growth, captured_now, captured_old')
      .gte('share_growth', PB_GROWTH_ALERT_THRESHOLD)
      .order('share_growth', { ascending: false })
      .limit(50)
    pbAlerts = (data ?? []) as PbGrowthRow[]
  } catch (e) {
    // 뷰 미적용 — 무시
  }

  return { pins: (pins ?? []) as PinRow[], pbAlerts }
}

export default async function PinsPage() {
  const { pins, pbAlerts } = await fetchData()

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

      {/* PB 진입 감지 알림 — 6주 1차미분 ≥ 5%p */}
      {pbAlerts.length > 0 && (
        <div className="rounded border border-amber-300 bg-amber-50 overflow-hidden">
          <div className="px-3 py-2 border-b border-amber-200 text-sm font-medium text-amber-900">
            ⚠ 신규 PB 진입 감지 — 6주 PB 점유율 +{PB_GROWTH_ALERT_THRESHOLD * 100}%p 이상
          </div>
          <table className="w-full text-sm">
            <thead className="text-xs text-amber-800 bg-amber-100/50">
              <tr>
                <th className="text-left px-3 py-2">키워드</th>
                <th className="text-left px-3 py-2">플랫폼</th>
                <th className="text-right px-3 py-2">현재 PB %</th>
                <th className="text-right px-3 py-2">6주 전</th>
                <th className="text-right px-3 py-2">증가폭</th>
                <th className="text-right px-3 py-2">측정일</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-amber-100">
              {pbAlerts.map((a) => (
                <tr key={`${a.platform}::${a.keyword}`}>
                  <td className="px-3 py-2 font-medium">{a.keyword}</td>
                  <td className="px-3 py-2 text-gray-600">{a.platform}</td>
                  <td className="px-3 py-2 text-right font-mono">{(a.share_now * 100).toFixed(0)}%</td>
                  <td className="px-3 py-2 text-right font-mono text-gray-500">
                    {a.share_old != null ? `${(a.share_old * 100).toFixed(0)}%` : '-'}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-red-600">
                    {a.share_growth != null ? `+${(a.share_growth * 100).toFixed(1)}%p` : '-'}
                  </td>
                  <td className="px-3 py-2 text-right text-xs text-gray-400 font-mono">
                    {a.captured_now?.slice(0, 10)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

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
          {pins.map((p) => (
            <div key={`${p.source}::${p.keyword}`} className="px-4 py-3 grid grid-cols-12 items-center text-sm">
              <div className="col-span-6">
                <div className="font-medium">{p.keyword}</div>
                {p.notes && <div className="text-xs text-gray-500 mt-1">{p.notes}</div>}
              </div>
              <div className="col-span-3 text-xs text-gray-500">{p.source}</div>
              <div className="col-span-3 text-right text-xs text-gray-400 font-mono">
                {p.pinned_at?.slice(0, 16)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
