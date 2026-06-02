/**
 * 고유알파 분해 API — 카테고리 동조(베타)를 뺀 단독 상승(알파) 랭킹.
 *   GET /api/admin/trend-radar/alpha?days=7&cat=health
 *   응답: { days, rows: AlphaRow[], categories }
 * 어드민(service-role) 전용. RLS 우회 클라이언트이므로 인증 가드 필수.
 */
import { NextResponse } from 'next/server'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { computeAlphaRanking } from '@/lib/trend-radar/alpha'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const sb = await createClient()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user || !isAdminEmail(user.email)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const url = new URL(req.url)
  const days = Number(url.searchParams.get('days') ?? '7')
  const cat = url.searchParams.get('cat') ?? 'all'

  const admin = createAdminClient()
  const result = await computeAlphaRanking(admin, {
    days: Number.isFinite(days) ? days : 7,
    category: cat,
  })

  return NextResponse.json(result)
}
