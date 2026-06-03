import { NextResponse, type NextRequest } from 'next/server'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function requireAdmin() {
  const sb = await createClient()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user || !isAdminEmail(user.email)) return null
  return user
}

// 룰 목록 (+ 적중률) 은 페이지에서 server fetch 하므로 여기선 mutation 만.

/** 룰 생성 */
export async function POST(request: NextRequest) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => null)
  if (!body || typeof body.name !== 'string' || !body.condition) {
    return NextResponse.json({ error: 'name, condition 필수' }, { status: 400 })
  }

  let condition: unknown = body.condition
  if (typeof condition === 'string') {
    try {
      condition = JSON.parse(condition)
    } catch {
      return NextResponse.json({ error: 'condition JSON 파싱 실패' }, { status: 400 })
    }
  }

  const admin = createAdminClient()
  // 마이그레이션 후 테이블 — 타입 미생성이라 캐스팅
  const { data, error } = await (admin as any)
    .from('jimscanner_trends_alert_rules')
    .insert({
      name: body.name,
      description: body.description ?? null,
      condition,
      category_top: body.category_top || null,
      channel: body.channel === 'instant' ? 'instant' : 'digest',
      enabled: body.enabled !== false,
    })
    .select('id')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, id: data?.id })
}

/** 룰 수정 (enabled 토글 / 필드 patch) */
export async function PATCH(request: NextRequest) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => null)
  if (!body || typeof body.id !== 'string') {
    return NextResponse.json({ error: 'id 필수' }, { status: 400 })
  }

  const patch: Record<string, unknown> = {}
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
  if (typeof body.name === 'string') patch.name = body.name
  if (typeof body.description === 'string') patch.description = body.description
  if (body.channel === 'instant' || body.channel === 'digest') patch.channel = body.channel
  if (body.condition) {
    let condition: unknown = body.condition
    if (typeof condition === 'string') {
      try {
        condition = JSON.parse(condition)
      } catch {
        return NextResponse.json({ error: 'condition JSON 파싱 실패' }, { status: 400 })
      }
    }
    patch.condition = condition
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: '변경 없음' }, { status: 400 })
  }

  const admin = createAdminClient()
  const { error } = await (admin as any)
    .from('jimscanner_trends_alert_rules')
    .update(patch)
    .eq('id', body.id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

/** 룰 삭제 */
export async function DELETE(request: NextRequest) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(request.url)
  const id = searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id 필수' }, { status: 400 })

  const admin = createAdminClient()
  const { error } = await (admin as any)
    .from('jimscanner_trends_alert_rules')
    .delete()
    .eq('id', id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
