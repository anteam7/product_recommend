import { NextResponse, type NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { requireAdminAndForwarder } from '@/lib/content-api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params
  const auth = await requireAdminAndForwarder(slug)
  if ('response' in auth) return auth.response

  const body = await request.json()
  const admin = createAdminClient()

  const { data, error } = await admin
    .from('jimscanner_forwarder_content')
    .upsert(
      {
        forwarder_id: auth.ctx.forwarderId,
        status: 'draft',
        overview: body.overview ?? null,
        strengths: body.strengths ?? [],
        weaknesses: body.weaknesses ?? [],
        service_features: body.service_features ?? [],
        pricing_notes: body.pricing_notes ?? null,
        recommended_for: body.recommended_for ?? null,
        usage_tips: body.usage_tips ?? [],
        faq: body.faq ?? [],
        source_urls: body.source_urls ?? [],
        created_by: auth.ctx.userEmail,
      },
      { onConflict: 'forwarder_id' },
    )
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, content: data })
}
