/**
 * 핀 부패 워치독 액션 API.
 * 액션: hold / refresh_listing / lookalike / terminate
 *  - hold: pinned=true 유지하되 notes 에 '[hold] ...' 추가
 *  - refresh_listing: notes 에 '[refresh] ...' 추가 (운영자가 외부 리스팅을 갱신했음을 기록)
 *  - lookalike: 대체핀 매칭 (#48 lookalike 재사용) — notes 에 마킹만 (lookalike RPC 는 별도)
 *  - terminate: pinned=false 로 핀 해제
 *
 * 모든 액션은 jimscanner_admin_actions 에 사유 로그 적재.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED = new Set(['hold', 'refresh_listing', 'lookalike', 'terminate'])

export async function POST(request: NextRequest) {
  const sb = await createClient()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user || !isAdminEmail(user.email)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  let body: { keyword?: string; source?: string; action?: string; reason?: string }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  const keyword = (body.keyword ?? '').trim()
  const source = (body.source ?? '').trim()
  const action = (body.action ?? '').trim()
  const reason = (body.reason ?? '').slice(0, 500)

  if (!keyword || !source || !ALLOWED.has(action)) {
    return NextResponse.json({ error: 'bad params' }, { status: 400 })
  }

  const admin = createAdminClient()

  // 가장 최근 pinned 행 찾기
  const { data: latest, error: latestErr } = await admin
    .from('jimscanner_trends_keywords')
    .select('id, notes, pinned, collected_at')
    .eq('keyword', keyword)
    .eq('source', source)
    .order('collected_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (latestErr) {
    return NextResponse.json({ error: latestErr.message }, { status: 500 })
  }
  if (!latest) {
    return NextResponse.json({ error: 'pin not found' }, { status: 404 })
  }

  const tag = `[${action}${reason ? `: ${reason}` : ''} @${new Date().toISOString().slice(0, 10)}]`
  const nextNotes = [latest.notes, tag].filter(Boolean).join(' ')
  const nextPinned = action === 'terminate' ? false : latest.pinned

  const { error: updErr } = await admin
    .from('jimscanner_trends_keywords')
    .update({ notes: nextNotes, pinned: nextPinned })
    .eq('id', latest.id)
  if (updErr) {
    return NextResponse.json({ error: updErr.message }, { status: 500 })
  }

  // admin_actions 로그
  const { error: logErr } = await admin
    .from('jimscanner_admin_actions')
    .insert({
      actor: user.email ?? 'admin',
      action: `pin_watchdog.${action}`,
      target_type: 'trend_pin',
      target_id: `${source}::${keyword}`,
      summary: `${action} — ${keyword} (${source})${reason ? ` :: ${reason}` : ''}`,
      metadata: { keyword, source, action, reason },
    })
  if (logErr) {
    // 로그 실패는 200 으로 통과 (행위 자체는 성공)
    return NextResponse.json({ ok: true, logged: false, warn: logErr.message })
  }

  return NextResponse.json({ ok: true, logged: true, pinned: nextPinned })
}
