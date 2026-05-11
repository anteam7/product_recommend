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
  { params }: { params: Promise<{ slug: string; id: string }> },
) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { slug, id } = await params
  const admin = createAdminClient()

  const { data: review } = await admin
    .from('jimscanner_blog_post_reviews')
    .select('id, post_slug, title_before, description_before, content_before, applied, reverted_at')
    .eq('id', id)
    .eq('post_slug', slug)
    .maybeSingle()

  if (!review) return NextResponse.json({ error: 'Review not found' }, { status: 404 })
  if (!review.applied || review.reverted_at) {
    return NextResponse.json({ error: '이미 원복되었거나 반영되지 않은 검토입니다' }, { status: 400 })
  }

  const { data: post } = await admin
    .from('jimscanner_blog_posts')
    .select('status')
    .eq('slug', slug)
    .maybeSingle<{ status: string }>()

  const { error: upErr } = await admin
    .from('jimscanner_blog_posts')
    .update({
      title: review.title_before ?? undefined,
      description: review.description_before ?? undefined,
      content: review.content_before ?? undefined,
    })
    .eq('slug', slug)

  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 })

  const { error: revErr } = await admin
    .from('jimscanner_blog_post_reviews')
    .update({ reverted_at: new Date().toISOString() })
    .eq('id', id)

  if (revErr) return NextResponse.json({ error: revErr.message }, { status: 500 })

  await logAdminAction({
    actor: user.email,
    action: 'blog_review_revert',
    target_type: 'blog_post',
    target_id: slug,
    summary: `AI 검토 변경 원복 (review #${id.slice(0, 8)})`,
    metadata: { review_id: id },
  })

  if (post?.status === 'published') {
    revalidatePath('/blog', 'layout')
    revalidatePath(`/blog/${slug}`, 'layout')
  }

  return NextResponse.json({ ok: true })
}
