import { NextResponse } from 'next/server'
import { revalidatePath } from 'next/cache'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { logAdminAction } from '@/lib/admin-log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST() {
  const sb = await createClient()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user || !isAdminEmail(user.email)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  revalidatePath('/deals', 'layout')
  revalidatePath('/', 'layout')

  await logAdminAction({
    actor: user.email,
    action: 'deals_revalidate',
    target_type: 'deals_page',
    target_id: '/deals',
    summary: '/deals · / 캐시 강제 재검증',
  })

  return NextResponse.json({ ok: true, revalidated: ['/deals', '/'] })
}
