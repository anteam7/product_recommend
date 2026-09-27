/**
 * 쿠팡 주문 수집(ordersheets → jimscanner_coupang_orders upsert) 공용 모듈.
 * scripts/local-cron-orders-sync.mjs(매시간 크론)와 scripts/order-server.mjs(관리자 [지금 수집] 버튼 —
 * 로컬 직접 호출 / 원격 큐 잡 coupang_orders_sync 둘 다)가 공유. 로직을 바꿀 때는 두 호출부 모두 영향받는다.
 *
 * 주의: purchase_status / invoice_number / shipped_at / ggsan_(...) / coupang_invoice_(...) 컬럼은 절대 추가 금지 —
 * ggsan-sync 크론 소유(F-1). upsert row에 송장 미러 컬럼을 추가하면 ggsan-sync가 쓴 값을 매시간 덮어써 회귀한다.
 * (예외 1곳: reconcileUnseen 이 쿠팡 '취소/반품' 확인된 **미발주(PENDING)** 주문만 purchase_status=CANCELLED 로 바꾼다 —
 *  ggsan-sync 는 PENDING 행을 건드리지 않으므로 충돌 없음. 매입이 진행된 주문은 needs_attention 만 올린다.)
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
  const sleep = (ms) => new Promise((s) => setTimeout(s, ms))

  /**
   * 취소·반품 반영 + 창 밖 멈춘 주문 갱신 (2026-09-27).
   * 상태별 목록 조회(ACCEPT~FINAL_DELIVERY)에는 취소·반품된 주문이 안 나와 DB엔 마지막 상태가 영영 남았다
   * (실측: 쿠팡 취소 13건이 결제완료/상품준비중으로 고착, 사람이 매입상태만 수동 '취소'). 31일 창 밖 주문도 마찬가지.
   * → 이번 회차 목록에 없던 '진행 중' 주문만 박스 단건 조회(GET ordersheets/{shipmentBoxId}):
   *    200 = 실제 상태로 갱신 / 400 '취소 또는 반품' = CANCEL(발송 전) 또는 RETURNS(발송 후) 기록 +
   *    미발주면 매입상태도 취소, 매입이 진행됐으면 needs_attention(매입처 주문 취소·환불은 사람이 — 자동취소 금지).
   */
  async function reconcileUnseen(seenBoxIds, { maxBoxes = 60 } = {}) {
    const OPEN = ['ACCEPT', 'INSTRUCT', 'DEPARTURE', 'DELIVERING']
    const { data: open, error } = await sb.from('jimscanner_coupang_orders')
      .select('id, order_id, shipment_box_id, shipping_status, purchase_status, needs_attention, product_name')
      .in('shipping_status', OPEN).not('shipment_box_id', 'is', null).limit(500)
    if (error) throw new Error(`reconcile select: ${error.message}`)
    const byBox = new Map()
    for (const o of open ?? []) {
      const k = String(o.shipment_box_id)
      if (seenBoxIds.has(k)) continue
      if (!byBox.has(k)) byBox.set(k, [])
      byBox.get(k).push(o)
    }
    let cancelled = 0, refreshed = 0, checked = 0
    const now = new Date().toISOString()
    for (const [box, rows] of byBox) {
      if (checked >= maxBoxes) break
      checked++
      let r = await api('GET', `/v2/providers/openapi/apis/api/v4/vendors/${VENDOR_ID}/ordersheets/${box}`)
      if (r.status === 429) { await sleep(3000); r = await api('GET', `/v2/providers/openapi/apis/api/v4/vendors/${VENDOR_ID}/ordersheets/${box}`) }
      const msg = typeof r.body === 'object' ? String(r.body?.message ?? '') : String(r.body ?? '')
      if (r.status === 200) {
        const d = Array.isArray(r.body?.data) ? r.body.data[0] : r.body?.data
        const live = d?.status
        if (live && rows.some((x) => x.shipping_status !== live)) {
          await sb.from('jimscanner_coupang_orders').update({ shipping_status: live, last_synced_at: now }).eq('shipment_box_id', box)
          refreshed++
          log(`  [reconcile] box ${box} ${rows[0].shipping_status} → ${live}`)
        }
      } else if (r.status === 400 && /취소|반품/.test(msg)) {
        for (const o of rows) {
          const afterShip = ['DEPARTURE', 'DELIVERING', 'FINAL_DELIVERY'].includes(o.shipping_status) || o.purchase_status === 'RECEIVED'
          const kind = afterShip ? '반품' : '취소'
          const upd = { shipping_status: afterShip ? 'RETURNS' : 'CANCEL', last_synced_at: now }
          if (o.purchase_status === 'PENDING') {
            upd.purchase_status = 'CANCELLED'
          } else if (o.purchase_status !== 'CANCELLED') {
            upd.needs_attention = true
            upd.attention_reason = `쿠팡 주문 ${kind}됨 — 매입처 주문 ${afterShip ? '반품·환불' : '취소·환불'} 확인 필요`
          }
          await sb.from('jimscanner_coupang_orders').update(upd).eq('id', o.id)
          await sb.from('jimscanner_admin_actions').insert({
            actor: 'local', action: 'coupang_order_cancel_sync', target_type: 'coupang_order', target_id: o.id,
            summary: `주문#${o.order_id} 쿠팡 ${kind} 반영 — 매입상태 ${o.purchase_status}${upd.purchase_status ? '→CANCELLED' : upd.needs_attention ? ' (확인 필요)' : ''} (${(o.product_name ?? '').slice(0, 24)})`,
            metadata: upd,
          }).then(() => {}, () => {})
          cancelled++
          log(`  [reconcile] order#${o.order_id} 쿠팡 ${kind} → ${upd.shipping_status}${upd.purchase_status ? ' + 매입 취소' : upd.needs_attention ? ' + 확인 필요' : ''}`)
        }
      } else {
        log(`  [reconcile] box ${box}: HTTP ${r.status} ${msg.slice(0, 80)}`)
      }
      await sleep(150)
    }
    return { cancelled, refreshed, checked, pending: Math.max(0, byBox.size - checked) }
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
    // 상태별 목록 조회가 하나라도 실패하면 '목록에 없음'이 취소인지 조회 실패인지 구분 못 함 → 이 회차 reconcile 생략
    const listFailed = errorSamples.length > 0

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

    // 취소·반품 반영 + 창 밖 멈춘 주문 갱신 (목록 조회가 온전할 때만)
    let reconciled = { cancelled: 0, refreshed: 0, checked: 0, pending: 0 }
    if (!listFailed) {
      try {
        reconciled = await reconcileUnseen(new Set(orderItemsAll.map((o) => String(o.shipmentBoxId))))
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e)
        if (errorSamples.length < 5) errorSamples.push(m)
        log(`  reconcile error: ${m}`)
      }
    } else log('  목록 조회 일부 실패 — 취소·반품 반영(reconcile)은 이번 회차 생략')

    const durationMs = Date.now() - t0
    log(`[coupang-orders-sync/${triggeredBy}] total=${total} inserted=${inserted} errors=${errors} reconcile(checked=${reconciled.checked} cancelled=${reconciled.cancelled} refreshed=${reconciled.refreshed}${reconciled.pending ? ` pending=${reconciled.pending}` : ''}) (${(durationMs / 1000).toFixed(1)}s)`)

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

    return { total, inserted, errors, errorSamples, durationMs, cancelled: reconciled.cancelled, refreshed: reconciled.refreshed }
  }

  return { syncRecentOrders }
}
