import { NextResponse, type NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { BLOG_CATEGORIES } from '@/lib/blog'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED_LAYOUTS = ['hero4', 'row3'] as const
type Layout = (typeof ALLOWED_LAYOUTS)[number]

type SectionInput = {
  category: string
  active: boolean
  layout: Layout
  display_order: number
}

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
    .from('jimscanner_blog_home_sections')
    .select('*')
    .order('display_order', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ sections: data ?? [] })
}

export async function PUT(request: NextRequest) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = (await request.json()) as { sections?: SectionInput[] }
  const sections = body.sections
  if (!Array.isArray(sections)) {
    return NextResponse.json({ error: 'sections array required' }, { status: 400 })
  }

  for (const s of sections) {
    if (!BLOG_CATEGORIES.includes(s.category as (typeof BLOG_CATEGORIES)[number])) {
      return NextResponse.json({ error: `unknown category: ${s.category}` }, { status: 400 })
    }
    if (!ALLOWED_LAYOUTS.includes(s.layout)) {
      return NextResponse.json({ error: `invalid layout: ${s.layout}` }, { status: 400 })
    }
  }

  const admin = createAdminClient()
  const rows = sections.map((s) => ({
    category: s.category,
    active: !!s.active,
    layout: s.layout,
    display_order: Number(s.display_order) || 0,
    updated_at: new Date().toISOString(),
  }))

  const { error } = await admin
    .from('jimscanner_blog_home_sections')
    .upsert(rows, { onConflict: 'category' })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  revalidatePath('/', 'layout')
  return NextResponse.json({ ok: true })
}
