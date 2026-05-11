import { NextResponse, type NextRequest } from 'next/server'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { applyRateCheckResult } from '@/lib/rate-check'
import { revalidatePath } from 'next/cache'
import { logAdminAction } from '@/lib/admin-log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user || !isAdminEmail(user.email)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => ({}))
  const resultId: string | undefined = body.result_id
  if (!resultId || typeof resultId !== 'string') {
    return NextResponse.json({ error: 'result_id 필요' }, { status: 400 })
  }

  try {
    const outcome = await applyRateCheckResult(resultId, `admin:${user.email}`)
    await logAdminAction({
      actor: user.email,
      action: 'rate_check_apply',
      target_type: 'rate_check_result',
      target_id: resultId,
      summary: `요금 체크 반영: ${
        (outcome as { forwarderSlug?: string }).forwarderSlug ?? resultId
      }`,
      metadata: outcome as Record<string, unknown>,
    })
    revalidatePath('/forwarders/[slug]', 'page')
    revalidatePath('/compare/[country]', 'page')
    revalidatePath('/forwarders', 'page')
    revalidatePath('/compare', 'page')
    return NextResponse.json({ ok: true, ...outcome })
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
