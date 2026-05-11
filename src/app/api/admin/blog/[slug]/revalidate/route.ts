import { NextResponse, type NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { logAdminAction } from '@/lib/admin-log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 강제 재검증: Vercel Edge Cache 가 낡은 HTML 을 서빙할 때 수동으로 깨기 위한 엔드포인트.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const sb = await createClient()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user || !isAdminEmail(user.email)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { slug } = await params
  revalidatePath('/blog', 'layout')
  revalidatePath(`/blog/${slug}`, 'layout')

  await logAdminAction({
    actor: user.email,
    action: 'blog_revalidate',
    target_type: 'blog_post',
    target_id: slug,
    summary: `프론트 캐시 강제 재검증: ${slug}`,
  })

  return NextResponse.json({ ok: true, revalidated: [`/blog`, `/blog/${slug}`] })
}
