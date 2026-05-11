import { NextResponse, type NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
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

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { slug } = await params
  const admin = createAdminClient()
  const { error } = await admin
    .from('jimscanner_blog_posts')
    .update({ status: 'draft', published_at: null })
    .eq('slug', slug)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await logAdminAction({
    actor: user.email,
    action: 'blog_unpublish',
    target_type: 'blog_post',
    target_id: slug,
    summary: `블로그 발행 취소: ${slug}`,
  })

  revalidatePath('/blog', 'layout')
  revalidatePath(`/blog/${slug}`, 'layout')
  revalidatePath('/', 'layout')
  return NextResponse.json({ ok: true })
}
