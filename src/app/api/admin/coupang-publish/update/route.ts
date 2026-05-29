import { NextResponse, type NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { logAdminAction } from '@/lib/admin-log'
import { changeProductPrice, computeMargin, SHIP } from '@/lib/coupang/price'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function requireAdmin() {
  const sb = await createClient()
  const { data: { user } } = await sb.auth.getUser()
  if (!user || !isAdminEmail(user.email)) return null
  return user
}

interface Listing {
  id: string
  seller_product_id: number | null
  registered_title: string | null
  dome_price_krw: number | null
  msp_price_krw: number | null
  list_price_krw: number | null
}

/**
 * 등록 상품 매입가/판매가 수정.
 * body: { id: string, field: 'dome' | 'list', value: number }
 *   - dome: 매입가 수정 → DB만 (마진 재계산)
 *   - list: 판매가 수정 → 쿠팡 라이브 반영 + DB (MSP 미만 거부)
 */
export async function POST(request: NextRequest) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: '권한 없음' }, { status: 401 })

  let body: { id?: string; field?: string; value?: unknown; confirm?: boolean }
  try { body = await request.json() } catch { return NextResponse.json({ error: '잘못된 요청' }, { status: 400 }) }
  const { id, field } = body
  const num = Number(body.value)
  const MAX_PRICE = 100_000_000
  if (!id || (field !== 'dome' && field !== 'list')) return NextResponse.json({ error: 'id/field 오류' }, { status: 400 })
  if (!Number.isFinite(num) || num < 0) return NextResponse.json({ error: '값이 올바르지 않음' }, { status: 400 })
  if (num > MAX_PRICE) return NextResponse.json({ error: `상한(${MAX_PRICE.toLocaleString()}원) 초과 — 오타 확인` }, { status: 400 })
  const value = Math.round(num)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any
  const { data: row, error: e1 } = await admin
    .from('jimscanner_coupang_listings')
    .select('id, seller_product_id, registered_title, dome_price_krw, msp_price_krw, list_price_krw')
    .eq('id', id)
    .single()
  if (e1 || !row) return NextResponse.json({ error: '상품을 찾을 수 없음' }, { status: 404 })
  const listing = row as Listing

  // ─── 매입가 수정: DB만, 마진 재계산 ───
  if (field === 'dome') {
    const newDome = value
    const list = listing.list_price_krw ?? 0
    // 판매가 미정(0/NULL)이면 마진은 '미정'(null)으로 둔다 — 0%로 오표기 방지
    const hasList = list > 0
    const m = computeMargin(list, newDome)
    const { error } = await admin.from('jimscanner_coupang_listings').update({
      dome_price_krw: newDome,
      source_shipping_fee_krw: 0,
      outbound_shipping_fee_krw: SHIP,
      estimated_fee_krw: hasList ? m.fee : null,
      estimated_margin_krw: hasList ? m.margin : null,
      estimated_margin_pct: hasList ? m.marginPct : null,
      last_synced_at: new Date().toISOString(),
    }).eq('id', id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const loss = hasList && m.margin < 0
    await logAdminAction({
      actor: user.email,
      action: 'coupang_dome_update',
      target_type: 'coupang_listing',
      target_id: id,
      summary: `매입가 ${listing.dome_price_krw ?? 0} → ${newDome}${loss ? ' ⚠손실' : ''} (${listing.registered_title?.slice(0, 30) ?? ''})`,
      metadata: { before: listing.dome_price_krw, after: newDome, marginPct: hasList ? m.marginPct : null, marginKrw: hasList ? m.margin : null, loss },
    })
    revalidatePath('/admin/coupang-publish')
    return NextResponse.json({
      ok: true, field, value: newDome,
      marginPct: hasList ? m.marginPct : null,
      marginKrw: hasList ? m.margin : null,
      warning: loss ? `손실 가격: 매입가+배송 ${m.realCost.toLocaleString()} > 판매가 ${list.toLocaleString()} (마진 ${m.marginPct}%)` : null,
    })
  }

  // ─── 판매가 수정: MSP 검증 → 쿠팡 반영 → DB ───
  const newPrice = value
  const msp = listing.msp_price_krw ?? 0
  if (msp > 0 && newPrice < msp) {
    return NextResponse.json({ error: `MSP(판매가격 절대준수) ${msp.toLocaleString()}원 미만으로는 변경할 수 없습니다.` }, { status: 400 })
  }
  // 자릿수 오타 방어: 현재가 대비 5배↑/5배↓ 급변동이면 confirm 필요
  const cur = listing.list_price_krw ?? 0
  if (cur > 0 && !body.confirm && (newPrice > cur * 5 || newPrice < cur / 5)) {
    return NextResponse.json({
      error: `현재가 ${cur.toLocaleString()}원 대비 급격한 변동입니다. 오타가 아니라면 다시 확인 후 진행하세요.`,
      needConfirm: true,
    }, { status: 409 })
  }

  let coupangResult: { ok: boolean; reason: string | null; results: Array<{ vendorItemId: number; ok: boolean; body: unknown }> } | null = null
  if (listing.seller_product_id) {
    coupangResult = await changeProductPrice(listing.seller_product_id, newPrice)
    if (!coupangResult.ok) {
      // 부분 성공 가능(멀티옵션) — 어떤 vendorItem이 바뀌었는지 반드시 기록
      const okItems = coupangResult.results.filter((r) => r.ok).map((r) => r.vendorItemId)
      await logAdminAction({
        actor: user.email,
        action: 'coupang_price_update_failed',
        target_type: 'coupang_listing',
        target_id: id,
        summary: `판매가 변경 실패 ${listing.list_price_krw ?? 0}→${newPrice} | 반영된 vendorItem ${okItems.length}/${coupangResult.results.length}건 (${listing.registered_title?.slice(0, 24) ?? ''})`,
        metadata: { before: listing.list_price_krw, attempted: newPrice, reason: coupangResult.reason, results: coupangResult.results, partiallyApplied: okItems },
      })
      return NextResponse.json({
        error: coupangResult.reason === 'no_vendor_item'
          ? '쿠팡 vendor-item을 찾을 수 없습니다(미승인 상품일 수 있음).'
          : okItems.length > 0
            ? `쿠팡 일부만 반영됨(${okItems.length}/${coupangResult.results.length}). DB는 갱신하지 않음 — 재시도하세요.`
            : '쿠팡 가격 반영 실패',
        coupang: coupangResult.results,
      }, { status: 502 })
    }
  }
  // seller_product_id 없으면 쿠팡 push 생략 (DB만 갱신)

  const m = computeMargin(newPrice, listing.dome_price_krw ?? 0)
  const { error } = await admin.from('jimscanner_coupang_listings').update({
    list_price_krw: newPrice,
    estimated_fee_krw: m.fee,
    estimated_margin_krw: m.margin,
    estimated_margin_pct: m.marginPct,
    last_synced_at: new Date().toISOString(),
  }).eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await logAdminAction({
    actor: user.email,
    action: 'coupang_price_update',
    target_type: 'coupang_listing',
    target_id: id,
    summary: `판매가 ${listing.list_price_krw ?? 0} → ${newPrice}${listing.seller_product_id ? ' (쿠팡 반영)' : ' (DB만)'} (${listing.registered_title?.slice(0, 30) ?? ''})`,
    metadata: { before: listing.list_price_krw, after: newPrice, pushedToCoupang: !!listing.seller_product_id, marginPct: m.marginPct },
  })
  revalidatePath('/admin/coupang-publish')
  return NextResponse.json({
    ok: true,
    field,
    value: newPrice,
    pushedToCoupang: !!listing.seller_product_id,
    marginPct: m.marginPct,
    marginKrw: m.margin,
  })
}
