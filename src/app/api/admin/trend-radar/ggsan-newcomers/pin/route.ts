/**
 * 신규 입고 정찰병 카드에서 [📌 핀] 클릭 시.
 * jimscanner_trends_pins 에 source='ggsan_newcomer', keyword='ggsan:<goodsNo>' 으로 핀,
 * 동시에 newcomer_scores.pinned = true 로 표시.
 */
import { NextResponse } from 'next/server'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const sb = await createClient()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user || !isAdminEmail(user.email)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const body = (await req.json().catch(() => null)) as
    | { goodsNo?: string; title?: string; note?: string }
    | null
  const goodsNo = body?.goodsNo?.trim()
  const title = body?.title?.trim() ?? ''
  const note = body?.note?.trim() ?? ''
  if (!goodsNo) {
    return NextResponse.json({ error: 'goodsNo required' }, { status: 400 })
  }

  const admin = createAdminClient()
  const keyword = `ggsan:${goodsNo}`
  const composedNote = `${title}\n${note}`.trim()

  const { error: pinErr } = await admin
    .from('jimscanner_trends_pins')
    .upsert(
      {
        source: 'ggsan_newcomer',
        keyword,
        notes: composedNote,
      },
      { onConflict: 'keyword,source' },
    )
  if (pinErr) {
    return NextResponse.json({ error: pinErr.message }, { status: 500 })
  }

  // newcomer_scores 테이블이 마이그레이션 후 존재한다고 가정 (이 시점에 타입스크립트엔 없음)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (admin as any)
    .from('jimscanner_ggsan_newcomer_scores')
    .update({ pinned: true })
    .eq('goods_no', goodsNo)

  return NextResponse.json({ ok: true })
}
