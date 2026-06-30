import { NextResponse } from 'next/server'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function admin(): any { return createAdminClient() }

/**
 * '추가로 흑자 찾기' — 작업 지시 큐에 큰 런을 등록. 상시 work-agent 가 실행해 흑자 후보를 DB에 채운다.
 * (쿠팡 시세는 로컬 워밍업 크롬 필요하므로 로컬 에이전트 경유)
 */
export async function POST() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdminEmail(user.email)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const sb = admin()
  const { data: st } = await sb.from('jimscanner_domemedb_run_state').select('status').eq('id', 1).single()
  if (st?.status === 'running') return NextResponse.json({ error: '이미 흑자 후보를 찾는 중입니다' }, { status: 409 })

  const target = 30
  const instruction = [
    '도매매 신규·인기·기획전(itemNewDb/itemPopular/itemEvent)에서 시장가 대비 흑자 나는 후보를 추가로 찾아 DB에 채워줘.',
    `다음을 그대로 실행하면 된다: node --env-file=.env.local scripts/domemedb-coupang-margin.mjs --market=naver --page=all --target=${target} --save`,
    '네이버 쇼핑 시세 기준이라 차단 없이 빠르다(이미 검사한 건 건너뛰고 신규만 누적). 끝나면 흑자 몇 개 저장됐는지 한 줄로 보고.',
    '쿠팡 시세로 더 정확히 보려면 --market=coupang 으로(워밍업 크롬 9222 필요, 차단 위험).',
  ].join('\n')

  const { data, error } = await sb
    .from('jimscanner_work_instructions')
    .insert({ instruction, title: '도매매 흑자 후보 추가검색', priority: 6, created_by: user.email, status: 'queued' })
    .select('id')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  await sb.from('jimscanner_work_instruction_events').insert({ instruction_id: data.id, role: 'user', type: 'log', content: instruction })
  return NextResponse.json({ ok: true, id: data.id })
}
