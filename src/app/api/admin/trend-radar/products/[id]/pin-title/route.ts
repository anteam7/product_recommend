/**
 * 리스팅 제목 옵티마이저 — 운영자가 선택한 후보를 jimscanner_listing_title_pinned 에 upsert.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params

  const sb = await createClient()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user || !isAdminEmail(user.email)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const body = (await request.json().catch(() => null)) as
    | { candidate_id?: string }
    | null
  if (!body?.candidate_id) {
    return NextResponse.json({ error: 'candidate_id 필요' }, { status: 400 })
  }

  const admin = createAdminClient()

  // 새 테이블 → as any 캐스팅
  const { data: cand, error: candErr } = await (admin as any)
    .from('jimscanner_listing_title_candidates')
    .select('id, product_id, title, char_len, covered_keywords')
    .eq('id', body.candidate_id)
    .single()
  if (candErr || !cand) {
    return NextResponse.json(
      { error: candErr?.message ?? 'candidate not found' },
      { status: 404 },
    )
  }
  if (cand.product_id !== id) {
    return NextResponse.json({ error: 'candidate mismatch' }, { status: 400 })
  }

  const { error: upErr } = await (admin as any)
    .from('jimscanner_listing_title_pinned')
    .upsert(
      {
        product_id: id,
        candidate_id: cand.id,
        title: cand.title,
        char_len: cand.char_len,
        covered_keywords: cand.covered_keywords ?? [],
        pinned_by: user.email ?? 'admin',
        pinned_at: new Date().toISOString(),
      },
      { onConflict: 'product_id' },
    )
  if (upErr) {
    return NextResponse.json({ error: upErr.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
