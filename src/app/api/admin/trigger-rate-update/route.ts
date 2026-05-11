import { NextResponse } from 'next/server'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { updateAllRates } from '@/lib/exchange-rates'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 관리자 페이지의 "지금 업데이트" 버튼이 호출하는 엔드포인트.
 * 세션 기반 인증 + ADMIN_EMAILS 화이트리스트 재검증.
 */
export async function POST() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user || !isAdminEmail(user.email)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const results = await updateAllRates(`manual:${user.email}`)
  const allOk = results.every((r) => r.status === 'success')

  return NextResponse.json(
    { ok: allOk, results },
    { status: allOk ? 200 : 500 },
  )
}
