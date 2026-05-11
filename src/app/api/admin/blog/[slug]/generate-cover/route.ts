import { NextResponse, type NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { generateAndStoreBlogCover } from '@/lib/blog-cover'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

async function requireAdmin() {
  const sb = await createClient()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user || !isAdminEmail(user.email)) return null
  return user
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { slug } = await params
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return NextResponse.json({ error: 'GEMINI_API_KEY 미설정' }, { status: 500 })

  const body = await request.json().catch(() => ({}))
  const customPrompt: string | null = body.prompt && String(body.prompt).trim().length > 0 ? String(body.prompt) : null

  const admin = createAdminClient()
  const { data: post } = await admin
    .from('jimscanner_blog_posts')
    .select('title, category, status')
    .eq('slug', slug)
    .maybeSingle<{ title: string; category: string; status: string }>()

  if (!post) return NextResponse.json({ error: 'Post not found' }, { status: 404 })

  try {
    const result = await generateAndStoreBlogCover({
      slug,
      title: post.title,
      category: post.category as never,
      customPrompt,
      geminiKey: apiKey,
    })

    await admin
      .from('jimscanner_blog_posts')
      .update({ cover_image_url: result.publicUrl, og_image: result.publicUrl })
      .eq('slug', slug)

    if (post.status === 'published') {
      revalidatePath('/blog', 'layout')
      revalidatePath(`/blog/${slug}`, 'layout')
    }

    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '이미지 생성 실패' },
      { status: 502 },
    )
  }
}
