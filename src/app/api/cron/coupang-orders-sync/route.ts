/**
 * 쿠팡 주문 수집 cron (시간당 1회)
 *
 * 흐름:
 *   1) GET 발주서(=주문) 목록: /v2/providers/openapi/apis/api/v4/vendors/{vendorId}/ordersheets
 *      - 최근 24시간 ACCEPT/INSTRUCT/DEPARTURE 상태 주문 가져옴
 *   2) 각 ordersheet 파싱 → orderId/orderItemId/상품/수량/금액/수령자
 *   3) jimscanner_coupang_orders 에 UPSERT (orderItemId 기준)
 *   4) 우리 listings (sellerProductId)와 매칭하여 listing_id 연결
 */
import { NextRequest, NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const HOST = 'https://api-gateway.coupang.com'

function signCoupang(method: string, urlPath: string, query = '') {
  const dt = new Date().toISOString().substring(2, 19).replace(/[-:]/g, '') + 'Z'
  const secret = process.env.COUPANG_SECRET_KEY!
  const signature = crypto.createHmac('sha256', secret).update(dt + method + urlPath + query).digest('hex')
  return { datetime: dt, signature }
}

async function coupangApi(method: string, urlPath: string, query = '') {
  const { datetime, signature } = signCoupang(method, urlPath, query)
  const access = process.env.COUPANG_ACCESS_KEY!
  const res = await fetch(`${HOST}${urlPath}${query ? '?' + query : ''}`, {
    method,
    headers: {
      Authorization: `CEA algorithm=HmacSHA256, access-key=${access}, signed-date=${datetime}, signature=${signature}`,
      'Content-Type': 'application/json;charset=UTF-8',
    },
  })
  const text = await res.text()
  try { return { status: res.status, body: JSON.parse(text) } } catch { return { status: res.status, body: text as unknown } }
}

function fmtKstYmd(d: Date) {
  const kst = new Date(d.getTime() + 9 * 3600 * 1000)
  return kst.toISOString().slice(0, 10) // yyyy-MM-dd (쿠팡 ordersheet API 필수 포맷)
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = createAdminClient() as any
  const vendorId = process.env.COUPANG_VENDOR_ID!
  const startedAt = Date.now()

  let total = 0, inserted = 0, updated = 0, errors = 0
  const errorSamples: string[] = []

  try {
    // 최근 7일 주문 (놓친 실행 대비 — upsert라 중복 무해). 쿠팡은 yyyy-MM-dd 포맷만 허용(14자리 보내면 HTTP 400).
    const now = new Date()
    const from = new Date(now.getTime() - 7 * 24 * 3600 * 1000)
    const created_at_from = fmtKstYmd(from)
    const created_at_to = fmtKstYmd(now)
    // 쿠팡 ordersheet API
    // path: /v2/providers/openapi/apis/api/v4/vendors/{vendorId}/ordersheets
    const path = `/v2/providers/openapi/apis/api/v4/vendors/${vendorId}/ordersheets`
    const statuses = ['ACCEPT', 'INSTRUCT', 'DEPARTURE', 'DELIVERING', 'FINAL_DELIVERY']
    const orderItemsAll: Array<Record<string, unknown>> = []

    for (const status of statuses) {
      const query = `createdAtFrom=${created_at_from}&createdAtTo=${created_at_to}&status=${status}&maxPerPage=50`
      const r = await coupangApi('GET', path, query)
      if (r.status !== 200) {
        errors++
        errorSamples.push(`${status}: HTTP ${r.status}`)
        continue
      }
      const data = (r.body as { data?: Array<Record<string, unknown>> })?.data ?? []
      orderItemsAll.push(...data)
    }
    total = orderItemsAll.length

    // 우리 listings 매핑 위해 sellerProductId → listing_id 맵
    const sellerProductIds = [...new Set(orderItemsAll.flatMap((o) =>
      ((o.orderItems as Array<Record<string, unknown>> | undefined) ?? []).map((it) => it.sellerProductId as number)
    ))].filter(Boolean)
    const { data: listings } = await sb
      .from('jimscanner_coupang_listings')
      .select('id, seller_product_id')
      .in('seller_product_id', sellerProductIds)
    const listingMap = new Map<number, string>(((listings ?? []) as Array<{ id: string; seller_product_id: number }>).map((l) => [l.seller_product_id, l.id]))

    // 주문별 UPSERT
    for (const order of orderItemsAll) {
      try {
        const items = (order.orderItems as Array<Record<string, unknown>>) ?? []
        for (const it of items) {
          // vendorItemPackageId는 비-패키지 상품에서 0(falsy)이라 ??로 못 거름 → ||로 주문 단위 shipmentBoxId 사용
          const orderItemId = (it.vendorItemPackageId as number) || (order.shipmentBoxId as number)
          if (!orderItemId) continue
          const row = {
            order_id: order.orderId as number,
            order_item_id: orderItemId as number,
            vendor_id: vendorId,
            shipment_box_id: order.shipmentBoxId as number | null,
            listing_id: listingMap.get(it.sellerProductId as number) ?? null,
            seller_product_id: it.sellerProductId as number | null,
            vendor_item_id: it.vendorItemId as number | null,
            product_name: it.sellerProductName as string ?? it.vendorItemName as string ?? '(unknown)',
            option_name: it.vendorItemName as string | null,
            shipping_count: (it.shippingCount as number) ?? 1,
            sale_price: it.salesPrice as number | null,
            order_price: it.orderPrice as number | null,
            discount_amount: it.discountPrice as number | null,
            shipping_status: order.status as string ?? 'ACCEPT',
            receiver_name: (order.receiver as Record<string, unknown> | undefined)?.name as string | null,
            receiver_phone: (order.receiver as Record<string, unknown> | undefined)?.safeNumber as string | null,
            receiver_address: (order.receiver as Record<string, unknown> | undefined)?.addr1 as string | null,
            receiver_zip_code: (order.receiver as Record<string, unknown> | undefined)?.postCode as string | null,
            ordered_at: order.orderedAt as string,
            raw_payload: order,
            last_synced_at: new Date().toISOString(),
          }
          // upsert (order_item_id unique)
          const { error } = await sb.from('jimscanner_coupang_orders').upsert(row, { onConflict: 'order_item_id' })
          if (error) {
            errors++
            if (errorSamples.length < 5) errorSamples.push(error.message)
          } else {
            inserted++
          }
        }
      } catch (e: unknown) {
        errors++
        if (errorSamples.length < 5) errorSamples.push(e instanceof Error ? e.message : String(e))
      }
    }

    return NextResponse.json({
      ok: true,
      total,
      inserted,
      updated,
      errors,
      duration_ms: Date.now() - startedAt,
      sampleErrors: errorSamples,
    })
  } catch (e: unknown) {
    return NextResponse.json({
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      total,
      duration_ms: Date.now() - startedAt,
    }, { status: 500 })
  }
}
