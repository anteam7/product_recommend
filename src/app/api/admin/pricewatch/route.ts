import { NextResponse } from 'next/server'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function admin(): any { return createAdminClient() }

// 내 쿠팡 상품 아이템위너/시세 모니터 — 확장(collect_list)이 수집한 시세 vs 내 판매가 비교 결과.
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdminEmail(user.email)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const sb = admin()
  const { data, error } = await sb
    .from('jimscanner_coupang_pricewatch')
    .select('*')
    .order('gap', { ascending: false, nullsFirst: false })
    .limit(300)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const checkedAt = data?.[0]?.checked_at ?? null
  return NextResponse.json({ rows: data ?? [], checkedAt })
}
