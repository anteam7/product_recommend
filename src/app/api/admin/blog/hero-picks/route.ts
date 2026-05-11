import { NextResponse, type NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type PickInput = {
  position: number
  blog_slug: string | null
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
    .from('jimscanner_home_hero_blog_picks')
    .select('*')
    .order('position', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ picks: data ?? [] })
}

export async function PUT(request: NextRequest) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = (await request.json()) as { picks?: PickInput[] }
  const picks = body.picks
  if (!Array.isArray(picks)) {
    return NextResponse.json({ error: 'picks array required' }, { status: 400 })
  }
  for (const p of picks) {
    if (![1, 2, 3].includes(p.position)) {
      return NextResponse.json({ error: `invalid position: ${p.position}` }, { status: 400 })
    }
  }

  const admin = createAdminClient()
  const rows = picks.map((p) => ({
    position: p.position,
    blog_slug: p.blog_slug && p.blog_slug.trim() !== '' ? p.blog_slug : null,
    updated_at: new Date().toISOString(),
  }))

  const { error } = await admin
    .from('jimscanner_home_hero_blog_picks')
    .upsert(rows, { onConflict: 'position' })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  revalidatePath('/', 'layout')
  return NextResponse.json({ ok: true })
}
