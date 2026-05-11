import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import {
  type Report,
  type ReportStatus,
  REPORT_STATUSES,
  statusLabel,
} from '@/lib/reports'
import ReportsClient from './ReportsClient'

export const dynamic = 'force-dynamic'

const TAB_ORDER: ReportStatus[] = [
  'pending',
  'in_review',
  'resolved',
  'duplicate',
  'rejected',
  'spam',
]

type Search = { status?: string; target_type?: string }

export default async function AdminReportsPage({
  searchParams,
}: {
  searchParams: Promise<Search>
}) {
  const sp = await searchParams
  const activeStatus: ReportStatus = REPORT_STATUSES.includes(sp.status as ReportStatus)
    ? (sp.status as ReportStatus)
    : 'pending'
  const targetTypeFilter = sp.target_type?.trim() || null

  const admin = createAdminClient()

  // 탭별 카운트
  const counts: Record<string, number> = {}
  await Promise.all(
    TAB_ORDER.map(async (s) => {
      const { count } = await admin
        .from('jimscanner_reports')
        .select('id', { count: 'exact', head: true })
        .eq('status', s)
      counts[s] = count ?? 0
    }),
  )

  // 현재 탭 리스트
  let q = admin
    .from('jimscanner_reports')
    .select('*')
    .eq('status', activeStatus)
    .order('created_at', { ascending: false })
    .limit(100)

  if (targetTypeFilter) q = q.eq('target_type', targetTypeFilter)

  const { data: reports } = await q

  // 같은 IP 반복 신고자 카운트(최근 7일) — 하이라이트용
  const ips = Array.from(
    new Set(
      (reports ?? [])
        .map((r) => (r as Report).reporter_ip)
        .filter((ip): ip is string => !!ip),
    ),
  )
  const ipRepeatCount: Record<string, number> = {}
  if (ips.length > 0) {
    const sinceIso = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString()
    await Promise.all(
      ips.map(async (ip) => {
        const { count } = await admin
          .from('jimscanner_reports')
          .select('id', { count: 'exact', head: true })
          .eq('reporter_ip', ip)
          .gte('created_at', sinceIso)
        ipRepeatCount[ip] = count ?? 0
      }),
    )
  }

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-bold text-gray-900">🚩 사용자 신고</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            잘못된 정보 제보를 관리합니다. "정정 완료"로 처리하면 공개 페이지에 정정 배지가 노출됩니다.
          </p>
        </div>
      </header>

      {/* 상태 탭 */}
      <div className="bg-white border rounded-lg p-1 flex gap-1 overflow-x-auto">
        {TAB_ORDER.map((s) => {
          const active = s === activeStatus
          return (
            <Link
              key={s}
              href={`/admin/reports?status=${s}${
                targetTypeFilter ? `&target_type=${targetTypeFilter}` : ''
              }`}
              className={`shrink-0 px-3 py-2 text-sm font-medium rounded transition-colors ${
                active ? 'bg-blue-600 text-white' : 'text-gray-700 hover:bg-gray-100'
              }`}
            >
              {statusLabel(s)}
              <span
                className={`ml-1.5 text-xs ${
                  active ? 'opacity-90' : 'text-gray-400'
                }`}
              >
                ({counts[s] ?? 0})
              </span>
            </Link>
          )
        })}
      </div>

      {/* 타입 필터 */}
      <div className="bg-white border rounded-lg p-3 flex items-center gap-2 flex-wrap text-xs">
        <span className="text-gray-600">타입:</span>
        <Link
          href={`/admin/reports?status=${activeStatus}`}
          className={`px-2 py-1 rounded ${
            !targetTypeFilter ? 'bg-gray-200 font-medium' : 'hover:bg-gray-100'
          }`}
        >
          전체
        </Link>
        {['forwarder', 'rate', 'blog_post', 'deal', 'exchange_rate', 'other'].map((t) => (
          <Link
            key={t}
            href={`/admin/reports?status=${activeStatus}&target_type=${t}`}
            className={`px-2 py-1 rounded ${
              targetTypeFilter === t ? 'bg-gray-200 font-medium' : 'hover:bg-gray-100'
            }`}
          >
            {t}
          </Link>
        ))}
      </div>

      <ReportsClient
        reports={(reports ?? []) as Report[]}
        ipRepeatCount={ipRepeatCount}
      />
    </div>
  )
}
