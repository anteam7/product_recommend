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

export async function GET() {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('jimscanner_blog_generation_prompts')
    .select('id, version, label, is_active, parent_version_id, change_summary, derived_from_review_ids, char_count, created_at, created_by')
    .order('version', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ prompts: data ?? [] })
}

/**
 * 새 버전 생성. 두 가지 모드:
 * - parent_id 지정: 그 버전의 system_prompt 를 베이스로 복제 (단, body.system_prompt 가 있으면 그걸 우선)
 * - parent_id 미지정: body.system_prompt 필수 (스크래치)
 *
 * 새로 만들어진 버전은 기본적으로 비활성. activate 는 별도 엔드포인트.
 */
export async function POST(request: NextRequest) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = (await request.json().catch(() => ({}))) as {
    label?: unknown
    system_prompt?: unknown
    parent_id?: unknown
    change_summary?: unknown
    derived_from_review_ids?: unknown
  }

  const label = typeof body.label === 'string' ? body.label.trim() : ''
  const parentId = typeof body.parent_id === 'string' ? body.parent_id : null
  const changeSummary =
    typeof body.change_summary === 'string' ? body.change_summary.trim() : null
  const derivedFromReviewIds = Array.isArray(body.derived_from_review_ids)
    ? (body.derived_from_review_ids as unknown[]).filter((x): x is string => typeof x === 'string')
    : []

  if (!label) return NextResponse.json({ error: 'label 필수' }, { status: 400 })
  if (label.length > 100) return NextResponse.json({ error: 'label 100자 이내' }, { status: 400 })

  const admin = createAdminClient()

  // 베이스 프롬프트 결정: body.system_prompt 우선 → parent 의 본문 → 에러
  let systemPrompt: string | null =
    typeof body.system_prompt === 'string' && body.system_prompt.length > 0
      ? body.system_prompt
      : null

  if (!systemPrompt && parentId) {
    const { data: parent } = await admin
      .from('jimscanner_blog_generation_prompts')
      .select('system_prompt')
      .eq('id', parentId)
      .maybeSingle()
    if (!parent) return NextResponse.json({ error: 'parent 버전을 찾을 수 없음' }, { status: 404 })
    systemPrompt = parent.system_prompt
  }

  if (!systemPrompt) {
    return NextResponse.json(
      { error: 'system_prompt 또는 parent_id 중 하나 필수' },
      { status: 400 },
    )
  }

  // 다음 버전 번호 = max(version) + 1
  const { data: latest } = await admin
    .from('jimscanner_blog_generation_prompts')
    .select('version')
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()
  const nextVersion = (latest?.version ?? 0) + 1

  const { data, error } = await admin
    .from('jimscanner_blog_generation_prompts')
    .insert({
      version: nextVersion,
      label,
      system_prompt: systemPrompt,
      is_active: false,
      parent_version_id: parentId,
      change_summary: changeSummary,
      derived_from_review_ids: derivedFromReviewIds,
      created_by: user.email,
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await logAdminAction({
    actor: user.email,
    action: 'blog_prompt_create',
    target_type: 'blog_generation_prompt',
    target_id: data.id,
    summary: `프롬프트 v${nextVersion} 생성: ${label}`,
    metadata: {
      version: nextVersion,
      parent_id: parentId,
      derived_from_review_ids: derivedFromReviewIds,
    },
  })

  return NextResponse.json({ prompt: data })
}
