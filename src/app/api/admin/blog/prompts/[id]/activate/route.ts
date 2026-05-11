import { NextResponse, type NextRequest } from 'next/server'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { logAdminAction } from '@/lib/admin-log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function requireAdmin() {
  const sb = await createClient()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user || !isAdminEmail(user.email)) return null
  return user
}

/**
 * 지정된 버전을 active 로 전환. 기존 active 는 자동 비활성.
 * partial unique index (idx_blog_prompt_active_singleton) 가 동시성 충돌을 잡아주므로
 * 두 update 를 순차로 실행해도 정합성은 보장됨.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params

  const admin = createAdminClient()
  const { data: target } = await admin
    .from('jimscanner_blog_generation_prompts')
    .select('id, version, label, is_active')
    .eq('id', id)
    .maybeSingle()
  if (!target) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (target.is_active) {
    return NextResponse.json({ ok: true, prompt: target, note: '이미 active' })
  }

  // 1) 모든 active 끄기
  const { error: offErr } = await admin
    .from('jimscanner_blog_generation_prompts')
    .update({ is_active: false })
    .eq('is_active', true)
  if (offErr) return NextResponse.json({ error: offErr.message }, { status: 500 })

  // 2) 대상 active 켜기
  const { data: updated, error: onErr } = await admin
    .from('jimscanner_blog_generation_prompts')
    .update({ is_active: true })
    .eq('id', id)
    .select()
    .single()
  if (onErr) return NextResponse.json({ error: onErr.message }, { status: 500 })

  await logAdminAction({
    actor: user.email,
    action: 'blog_prompt_activate',
    target_type: 'blog_generation_prompt',
    target_id: id,
    summary: `프롬프트 v${target.version} active 전환: ${target.label}`,
    metadata: { version: target.version },
  })

  return NextResponse.json({ ok: true, prompt: updated })
}
