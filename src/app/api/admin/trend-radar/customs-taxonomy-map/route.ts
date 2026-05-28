/**
 * customs_hs_taxonomy_map CRUD (운영자 어드민 import-stats 페이지에서 사용).
 */
import { NextResponse, type NextRequest } from 'next/server'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'

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

export async function POST(request: NextRequest) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => ({})) as {
    taxonomy_category?: string
    hs_code_prefix?: string
    label?: string
    is_active?: boolean
  }
  const tax = body.taxonomy_category?.trim()
  const hs = body.hs_code_prefix?.trim().replace(/[^0-9]/g, '')
  if (!tax || !hs || hs.length < 2) {
    return NextResponse.json({ error: 'taxonomy_category & hs_code_prefix required' }, { status: 400 })
  }

  const admin = createAdminClient() as any
  const { data, error } = await admin
    .from('customs_hs_taxonomy_map')
    .upsert(
      {
        taxonomy_category: tax,
        hs_code_prefix: hs,
        label: body.label ?? null,
        is_active: body.is_active ?? true,
        created_by: user.email ?? 'admin',
      },
      { onConflict: 'taxonomy_category,hs_code_prefix' },
    )
    .select()
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, row: data })
}

export async function DELETE(request: NextRequest) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const id = new URL(request.url).searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const admin = createAdminClient() as any
  const { error } = await admin.from('customs_hs_taxonomy_map').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
