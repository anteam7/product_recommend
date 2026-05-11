import { NextResponse } from 'next/server'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { DEFAULT_BLOG_GENERATION_PROMPT } from '@/lib/blog-prompts'
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
 * DB 가 비어 있을 때만 코드 default 를 v1 으로 시드 + active 전환.
 * 이미 한 행이라도 있으면 noop (안전).
 */
export async function POST() {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = createAdminClient()
  const { count } = await admin
    .from('jimscanner_blog_generation_prompts')
    .select('id', { count: 'exact', head: true })

  if ((count ?? 0) > 0) {
    return NextResponse.json({ ok: false, reason: 'already_seeded', count })
  }

  const { data, error } = await admin
    .from('jimscanner_blog_generation_prompts')
    .insert({
      version: 1,
      label: 'v1 — 코드 기본값',
      system_prompt: DEFAULT_BLOG_GENERATION_PROMPT,
      is_active: true,
      change_summary: '코드(lib/blog-prompts.ts) 기본값에서 시드',
      created_by: user.email,
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await logAdminAction({
    actor: user.email,
    action: 'blog_prompt_seed',
    target_type: 'blog_generation_prompt',
    target_id: data.id,
    summary: '프롬프트 v1 시드 (코드 default)',
  })

  return NextResponse.json({ ok: true, prompt: data })
}
