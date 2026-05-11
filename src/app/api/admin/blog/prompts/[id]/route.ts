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

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('jimscanner_blog_generation_prompts')
    .select('*')
    .eq('id', id)
    .maybeSingle()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // parent 의 system_prompt 를 같이 내려서 클라가 diff 를 만들 수 있게 함
  let parent: { id: string; version: number; label: string; system_prompt: string } | null = null
  if (data.parent_version_id) {
    const { data: p } = await admin
      .from('jimscanner_blog_generation_prompts')
      .select('id, version, label, system_prompt')
      .eq('id', data.parent_version_id)
      .maybeSingle()
    parent = p ?? null
  }

  return NextResponse.json({ prompt: data, parent })
}

/**
 * 기존 버전의 label / system_prompt / change_summary 수정.
 * 가벼운 오타 수정 등에 사용. 큰 변경은 새 버전을 만드는 것을 권장 (UI 가이드).
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params

  const body = (await request.json().catch(() => ({}))) as {
    label?: unknown
    system_prompt?: unknown
    change_summary?: unknown
  }

  const update: Record<string, unknown> = {}
  if (typeof body.label === 'string') {
    const v = body.label.trim()
    if (!v) return NextResponse.json({ error: 'label 빈 값 불가' }, { status: 400 })
    if (v.length > 100) return NextResponse.json({ error: 'label 100자 이내' }, { status: 400 })
    update.label = v
  }
  if (typeof body.system_prompt === 'string') {
    if (body.system_prompt.length === 0) {
      return NextResponse.json({ error: 'system_prompt 빈 값 불가' }, { status: 400 })
    }
    update.system_prompt = body.system_prompt
  }
  if (typeof body.change_summary === 'string') {
    update.change_summary = body.change_summary.trim() || null
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: '변경할 필드가 없습니다' }, { status: 400 })
  }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('jimscanner_blog_generation_prompts')
    .update(update)
    .eq('id', id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await logAdminAction({
    actor: user.email,
    action: 'blog_prompt_update',
    target_type: 'blog_generation_prompt',
    target_id: id,
    summary: `프롬프트 v${data.version} 수정`,
    metadata: { fields: Object.keys(update), version: data.version },
  })

  return NextResponse.json({ prompt: data })
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { id } = await params

  const admin = createAdminClient()
  const { data: existing } = await admin
    .from('jimscanner_blog_generation_prompts')
    .select('id, version, label, is_active')
    .eq('id', id)
    .maybeSingle()
  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (existing.is_active) {
    return NextResponse.json(
      { error: 'active 버전은 삭제할 수 없습니다. 다른 버전을 active 로 전환 후 삭제하세요.' },
      { status: 400 },
    )
  }

  const { error } = await admin
    .from('jimscanner_blog_generation_prompts')
    .delete()
    .eq('id', id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await logAdminAction({
    actor: user.email,
    action: 'blog_prompt_delete',
    target_type: 'blog_generation_prompt',
    target_id: id,
    summary: `프롬프트 v${existing.version} 삭제: ${existing.label}`,
    metadata: { version: existing.version },
  })

  return NextResponse.json({ ok: true })
}
