import { NextResponse } from 'next/server'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export type AuthedContext = {
  userEmail: string
  forwarderId: string
  forwarderName: string
  forwarderWebsite: string | null
}

/**
 * 관리자 세션 검증 + slug → forwarder 조회 묶음 헬퍼.
 * 인증/권한 실패 시 NextResponse 반환, 성공 시 컨텍스트.
 */
export async function requireAdminAndForwarder(
  slug: string,
): Promise<{ ctx: AuthedContext } | { response: NextResponse }> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user || !isAdminEmail(user.email)) {
    return { response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  const admin = createAdminClient()
  const { data: forwarder } = await admin
    .from('forwarders')
    .select('id, name, website')
    .eq('slug', slug)
    .maybeSingle<{ id: string; name: string; website: string | null }>()

  if (!forwarder) {
    return { response: NextResponse.json({ error: 'Forwarder not found' }, { status: 404 }) }
  }

  return {
    ctx: {
      userEmail: user.email!,
      forwarderId: forwarder.id,
      forwarderName: forwarder.name,
      forwarderWebsite: forwarder.website,
    },
  }
}
