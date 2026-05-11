import { NextResponse, type NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { logAdminAction } from '@/lib/admin-log'
import type { ReportStatus } from '@/lib/reports'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Action =
  | 'mark_in_review'
  | 'resolve'
  | 'reject'
  | 'mark_spam'
  | 'block_ip'
  | 'delete'

type Body = {
  action?: Action
  admin_action_label?: string
  diff_summary?: string
  admin_note?: string
}

async function requireAdmin() {
  const sb = await createClient()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user || !isAdminEmail(user.email)) return null
  return user
}

function revalidateTargets(targetType: string, targetSlug: string | null) {
  // 정정 배지가 보일 만한 공개 페이지 캐시 무효화
  switch (targetType) {
    case 'forwarder':
    case 'rate':
    case 'center':
    case 'service':
      if (targetSlug) revalidatePath(`/forwarders/${targetSlug}`, 'layout')
      break
    case 'blog_post':
      if (targetSlug) revalidatePath(`/blog/${targetSlug}`, 'layout')
      break
    case 'deal':
      revalidatePath('/deals', 'layout')
      break
    case 'exchange_rate':
      revalidatePath('/exchange-rates', 'layout')
      break
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const body = (await request.json().catch(() => ({}))) as Body
  const action = body.action

  if (!action) {
    return NextResponse.json({ error: 'action 필수' }, { status: 400 })
  }

  const admin = createAdminClient()
  const { data: existing } = await admin
    .from('jimscanner_reports')
    .select('id, status, target_type, target_slug, reporter_ip')
    .eq('id', id)
    .maybeSingle()

  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const now = new Date().toISOString()

  if (action === 'mark_in_review') {
    const { error } = await admin
      .from('jimscanner_reports')
      .update({ status: 'in_review' })
      .eq('id', id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  } else if (action === 'resolve') {
    const label = body.admin_action_label?.trim() || null
    const diff = body.diff_summary?.trim() || null
    const note = body.admin_note?.trim() || null
    const { error } = await admin
      .from('jimscanner_reports')
      .update({
        status: 'resolved',
        admin_action_label: label,
        diff_summary: diff,
        admin_note: note,
        resolved_at: now,
        resolved_by: user.email,
      })
      .eq('id', id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    revalidateTargets(existing.target_type, existing.target_slug)
  } else if (action === 'reject') {
    const note = body.admin_note?.trim() || null
    const { error } = await admin
      .from('jimscanner_reports')
      .update({
        status: 'rejected',
        admin_note: note,
        resolved_at: now,
        resolved_by: user.email,
      })
      .eq('id', id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  } else if (action === 'mark_spam') {
    const { error } = await admin
      .from('jimscanner_reports')
      .update({
        status: 'spam',
        resolved_at: now,
        resolved_by: user.email,
      })
      .eq('id', id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  } else if (action === 'block_ip') {
    const reason = body.admin_note?.trim() || null
    await admin
      .from('jimscanner_report_ip_blocklist')
      .upsert(
        { ip: existing.reporter_ip, reason, blocked_by: user.email },
        { onConflict: 'ip' },
      )
    // 기존 신고 상태 그대로 두되, 스팸으로 분류하는 게 일반적
    await admin
      .from('jimscanner_reports')
      .update({ status: 'spam', admin_note: reason, resolved_at: now, resolved_by: user.email })
      .eq('id', id)
  } else if (action === 'delete') {
    const { error } = await admin.from('jimscanner_reports').delete().eq('id', id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  } else {
    return NextResponse.json({ error: '알 수 없는 action' }, { status: 400 })
  }

  await logAdminAction({
    actor: user.email,
    action: `report_${action}`,
    target_type: 'report',
    target_id: id,
    summary: `${existing.target_type}${existing.target_slug ? `/${existing.target_slug}` : ''} · ${action}`,
    metadata: {
      from_status: existing.status as ReportStatus,
      admin_action_label: body.admin_action_label,
      diff_summary: body.diff_summary,
    },
  })

  return NextResponse.json({ ok: true })
}
