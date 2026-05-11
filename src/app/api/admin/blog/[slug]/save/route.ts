import { NextResponse, type NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const EDITABLE = [
  'title',
  'description',
  'content',
  'cover_image_url',
  'category',
  'tags',
  'target_keywords',
  'faq',
  'seo_title',
  'seo_description',
  'og_image',
  'author',
  'home_featured',
  'home_order',
]

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
  const body = await request.json()

  const update: Record<string, unknown> = { created_by: user.email }
  for (const k of EDITABLE) {
    if (k in body) update[k] = body[k]
  }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('jimscanner_blog_posts')
    .update(update)
    .eq('slug', slug)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // 이미 게시된 글을 저장한 경우 프론트 캐시 즉시 무효화
  if (data?.status === 'published') {
    revalidatePath('/blog', 'layout')
    revalidatePath(`/blog/${slug}`, 'layout')
    revalidatePath('/', 'layout')
  }

  return NextResponse.json({ ok: true, post: data })
}
