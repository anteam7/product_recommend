/**
 * 쿠팡 주문 수집(ordersheets → jimscanner_coupang_orders upsert) 공용 모듈.
 * scripts/local-cron-orders-sync.mjs(매시간 크론)와 scripts/order-server.mjs(관리자 [지금 수집] 버튼 —
 * 로컬 직접 호출 / 원격 큐 잡 coupang_orders_sync 둘 다)가 공유. 로직을 바꿀 때는 두 호출부 모두 영향받는다.
 *
 * 주의: purchase_status / invoice_number / shipped_at / ggsan_(...) / coupang_invoice_(...) 컬럼은 절대 추가 금지 —
 * ggsan-sync 크론 소유(F-1). upsert row에 송장 미러 컬럼을 추가하면 ggsan-sync가 쓴 값을 매시간 덮어써 회귀한다.
 */
import crypto from 'node:crypto'

export function createCoupangOrdersSyncOps({ sb, env, log = () => {} }) {
  const VENDOR_ID = env.COUPANG_VENDOR_ID
  const ACCESS_KEY = env.COUPANG_ACCESS_KEY
  const SECRET_KEY = env.COUPANG_SECRET_KEY
  const HOST = env.COUPANG_API_HOST
  const envOk = () => !!(VENDOR_ID && ACCESS_KEY && SECRET_KEY && HOST)

  function sign(method, urlPath, query = '') {
    const dt = new Date().toISOString().substring(2, 19).replace(/[-:]/g, '') + 'Z'
    return { datetime: dt, signature: crypto.createHmac('sha256', SECRET_KEY).update(dt + method + urlPath + (query || '')).digest('hex') }
  }
  async function api(method, urlPath, query = '') {
    const { datetime, signature } = sign(method, urlPath, query)
    const res = await fetch(`${HOST}${urlPath}${query ? '?' + query : ''}`, {
      method,
      headers: { Authorization: `CEA algorithm=HmacSHA256, access-key=${ACCESS_KEY}, signed-date=${datetime}, signature=${signature}`, 'Content-Type': 'application/json;charset=UTF-8' },
    })
    const t = await res.text()
    try { return { status: res.status, body: JSON.parse(t) } } catch { return { status: res.status, body: t } }
  }
  function fmtKstYmd(d) {
    const kst = new Date(d.getTime() + 9 * 3600 * 1000)
    return kst.toISOString().slice(0, 10) // yyyy-MM-dd
  }

  /**
   * 최근 windowDays일 주문(ordersheets) 조회 → upsert.
   * windowDays 기본 31: 생성일 24h만 보면 오래된 주문의 배송지시→배송중→배송완료 전환을 못 잡아 상태가 멈춘다(2026-06-03 한계 수정).
   */
  async function syncRecentOrders({ windowDays = 31, triggeredBy = 'local-cron' } = {}) {
    if (!envOk()) {
      const msg = 'COUPANG_VENDOR_ID/COUPANG_ACCESS_KEY/COUPANG_SECRET_KEY/COUPANG_API_HOST 중 누락됨 — .env.local 확인'
      log(`[coupang-orders-sync/${triggeredBy}] ${msg}`)
      return { total: 0, inserted: 0, errors: 1, errorSamples: [msg], durationMs: 0 }
    }
    const t0 = Date.now()
    const now = new Date()
    const windowStart = new Date(now.getTime() - windowDays * 24 * 3600 * 1000)
    const created_at_from = fmtKstYmd(windowStart)
    const created_at_to = fmtKstYmd(now)

    let runId = null
    try {
      const { data: rr } = await sb.from('jimscanner_coupang_orders_sync_runs').insert({ status: 'running', triggered_by: triggeredBy }).select('id').single()
      runId = rr?.id
    } catch { /* 테이블 없으면 스킵 — 위젯 "마지막 실행 시각" 표시만 못 함, 동기화엔 영향 없음 */ }

    const path1 = `/v2/providers/openapi/apis/api/v4/vendors/${VENDOR_ID}/ordersheets`
    const statuses = ['ACCEPT', 'INSTRUCT', 'DEPARTURE', 'DELIVERING', 'FINAL_DELIVERY']
    const orderItemsAll = []
    const errorSamples = []
    for (const status of statuses) {
      let nextToken = ''
      do {
        const query = `createdAtFrom=${created_at_from}&createdAtTo=${created_at_to}&status=${status}&maxPerPage=50${nextToken ? `&nextToken=${encodeURIComponent(nextToken)}` : ''}`
        let r = await api('GET', path1, query)
        if (r.status === 429) { await new Promise((s) => setTimeout(s, 3000)); r = await api('GET', path1, query) }
        if (r.status !== 200) {
          errorSamples.push(`${status}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 100)}`)
          log(`  ${status}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 100)}`)
          break
        }
        orderItemsAll.push(...(r.body?.data ?? []))
        nextToken = r.body?.nextToken || ''
        await new Promise((s) => setTimeout(s, 200))
      } while (nextToken)
    }
    const total = orderItemsAll.length

    const sellerProductIds = [...new Set(orderItemsAll.flatMap((o) => (o.orderItems ?? []).map((it) => it.sellerProductId)))].filter(Boolean)
    let listings = []
    if (sellerProductIds.length > 0) {
      const { data } = await sb.from('jimscanner_coupang_listings').select('id, seller_product_id').in('seller_product_id', sellerProductIds)
      listings = data ?? []
    }
    const listingMap = new Map(listings.map((l) => [l.seller_product_id, l.id]))

    let inserted = 0
    let errors = errorSamples.length
    for (const order of orderItemsAll) {
      try {
        const items = order.orderItems ?? []
        for (const it of items) {
          // vendorItemPackageId는 비-패키지 상품에서 0(falsy)이라 ??로는 못 거름 → ||로 주문 단위 shipmentBoxId 사용
          const orderItemId = it.vendorItemPackageId || order.shipmentBoxId
          if (!orderItemId) continue
          const row = {
            order_id: order.orderId,
            order_item_id: orderItemId,
            vendor_id: VENDOR_ID,
            shipment_box_id: order.shipmentBoxId ?? null,
            listing_id: listingMap.get(it.sellerProductId) ?? null,
            seller_product_id: it.sellerProductId ?? null,
            vendor_item_id: it.vendorItemId ?? null,
            product_name: it.sellerProductName ?? it.vendorItemName ?? '(unknown)',
            option_name: it.vendorItemName ?? null,
            shipping_count: it.shippingCount ?? 1,
            sale_price: it.salesPrice ?? null,
            order_price: it.orderPrice ?? null,
            discount_amount: it.discountPrice ?? null,
            shipping_status: order.status ?? 'ACCEPT',
            receiver_name: order.receiver?.name ?? null,
            receiver_phone: order.receiver?.safeNumber ?? null,
            receiver_address: order.receiver?.addr1 ?? null,
            receiver_zip_code: order.receiver?.postCode ?? null,
            ordered_at: order.orderedAt,
            raw_payload: order,
            last_synced_at: new Date().toISOString(),
          }
          const { error } = await sb.from('jimscanner_coupang_orders').upsert(row, { onConflict: 'order_item_id' })
          if (error) {
            errors++
            if (errorSamples.length < 5) errorSamples.push(error.message)
            log(`  upsert error: ${error.message}`)
          } else inserted++
        }
      } catch (e) {
        errors++
        const m = e instanceof Error ? e.message : String(e)
        if (errorSamples.length < 5) errorSamples.push(m)
        log(`  order error: ${m}`)
      }
    }

    const durationMs = Date.now() - t0
    log(`[coupang-orders-sync/${triggeredBy}] total=${total} inserted=${inserted} errors=${errors} (${(durationMs / 1000).toFixed(1)}s)`)

    if (runId) {
      try {
        await sb.from('jimscanner_coupang_orders_sync_runs').update({
          finished_at: new Date().toISOString(),
          total_fetched: total,
          inserted_count: inserted,
          error_count: errors,
          duration_ms: durationMs,
          status: errors > 0 ? 'error' : 'success',
          error_message: errorSamples[0] ?? null,
        }).eq('id', runId)
      } catch { /* noop */ }
    }

    return { total, inserted, errors, errorSamples, durationMs }
  }

  return { syncRecentOrders }
}
