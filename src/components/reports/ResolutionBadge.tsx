import { createAdminClient } from '@/lib/auth/admin-supabase'
import type { ReportTargetType } from '@/lib/reports'
import { CheckCircle2 } from 'lucide-react'

type Props = {
  targetType: ReportTargetType
  targetSlug?: string
  targetId?: string
  /** 며칠 이내 정정만 노출. 기본 60일 */
  withinDays?: number
  className?: string
}

/**
 * 공개 페이지에 최근 정정된 이력을 배지로 노출.
 * Server Component: Supabase에서 resolved 상태 신고를 직접 조회.
 * target이 정정된 적 없으면 null 반환 (배지 미표시).
 */
export default async function ResolutionBadge({
  targetType,
  targetSlug,
  targetId,
  withinDays = 60,
  className,
}: Props) {
  const admin = createAdminClient()
  const sinceIso = new Date(Date.now() - withinDays * 24 * 60 * 60_000).toISOString()

  let q = admin
    .from('jimscanner_reports')
    .select('admin_action_label, diff_summary, resolved_at')
    .eq('status', 'resolved')
    .eq('target_type', targetType)
    .gte('resolved_at', sinceIso)
    .order('resolved_at', { ascending: false })
    .limit(1)

  if (targetSlug) q = q.eq('target_slug', targetSlug)
  if (targetId) q = q.eq('target_id', targetId)

  const { data } = await q
  const latest = data?.[0]
  if (!latest?.resolved_at) return null

  const daysAgo = Math.max(
    1,
    Math.floor((Date.now() - new Date(latest.resolved_at).getTime()) / (24 * 60 * 60_000)),
  )

  return (
    <div
      className={
        className ??
        'inline-flex items-start gap-1.5 text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-2 py-1'
      }
      title={latest.diff_summary ?? undefined}
    >
      <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" />
      <span>
        <span className="font-medium">{daysAgo}일 전 사용자 제보로 정정</span>
        {latest.admin_action_label && (
          <span className="ml-1 text-emerald-600">· {latest.admin_action_label}</span>
        )}
        {latest.diff_summary && (
          <span className="ml-1 text-emerald-600/80">— {latest.diff_summary}</span>
        )}
      </span>
    </div>
  )
}
