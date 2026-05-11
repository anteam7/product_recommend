import { NextResponse, type NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { requireAdminAndForwarder } from '@/lib/content-api'
import { logAdminAction } from '@/lib/admin-log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params
  const auth = await requireAdminAndForwarder(slug)
  if ('response' in auth) return auth.response

  const admin = createAdminClient()
  const { error } = await admin
    .from('jimscanner_forwarder_content')
    .update({ status: 'draft', published_at: null })
    .eq('forwarder_id', auth.ctx.forwarderId)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  await logAdminAction({
    actor: auth.ctx.userEmail,
    action: 'content_unpublish',
    target_type: 'forwarder_content',
    target_id: slug,
    summary: `배대지 콘텐츠 발행 취소: ${slug}`,
  })

  revalidatePath(`/forwarders/${slug}`)
  return NextResponse.json({ ok: true })
}
