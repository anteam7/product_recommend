import { NextResponse, type NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { logAdminAction } from '@/lib/admin-log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const TABLE = 'jimscanner_wellroot_products'
const MIN_PRICE = 1_000
const MAX_PRICE = 3_000_000

async function requireAdmin() {
  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user || !isAdminEmail(user.email)) return null
  return user
}

interface Product {
  product_no: string
  title: string | null
  supply_price_krw: number | null
  msp_price_krw: number | null
  msp_source: string | null
  msp_detected_krw: number | null
  msp_detected_tiers: Record<string, number> | null
  msp_detected_source: string | null
}

/**
 * 웰루트 상품 MSP(최저판매가, 배송비 포함) 사람 확인·입력.
 * body: { product_no, action: 'set', msp: number, tiers?: { "2": number, ... }, note?: string, confirm?: boolean }
 *       { product_no, action: 'revert' }  → 사람 입력값 삭제, 수집기 탐지값으로 복귀
 * 저장 후 coupang_eligible(생성 컬럼)이 자동 재계산된다.
 */
export async function POST(request: NextRequest) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: '권한 없음' }, { status: 401 })

  let body: { product_no?: string; action?: string; msp?: unknown; tiers?: unknown; note?: unknown; confirm?: boolean }
  try { body = await request.json() } catch { return NextResponse.json({ error: '잘못된 요청' }, { status: 400 }) }
  const productNo = String(body.product_no ?? '').trim()
  if (!/^\d+$/.test(productNo) || (body.action !== 'set' && body.action !== 'revert')) {
    return NextResponse.json({ error: 'product_no/action 오류' }, { status: 400 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any
  const { data: row, error: e1 } = await admin
    .from(TABLE)
    .select('product_no, title, supply_price_krw, msp_price_krw, msp_source, msp_detected_krw, msp_detected_tiers, msp_detected_source')
    .eq('product_no', productNo)
    .single()
  if (e1 || !row) return NextResponse.json({ error: '상품을 찾을 수 없음' }, { status: 404 })
  const product = row as Product
  const now = new Date().toISOString()

  if (body.action === 'revert') {
    const { data: upd, error } = await admin.from(TABLE).update({
      msp_price_krw: product.msp_detected_krw,
      tiered_msp: product.msp_detected_tiers,
      msp_source: product.msp_detected_source ?? 'none',
      msp_manual_note: null,
      msp_verified_by: null,
      msp_verified_at: null,
      msp_review_needed: false,
      updated_at: now,
    }).eq('product_no', productNo).select('coupang_eligible').single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    await logAdminAction({
      actor: user.email,
      action: 'wellroot_msp_revert',
      target_type: 'wellroot_product',
      target_id: productNo,
      summary: `MSP 사람입력 해제 ${product.msp_price_krw ?? '-'} → 탐지값 ${product.msp_detected_krw ?? '없음'} (${product.title?.slice(0, 30) ?? ''})`,
      metadata: { before: product.msp_price_krw, after: product.msp_detected_krw },
    })
    revalidatePath('/admin/wellroot-msp')
    return NextResponse.json({ ok: true, coupang_eligible: upd?.coupang_eligible ?? false })
  }

  // ─── set ───
  const msp = Math.round(Number(body.msp))
  if (!Number.isFinite(msp) || msp < MIN_PRICE || msp > MAX_PRICE) {
    return NextResponse.json({ error: `1개 MSP는 ${MIN_PRICE.toLocaleString()}~${MAX_PRICE.toLocaleString()}원` }, { status: 400 })
  }
  const tiered: Record<string, number> = { '1': msp }
  const tiersIn = body.tiers && typeof body.tiers === 'object' ? (body.tiers as Record<string, unknown>) : {}
  for (const [k, v] of Object.entries(tiersIn)) {
    if (v === '' || v == null) continue
    const qty = Number(k)
    const price = Math.round(Number(v))
    if (!Number.isInteger(qty) || qty < 2 || qty > 20) return NextResponse.json({ error: `수량 ${k} 오류` }, { status: 400 })
    if (!Number.isFinite(price) || price < MIN_PRICE || price > MAX_PRICE) return NextResponse.json({ error: `${qty}개 MSP 값 오류` }, { status: 400 })
    tiered[String(qty)] = price
  }
  const qtys = Object.keys(tiered).map(Number).sort((a, b) => a - b)
  for (let i = 1; i < qtys.length; i++) {
    if (tiered[String(qtys[i])] <= tiered[String(qtys[i - 1])]) {
      return NextResponse.json({ error: `${qtys[i]}개 MSP는 ${qtys[i - 1]}개 MSP보다 커야 합니다` }, { status: 400 })
    }
  }
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : ''

  // 오타 방어: 의심 신호가 있으면 사용자 재확인
  const warns: string[] = []
  if (product.supply_price_krw && msp <= product.supply_price_krw) warns.push(`1개 MSP ${msp.toLocaleString()}원이 공급가 ${product.supply_price_krw.toLocaleString()}원 이하입니다.`)
  for (const q of qtys) if (q > 1 && tiered[String(q)] > msp * q * 1.05) warns.push(`${q}개 MSP가 1개 MSP×${q}보다 큽니다.`)
  if (product.msp_detected_krw && product.msp_detected_krw !== msp) warns.push(`상세페이지 탐지값 ${product.msp_detected_krw.toLocaleString()}원과 다릅니다.`)
  if (warns.length && !body.confirm) return NextResponse.json({ error: warns.join('\n'), needConfirm: true }, { status: 409 })

  const { data: upd, error } = await admin.from(TABLE).update({
    msp_price_krw: msp,
    tiered_msp: qtys.length > 1 ? tiered : null,
    msp_source: 'manual',
    msp_manual_note: note || null,
    msp_verified_by: user.email,
    msp_verified_at: now,
    msp_review_needed: false,
    updated_at: now,
  }).eq('product_no', productNo).select('coupang_eligible').single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await logAdminAction({
    actor: user.email,
    action: 'wellroot_msp_set',
    target_type: 'wellroot_product',
    target_id: productNo,
    summary: `MSP 입력 ${product.msp_price_krw ?? '없음'} → ${msp}${qtys.length > 1 ? ` (수량별 ${qtys.length}구간)` : ''} (${product.title?.slice(0, 30) ?? ''})`,
    metadata: { before: product.msp_price_krw, beforeSource: product.msp_source, after: tiered, note: note || null },
  })
  revalidatePath('/admin/wellroot-msp')
  return NextResponse.json({ ok: true, coupang_eligible: upd?.coupang_eligible ?? false })
}
