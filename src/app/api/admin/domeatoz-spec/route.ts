import { NextResponse, type NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { logAdminAction } from '@/lib/admin-log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const TABLE = 'jimscanner_domeatoz_products'
const SKIP_PREFIX = '사람: 등록 안 함'

async function requireAdmin() {
  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user || !isAdminEmail(user.email)) return null
  return user
}

interface Row {
  idx: string
  name_clean: string | null
  register_excluded: boolean
  register_excluded_reason: string | null
  manual_spec: ManualSpec | null
}
interface ManualSpec {
  unit: 'g' | 'ml' | null
  per: number | null
  pieces: number | null
  attrs: Record<string, string>
  note: string | null
  prev_reason: string | null
}

/**
 * 도매아토즈 사람 입력 규격 — 쿠팡 구매옵션을 상품명·상세 이미지로 못 만든 상품(등록기가 '자동: 구매옵션 — …'으로 제외)에
 * 1개당 중량·용량, 총 개수, 필수 구매옵션 값(가공식품맛 등)을 사람이 넣는다. 저장하면 제외가 풀려 다음 드립 회차에 등록된다.
 * body: { idx, action: 'set', unit?: 'g'|'ml', per?: number, pieces?: number, attrs?: {이름: 값}, note? }
 *       { idx, action: 'clear' }   → 입력 삭제, 원래 제외 사유로 되돌림
 *       { idx, action: 'skip' }    → 등록 안 함(세트 등) · { idx, action: 'unskip' } → 되돌림
 */
export async function POST(request: NextRequest) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: '권한 없음' }, { status: 401 })

  let body: { idx?: unknown; action?: unknown; unit?: unknown; per?: unknown; pieces?: unknown; attrs?: unknown; note?: unknown }
  try { body = await request.json() } catch { return NextResponse.json({ error: '잘못된 요청' }, { status: 400 }) }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: '잘못된 요청' }, { status: 400 })
  const idx = String(body.idx ?? '').trim()
  const action = String(body.action ?? '')
  if (!/^\d{1,9}$/.test(idx) || !['set', 'clear', 'skip', 'unskip'].includes(action)) {
    return NextResponse.json({ error: 'idx/action 오류' }, { status: 400 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any
  const { data: found, error: e1 } = await admin
    .from(TABLE)
    .select('idx, name_clean, register_excluded, register_excluded_reason, manual_spec')
    .eq('idx', idx)
    .single()
  if (e1 || !found) return NextResponse.json({ error: '상품을 찾을 수 없음' }, { status: 404 })
  const row = found as Row
  const now = new Date().toISOString()
  const title = row.name_clean?.slice(0, 30) ?? ''
  const reason = row.register_excluded_reason ?? ''
  // 원래 자동 제외 사유(되돌릴 때 씀) — 이미 사람 입력/등록 안 함 상태면 거기 적어 둔 값을 유지
  const origReason = row.manual_spec?.prev_reason ?? (reason.startsWith(SKIP_PREFIX) ? reason.slice(SKIP_PREFIX.length).replace(/^ \| /, '') : reason) ?? null

  let update: Record<string, unknown>
  let summary: string
  if (action === 'skip') {
    update = { register_excluded: true, register_excluded_reason: `${SKIP_PREFIX} | ${origReason ?? ''}`.slice(0, 200), updated_at: now }
    summary = `도매아토즈 규격: 등록 안 함 (${title})`
  } else if (action === 'unskip') {
    if (!reason.startsWith(SKIP_PREFIX)) return NextResponse.json({ error: '등록 안 함 상태가 아님' }, { status: 400 })
    update = { register_excluded: true, register_excluded_reason: origReason || '자동: 구매옵션 — (사유 없음)', updated_at: now }
    summary = `도매아토즈 규격: 등록 안 함 해제 (${title})`
  } else if (action === 'clear') {
    if (!row.manual_spec) return NextResponse.json({ error: '입력값 없음' }, { status: 400 })
    update = { manual_spec: null, manual_spec_by: null, manual_spec_at: null, register_excluded: true, register_excluded_reason: origReason || '자동: 구매옵션 — (사람 입력 해제)', updated_at: now }
    summary = `도매아토즈 규격: 입력 해제 (${title})`
  } else {
    // ─── set ───
    if (reason.startsWith(SKIP_PREFIX)) return NextResponse.json({ error: '등록 안 함 상태입니다 — 먼저 [되돌리기]' }, { status: 409 })
    const isNumLike = (v: unknown) => v == null || v === '' || typeof v === 'number' || (typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v))
    if (!isNumLike(body.per) || !isNumLike(body.pieces)) return NextResponse.json({ error: '숫자만 넣으세요' }, { status: 400 })
    const unit = body.unit === 'g' || body.unit === 'ml' ? body.unit : null
    const perRaw = body.per === '' || body.per == null ? null : Number(body.per)
    const piecesRaw = body.pieces === '' || body.pieces == null ? null : Number(body.pieces)
    if (perRaw != null && (!Number.isFinite(perRaw) || perRaw <= 0 || perRaw > 100_000)) return NextResponse.json({ error: '1개당 중량·용량은 0보다 크고 100,000 이하' }, { status: 400 })
    if (perRaw != null && !unit) return NextResponse.json({ error: '1개당 값의 단위(g·ml)를 고르세요' }, { status: 400 })
    if (piecesRaw != null && (!Number.isInteger(piecesRaw) || piecesRaw < 1 || piecesRaw > 100_000)) return NextResponse.json({ error: '총 개수는 1~100,000 정수' }, { status: 400 })
    const attrs: Record<string, string> = {}
    if (body.attrs != null && (typeof body.attrs !== 'object' || Array.isArray(body.attrs))) return NextResponse.json({ error: 'attrs 형식 오류' }, { status: 400 })
    if (body.attrs) {
      for (const [k, v] of Object.entries(body.attrs as Record<string, unknown>)) {
        if (v != null && typeof v !== 'string' && typeof v !== 'number') return NextResponse.json({ error: `${k} 값 형식 오류` }, { status: 400 })
        const name = String(k).trim().slice(0, 40), val = String(v ?? '').trim()
        if (!name || !val) continue
        if (val.length > 40) return NextResponse.json({ error: `${name} 값은 40자 이하` }, { status: 400 })
        if (/상세\s*(설명|페이지)\s*참조/.test(val)) return NextResponse.json({ error: `${name}: '상세설명 참조'는 쿠팡이 거절합니다 — 실제 값을 넣으세요` }, { status: 400 })
        attrs[name] = val
      }
      if (Object.keys(attrs).length > 8) return NextResponse.json({ error: '구매옵션 값은 8개까지' }, { status: 400 })
    }
    if (perRaw == null && (piecesRaw == null || piecesRaw < 2) && !Object.keys(attrs).length) {
      return NextResponse.json({ error: '1개당 중량·용량, 총 개수(2개 이상), 구매옵션 값 중 하나는 넣어야 합니다' }, { status: 400 })
    }
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 300) || null : null
    const spec: ManualSpec = { unit: perRaw != null ? unit : null, per: perRaw, pieces: piecesRaw, attrs, note, prev_reason: origReason || null }
    update = { manual_spec: spec, manual_spec_by: user.email, manual_spec_at: now, register_excluded: false, register_excluded_reason: null, updated_at: now }
    const parts = [perRaw != null ? `1개 ${perRaw}${unit}` : null, piecesRaw != null ? `${piecesRaw}개` : null, ...Object.entries(attrs).map(([k, v]) => `${k}=${v}`)].filter(Boolean)
    summary = `도매아토즈 규격 입력: ${parts.join(' · ')} (${title})`
  }

  const { error } = await admin.from(TABLE).update(update).eq('idx', idx)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  await logAdminAction({
    actor: user.email,
    action: `domeatoz_spec_${action}`,
    target_type: 'domeatoz_product',
    target_id: idx,
    summary,
    metadata: { before: row.manual_spec, beforeReason: reason || null, after: update.manual_spec ?? null },
  })
  revalidatePath('/admin/domeatoz-spec')
  return NextResponse.json({ ok: true })
}
