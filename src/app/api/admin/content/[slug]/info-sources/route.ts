import { NextResponse, type NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { requireAdminAndForwarder } from '@/lib/content-api'
import { isInfoSourceType, type InfoSourceInput } from '@/lib/forwarder-info-sources'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params
  const auth = await requireAdminAndForwarder(slug)
  if ('response' in auth) return auth.response

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('jimscanner_forwarder_info_sources')
    .select('*')
    .eq('forwarder_id', auth.ctx.forwarderId)
    .order('source_type')
    .order('display_order')
    .order('created_at')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, sources: data ?? [] })
}

/**
 * Bulk replace: 클라이언트가 보낸 sources 배열로 forwarder 소스 전체를 교체.
 * - URL/타입 정규화 후 빈 행 무시
 * - 같은 (type, url) 중복 자동 dedupe (첫 항목 유지)
 * - 기존 행 중 보낸 목록에 없는 건 삭제, 있는 건 upsert
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params
  const auth = await requireAdminAndForwarder(slug)
  if ('response' in auth) return auth.response

  const body = (await request.json().catch(() => null)) as { sources?: unknown } | null
  if (!body || !Array.isArray(body.sources)) {
    return NextResponse.json({ error: 'sources 배열 필수' }, { status: 400 })
  }

  const seen = new Set<string>()
  const cleaned: InfoSourceInput[] = []
  for (const raw of body.sources) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    if (!isInfoSourceType(r.source_type)) continue
    const url = typeof r.url === 'string' ? r.url.trim() : ''
    if (!url) continue
    const key = `${r.source_type}::${url}`
    if (seen.has(key)) continue
    seen.add(key)
    cleaned.push({
      source_type: r.source_type,
      url,
      label: typeof r.label === 'string' && r.label.trim() ? r.label.trim() : null,
      notes: typeof r.notes === 'string' && r.notes.trim() ? r.notes.trim() : null,
      display_order: typeof r.display_order === 'number' && Number.isFinite(r.display_order)
        ? Math.trunc(r.display_order)
        : 0,
      is_active: r.is_active !== false,
    })
  }

  const admin = createAdminClient()

  // 기존 전부 삭제 후 일괄 insert (단순·원자성은 보장 안되지만 어드민 단일 사용자라 OK)
  const del = await admin
    .from('jimscanner_forwarder_info_sources')
    .delete()
    .eq('forwarder_id', auth.ctx.forwarderId)
  if (del.error) return NextResponse.json({ error: del.error.message }, { status: 500 })

  if (cleaned.length === 0) {
    return NextResponse.json({ ok: true, sources: [] })
  }

  const rows = cleaned.map((s) => ({
    forwarder_id: auth.ctx.forwarderId,
    source_type: s.source_type,
    url: s.url,
    label: s.label,
    notes: s.notes,
    display_order: s.display_order ?? 0,
    is_active: s.is_active ?? true,
    created_by: auth.ctx.userEmail,
  }))

  const ins = await admin
    .from('jimscanner_forwarder_info_sources')
    .insert(rows)
    .select()

  if (ins.error) return NextResponse.json({ error: ins.error.message }, { status: 500 })
  return NextResponse.json({ ok: true, sources: ins.data ?? [] })
}
