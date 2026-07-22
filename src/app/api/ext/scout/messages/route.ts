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
 * 사이드패널 3초 폴링 — 세션 메시지 + 활성 명령 진행 상태.
 * query: sessionId(필수), after?(ISO)
 * after 는 gte 조회(동일 타임스탬프 유실 방지) — 패널이 id 로 중복 제거한다.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorizedScout(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const sessionId = req.nextUrl.searchParams.get('sessionId')
    if (!isUuid(sessionId)) return NextResponse.json({ error: 'sessionId 형식 오류' }, { status: 400 })
    const afterRaw = req.nextUrl.searchParams.get('after')
    const afterMs = afterRaw ? Date.parse(afterRaw) : NaN
    const sb = admin()

    let q = sb.from('jimscanner_scout_messages')
      .select('id, role, type, content, created_at')
      .eq('session_id', sessionId).order('created_at', { ascending: true })
    q = Number.isNaN(afterMs) ? q.limit(100) : q.gte('created_at', new Date(afterMs).toISOString()).limit(200)
    const { data: messages, error } = await q
    if (error) throw error

    const { data: active, error: aErr } = await sb.from('jimscanner_scout_commands')
      .select('id, command_type, status, progress, created_at')
      .eq('session_id', sessionId).in('status', ['queued', 'sent', 'running', 'paused'])
      .order('created_at', { ascending: true }).limit(10)
    if (aErr) throw aErr

    return NextResponse.json({ messages: messages ?? [], activeCommands: active ?? [] })
  } catch (e) {
    console.error('[scout/messages]', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: '조회 실패' }, { status: 500 })
  }
}
