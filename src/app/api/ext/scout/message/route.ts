import { NextResponse, type NextRequest } from 'next/server'
import { isAuthorizedScout } from '@/lib/scout-auth'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function admin(): any { return createAdminClient() }

const isUuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)

/**
 * 사이드패널 채팅 입력 — messages 에 role=user 적재. 세션 없으면 생성.
 * body: { sessionId?, content }  resp: { ok, sessionId, messageId }
 * 실제 응답은 로컬 scout-agent.mjs 가 폴링해 Claude 로 생성한다.
 */
export async function POST(req: NextRequest) {
  if (!isAuthorizedScout(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => ({}))
  const content = String(body?.content ?? '').trim().slice(0, 8000)
  if (!content) return NextResponse.json({ error: '내용이 비어 있습니다' }, { status: 400 })
  const sb = admin()

  let sessionId: string | null = isUuid(body?.sessionId) ? body.sessionId : null
  if (sessionId) {
    const { data } = await sb.from('jimscanner_scout_sessions').select('id, status').eq('id', sessionId).single()
    if (!data || data.status !== 'active') sessionId = null
  }
  if (!sessionId) {
    const { data, error } = await sb.from('jimscanner_scout_sessions')
      .insert({ title: content.split('\n')[0].slice(0, 80) }).select('id').single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    sessionId = data.id as string
  }

  const { data: msg, error } = await sb.from('jimscanner_scout_messages')
    .insert({ session_id: sessionId, role: 'user', type: 'chat', content }).select('id').single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  await sb.from('jimscanner_scout_sessions').update({ updated_at: new Date().toISOString() }).eq('id', sessionId)
  return NextResponse.json({ ok: true, sessionId, messageId: msg.id })
}
