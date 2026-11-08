import { NextResponse } from 'next/server'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { loadOpenClaims } from '@/app/admin/(dashboard)/orders/data'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * 진행 중 쿠팡 반품·출고중지 접수 — 관리자 모든 화면 상단 알림(AdminShell 1분 폴링)·사이드바 배지용.
 * 수집: scripts/lib/coupang-orders-sync.mjs syncReturnRequests(매시 + [지금 수집]).
 */
export async function GET() {
  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user || !isAdminEmail(user.email)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const { stop, returning, items } = await loadOpenClaims(50)
    return NextResponse.json(
      { stop, returning, items: items.slice(0, 5).map((i) => ({ receiptId: i.receiptId, stop: i.stop, label: i.label, productName: i.productName, todo: i.todo })) },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
