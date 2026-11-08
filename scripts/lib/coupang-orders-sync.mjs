/**
 * 쿠팡 주문 수집(ordersheets → jimscanner_coupang_orders upsert) 공용 모듈.
 * scripts/local-cron-orders-sync.mjs(매시간 크론)와 scripts/order-server.mjs(관리자 [지금 수집] 버튼 —
 * 로컬 직접 호출 / 원격 큐 잡 coupang_orders_sync 둘 다)가 공유. 로직을 바꿀 때는 두 호출부 모두 영향받는다.
 *
 * 주의: purchase_status / invoice_number / shipped_at / ggsan_(...) / coupang_invoice_(...) 컬럼은 절대 추가 금지 —
 * ggsan-sync 크론 소유(F-1). upsert row에 송장 미러 컬럼을 추가하면 ggsan-sync가 쓴 값을 매시간 덮어써 회귀한다.
 * (예외 2곳: reconcileUnseen 과 syncReturnRequests(반품·취소 요청, 2026-11-08)가 쿠팡 취소·출고중지 완료가 확인된
 *  **미발주(PENDING)** 주문만 purchase_status=CANCELLED 로 바꾼다 — ggsan-sync 는 PENDING 행을 건드리지 않으므로 충돌 없음.
 *  매입이 진행된 주문은 needs_attention 만 올린다. shipping_status 는 반품 접수로 바꾸지 않는다 — 목록 upsert 가 매시 되돌려
 *  쓰기만 늘어나므로, 화면은 jimscanner_coupang_return_requests 를 order_id 로 붙여 배지·매출 제외를 정한다.)
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
  // jsonb 는 키 순서를 바꿔 저장하므로 키를 정렬해 비교한다
  const canon = (v) => Array.isArray(v) ? `[${v.map(canon).join(',')}]`
    : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`
    : JSON.stringify(v ?? null)
  // 바뀐 주문만 기록 — 매시 31일치 전 주문(raw_payload 포함)을 다시 쓰던 게 Disk IO 고갈의 한 원인(2026-11-05).
  // 쿠팡 응답(raw_payload)과 우리 컬럼(listing_id, 송장 등록 때 낙관 반영한 shipping_status 등)이 모두 같을 때만 건너뛴다.
  const ORDER_COLS = 'order_item_id, order_id, vendor_id, shipment_box_id, listing_id, seller_product_id, vendor_item_id, product_name, option_name, shipping_count, sale_price, order_price, discount_amount, shipping_status, receiver_name, receiver_phone, receiver_address, receiver_zip_code, raw_payload'
  const NOT_COMPARED = new Set(['order_item_id', 'raw_payload', 'ordered_at', 'last_synced_at']) // ordered_at 은 형식이 달라 raw_payload 로 대신 비교
  const sameAsStored = (prev, row, payloadKey) => !!prev && canon(prev.raw_payload) === payloadKey
    && Object.keys(row).every((k) => NOT_COMPARED.has(k) || String(prev[k] ?? '') === String(row[k] ?? ''))

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

  // ─── 반품·취소 요청(출고중지요청 포함) — 2026-11-08 ───
  // 주문 목록(ordersheets)만 읽어서는 진행 중인 반품접수·출고중지요청이 안 보였고, 반품 완료된 주문도 배송완료·매입완료로
  // 남아 매출에 잡혔다. returnRequests(v6)를 같은 회차에 읽어 jimscanner_coupang_return_requests 에 바뀐 것만 기록하고,
  // 새로 보이거나 상태가 바뀐 접수만 그 주문 행에 확인필요를 올린다(사람이 해제한 걸 매시 되살리지 않게).
  // 상태 없이 부르면 400 → 상태별로 따로 읽는다. 검색 기간 최대 31일.
  const RETURN_QUERIES = [
    ['출고중지요청', 'status=RU'], ['반품접수', 'status=UC'], ['쿠팡확인요청', 'status=PR'], ['반품완료', 'status=CC'], ['취소', 'cancelType=CANCEL'],
  ]
  const OPEN_RECEIPT = new Set(['RELEASE_STOP_UNCHECKED', 'RETURNS_UNCHECKED', 'VENDOR_WAREHOUSE_CONFIRM', 'REQUEST_COUPANG_CHECK'])
  const RECEIPT_LABEL = {
    RELEASE_STOP_UNCHECKED: '출고중지요청', RETURNS_UNCHECKED: '반품접수', VENDOR_WAREHOUSE_CONFIRM: '반품 입고완료',
    REQUEST_COUPANG_CHECK: '반품 쿠팡확인요청', RETURNS_COMPLETED: '완료',
  }
  // 고객 개인정보(requester* 이름·전화·주소)와 고객 첨부 사진은 저장하지 않는다
  const PII_KEY = /^requester|^reasonPhotoUrls$/
  const stripPii = (v) => Array.isArray(v) ? v.map(stripPii)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => !PII_KEY.test(k)).map(([k, x]) => [k, stripPii(x)]))
    : v
  const money = (m) => (m && typeof m === 'object' ? Number(m.units ?? 0) : Number(m ?? 0)) || 0
  const tsOrNull = (s) => (s ? String(s) : null)
  const isPreShip = (rc) => rc.receiptType === 'CANCEL' || (rc.returnItems ?? []).every((i) => ['S', 'N'].includes(String(i.releaseStatus ?? '')))

  function receiptRow(rc) {
    const raw = stripPii(rc)
    return {
      receipt_id: rc.receiptId,
      order_id: rc.orderId,
      receipt_type: rc.receiptType ?? null,
      receipt_status: rc.receiptStatus ?? null,
      release_stop_status: rc.releaseStopStatus ?? null,
      reason_category1: rc.cancelReasonCategory1 || null,
      reason_category2: rc.cancelReasonCategory2 || null,
      reason: rc.cancelReason || rc.reasonCodeText || null,
      cancel_count: rc.cancelCountSum ?? null,
      fault_by_type: rc.faultByType ?? null,
      return_shipping_charge: money(rc.returnShippingCharge),
      items: raw.returnItems ?? [],
      return_delivery: raw.returnDeliveryDtos ?? [],
      requested_at: tsOrNull(rc.createdAt),
      modified_at: tsOrNull(rc.modifiedAt),
      completed_at: tsOrNull(rc.completeConfirmDate),
      raw_payload: raw,
      last_synced_at: new Date().toISOString(),
    }
  }

  /** 접수 하나 → 해당 주문 행에 확인필요(·미발주면 매입 취소). 바뀐 행 수를 돌려준다. */
  async function applyReceiptToOrders(rc) {
    const { data: rows, error } = await sb.from('jimscanner_coupang_orders')
      .select('id, order_id, vendor_item_id, shipping_count, purchase_status, needs_attention, attention_reason, product_name')
      .eq('order_id', rc.orderId)
    if (error) throw new Error(`claim 주문 조회: ${error.message}`)
    if (!rows?.length) return { flagged: 0, cancelled: 0 } // 수집 전에 취소된 주문 — 행이 없음
    const items = rc.returnItems ?? []
    const itemOf = (row) => items.find((i) => String(i.vendorItemId) === String(row.vendor_item_id))
    // 품목이 안 맞으면 주문 행이 하나일 때만 그 행으로(같은 주문의 다른 상품에 잘못 붙이지 않게)
    const targets = rows.some(itemOf) ? rows.filter(itemOf) : rows.length === 1 ? rows : []
    if (!targets.length) log(`  [claim] order#${rc.orderId} 접수#${rc.receiptId}: 품목(${items.map((i) => i.vendorItemId).join(',')})이 주문 행과 안 맞아 건너뜀`)
    const why = [rc.cancelReasonCategory1, rc.cancelReasonCategory2].filter(Boolean).join('/') || rc.cancelReason || '사유 없음'
    const preShip = isPreShip(rc)
    let flagged = 0, cancelled = 0
    for (const row of targets) {
      const ps = row.purchase_status
      const it = itemOf(row)
      const fullLine = !it || Number(it.cancelCount ?? 0) >= Number(row.shipping_count ?? 1)
      let reason = null
      const upd = {}
      if (rc.receiptStatus === 'RELEASE_STOP_UNCHECKED') {
        const todo = ps === 'PENDING' ? '매입처에 발주하지 말고 Wing에서 출고중지 처리'
          : ['SHIPPED', 'RECEIVED'].includes(ps) ? '매입처가 이미 발송 — Wing에서 이미출고 처리(송장 입력)'
          : ps === 'CANCELLED' ? 'Wing에서 출고중지 처리'
          : '매입처 주문 취소 후 Wing에서 출고중지 처리'
        reason = `쿠팡 출고중지요청(${why}) — ${todo}`
      } else if (OPEN_RECEIPT.has(rc.receiptStatus)) {
        reason = `쿠팡 ${RECEIPT_LABEL[rc.receiptStatus]}(${why}) — 회수 확인 후 Wing에서 반품 승인, 매입처 반품·환불 확인`
      } else if (rc.receiptStatus === 'RETURNS_COMPLETED') {
        const kind = rc.receiptType === 'CANCEL' ? '취소' : preShip ? '출고중지' : '반품'
        if (ps === 'PENDING' && preShip && fullLine) {
          upd.purchase_status = 'CANCELLED' // reconcileUnseen 과 같은 규칙: 미발주 + 출고 전 전량 취소만 자동
        } else if (ps !== 'PENDING' && ps !== 'CANCELLED') {
          reason = `쿠팡 ${kind} 완료(${why}) — 매입처 ${preShip ? '주문 취소·환불' : '반품·환불'} 확인 필요`
        }
      }
      if (reason) {
        const prev = row.needs_attention ? (row.attention_reason ?? '') : ''
        if (!prev.includes(reason)) {
          // 같은 건의 이전 반품·취소 사유(접수→완료 등) 조각만 빼고, 다른 사유(송장 실패 등)는 뒤에 보존
          const sameEvent = /^쿠팡 (출고중지|반품|취소|주문 (취소|반품))/
          const others = prev.split(' | ').map((s) => s.trim()).filter((s) => s && !sameEvent.test(s))
          upd.needs_attention = true
          upd.attention_reason = [reason, ...others].join(' | ').slice(0, 500)
        }
      }
      if (!Object.keys(upd).length) continue
      const { error: ue } = await sb.from('jimscanner_coupang_orders').update(upd).eq('id', row.id)
      if (ue) throw new Error(`claim 주문 갱신: ${ue.message}`)
      if (upd.needs_attention) flagged++
      if (upd.purchase_status) cancelled++
      await sb.from('jimscanner_admin_actions').insert({
        actor: 'local', action: 'coupang_return_request_sync', target_type: 'coupang_order', target_id: row.id,
        summary: `주문#${row.order_id} 쿠팡 ${RECEIPT_LABEL[rc.receiptStatus] ?? rc.receiptStatus}(${rc.receiptType}) 접수#${rc.receiptId} — ${upd.purchase_status ? '매입 취소' : '확인 필요'} (${(row.product_name ?? '').slice(0, 24)})`,
        metadata: { receipt_id: rc.receiptId, receipt_status: rc.receiptStatus, release_stop_status: rc.releaseStopStatus, ...upd },
      }).then(() => {}, () => {})
      log(`  [claim] order#${row.order_id} ${RECEIPT_LABEL[rc.receiptStatus] ?? rc.receiptStatus}(${rc.receiptType}) → ${upd.purchase_status ? '매입 취소' : '확인 필요'}`)
    }
    return { flagged, cancelled }
  }

  /**
   * 반품·취소 요청 수집 → 접수 테이블(바뀐 것만) + 새/상태 바뀐 접수만 주문 행 반영.
   * 31일 창 밖으로 밀린 미처리 접수는 orderId + 접수일부터 30일 범위로 다시 읽는다(최대 maxStale건).
   */
  /** returnRequests 목록 한 종류를 끝까지(nextToken) 읽어 byId 에 모은다. 실패는 errors 에 넣고 false. */
  async function fetchReturnList(label, base, byId, errors) {
    const path = `/v2/providers/openapi/apis/api/v6/vendors/${VENDOR_ID}/returnRequests`
    let nextToken = ''
    do {
      const q = `${base}&maxPerPage=50${nextToken ? `&nextToken=${encodeURIComponent(nextToken)}` : ''}`
      let r = await api('GET', path, q)
      if (r.status === 429) { await sleep(3000); r = await api('GET', path, q) }
      if (r.status !== 200) { errors.push(`반품요청 ${label}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 100)}`); return false }
      for (const rc of r.body?.data ?? []) if (rc?.receiptId) byId.set(String(rc.receiptId), rc)
      nextToken = r.body?.nextToken || ''
      await sleep(200)
    } while (nextToken)
    return true
  }

  /**
   * 받은 접수 → 테이블(바뀐 것만) + 새/상태 바뀐 접수만 주문 행 반영.
   * 새 접수·상태 변경은 주문 행 반영이 성공한 뒤에만 기록 — 실패하면 다음 회차에 다시 '바뀐 접수'로 잡혀 재시도된다
   * (반영은 같은 사유가 이미 있으면 건너뛰므로 재시도해도 중복 표시 없음).
   * apply=false(과거분 백필 전용): 주문 행 반영 없이 기록만 — 기록된 상태로는 이후 반영이 다시 일어나지 않으므로
   * 이미 끝난 옛 접수를 건수 집계용으로 채울 때만 쓴다. 이후 상태가 바뀌면 그때는 정상 반영된다.
   */
  async function recordReceipts(receipts, errors, { apply = true } = {}) {
    const stored = new Map()
    const ids = receipts.map((rc) => rc.receiptId)
    for (let i = 0; i < ids.length; i += 200) {
      const { data, error } = await sb.from('jimscanner_coupang_return_requests').select('receipt_id, receipt_status, raw_payload').in('receipt_id', ids.slice(i, i + 200))
      if (error) throw new Error(`반품요청 저장분 조회: ${error.message}`) // 비교 못 하면 전부 '새 접수'로 오인 → 중단
      for (const s of data ?? []) stored.set(String(s.receipt_id), s)
    }
    let changed = 0, flagged = 0, cancelled = 0
    for (const rc of receipts) {
      const prev = stored.get(String(rc.receiptId))
      const row = receiptRow(rc)
      if (prev && canon(prev.raw_payload) === canon(row.raw_payload)) continue
      if (apply && (!prev || prev.receipt_status !== rc.receiptStatus)) {
        try {
          const a = await applyReceiptToOrders(rc)
          flagged += a.flagged; cancelled += a.cancelled
        } catch (e) { errors.push(e instanceof Error ? e.message : String(e)); continue }
      }
      const { error } = await sb.from('jimscanner_coupang_return_requests').upsert(row, { onConflict: 'receipt_id' })
      if (error) { errors.push(`반품요청 기록: ${error.message}`); continue }
      changed++
    }
    return { changed, flagged, cancelled }
  }

  /**
   * backfillDays > 30 이면 그 이전 기간도 30일 창으로 더 읽어 기록만 한다(기간 카드 반품·취소 건수용, 한 번만 돌리면 됨).
   * 백필분은 주문 행에 확인필요를 올리지 않는다 — 이미 처리된 옛 반품이 한꺼번에 뜨지 않게.
   */
  async function syncReturnRequests({ windowDays = 30, maxStale = 20, backfillDays = 0 } = {}) {
    const now = new Date()
    const from = fmtKstYmd(new Date(now.getTime() - windowDays * 86400000))
    const to = fmtKstYmd(now)
    const errors = []
    const byId = new Map()
    const fetchList = (label, base) => fetchReturnList(label, base, byId, errors)
    for (const [label, q] of RETURN_QUERIES) await fetchList(label, `createdAtFrom=${from}&createdAtTo=${to}&${q}`)
    if (backfillDays > windowDays) {
      const old = new Map()
      for (let off = windowDays + 1; off < backfillDays; off += 31) {
        const wTo = new Date(now.getTime() - off * 86400000)
        const wFrom = new Date(wTo.getTime() - 30 * 86400000)
        for (const [label, q] of RETURN_QUERIES) await fetchReturnList(`${label} 백필`, `createdAtFrom=${fmtKstYmd(wFrom)}&createdAtTo=${fmtKstYmd(wTo)}&${q}`, old, errors)
      }
      for (const k of byId.keys()) old.delete(k)
      const b = await recordReceipts([...old.values()], errors, { apply: false })
      log(`  반품·취소 요청 백필 ${old.size}건(기록 ${b.changed}, 확인필요 안 올림)`)
    }

    // 창 밖 미처리 접수 재조회
    const { data: staleOpen, error: staleErr } = await sb.from('jimscanner_coupang_return_requests')
      .select('receipt_id, order_id, requested_at').in('receipt_status', [...OPEN_RECEIPT]).limit(200)
    if (staleErr) errors.push(`반품요청 미처리분 조회: ${staleErr.message}`)
    const stale = (staleOpen ?? []).filter((s) => !byId.has(String(s.receipt_id))).slice(0, maxStale)
    for (const s of stale) {
      const d0 = s.requested_at ? new Date(s.requested_at) : new Date(now.getTime() - 60 * 86400000)
      await fetchList(`order#${s.order_id}`, `createdAtFrom=${fmtKstYmd(d0)}&createdAtTo=${fmtKstYmd(new Date(d0.getTime() + 30 * 86400000))}&orderId=${encodeURIComponent(String(s.order_id))}`)
    }

    const receipts = [...byId.values()]
    const { changed, flagged, cancelled } = await recordReceipts(receipts, errors)
    const open = receipts.filter((rc) => OPEN_RECEIPT.has(rc.receiptStatus))
    const stopReq = open.filter((rc) => rc.receiptStatus === 'RELEASE_STOP_UNCHECKED').length
    log(`  반품·취소 요청 ${receipts.length}건(출고중지요청 ${stopReq} · 반품 진행 ${open.length - stopReq}) · 기록 ${changed} · 확인필요 ${flagged} · 매입 취소 ${cancelled}${errors.length ? ` · 오류 ${errors.length}` : ''}`)
    return { fetched: receipts.length, open: open.length, stopRequests: stopReq, changed, flagged, cancelled, errors }
  }

  // ─── 고객문의(상품 문의·콜센터 이관 문의) — 2026-11-08 ───
  // 주문 화면 기간 카드 "문의 N(미답변 M)"용. 본문·구매자 정보(buyerEmail·buyerPhone)는 저장하지 않는다.
  // 검색 기간 최대 7일 → 7일 창으로 나눠 읽는다. 콜센터는 NONE(전체) + NO_ANSWER·TRANSFER(판매자 답변 필요) 조회로 미답변 판정.
  const INQ_TS = ['inquired_at', 'answered_at']
  const INQ_COLS = ['order_id', 'seller_product_id', 'vendor_item_id', 'item_name', 'status', 'needs_answer', ...INQ_TS]
  async function fetchInquiryPages(kind, query, errors) {
    const path = `/v2/providers/openapi/apis/api/v5/vendors/${VENDOR_ID}/${kind === 'online' ? 'onlineInquiries' : 'callCenterInquiries'}`
    const out = []
    const pageSize = kind === 'online' ? 50 : 30
    const MAX_PAGES = 20
    for (let page = 1; page <= MAX_PAGES; page++) {
      const q = `vendorId=${VENDOR_ID}&${query}&pageNum=${page}&pageSize=${pageSize}`
      let r = await api('GET', path, q)
      if (r.status === 429) { await sleep(3000); r = await api('GET', path, q) }
      if (r.status !== 200) { errors.push(`문의 ${kind} ${query.slice(0, 60)}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 100)}`); return null }
      if (!Array.isArray(r.body?.data?.content)) { errors.push(`문의 ${kind} ${query.slice(0, 60)}: 응답 형식 다름(data.content 없음)`); return null }
      const content = r.body.data.content
      out.push(...content)
      await sleep(200)
      // pagination 이 없으면 꽉 찬 페이지일 때만 다음 페이지를 더 읽는다
      const totalPages = Number(r.body.data.pagination?.totalPages)
      if (content.length === 0 || (Number.isFinite(totalPages) ? page >= totalPages : content.length < pageSize)) break
      if (page === MAX_PAGES) errors.push(`문의 ${kind} ${query.slice(0, 60)}: ${MAX_PAGES}쪽 넘음 — 일부 미수집`)
    }
    return out
  }
  /** 7일 창 하나 → 문의 행들. 하나라도 실패하면 null(그 창은 이번 회차 건너뜀) */
  async function fetchInquiryWindow(fromYmd, toYmd, errors) {
    const span = `inquiryStartAt=${fromYmd}&inquiryEndAt=${toYmd}`
    const online = await fetchInquiryPages('online', `${span}&answeredType=ALL`, errors)
    if (!online) return null
    const rows = online.map((x) => {
      const comments = Array.isArray(x.commentDtoList) ? x.commentDtoList : []
      return {
        kind: 'online', inquiry_id: x.inquiryId, order_id: Array.isArray(x.orderIds) ? (x.orderIds[0] ?? null) : null,
        seller_product_id: x.sellerProductId ?? null, vendor_item_id: x.vendorItemId ?? null, item_name: null,
        status: comments.length ? 'answered' : 'unanswered', needs_answer: comments.length === 0,
        inquired_at: x.inquiryAt || null, answered_at: comments.length ? (comments[comments.length - 1].inquiryCommentAt || null) : null,
      }
    })
    const all = await fetchInquiryPages('callcenter', `${span}&partnerCounselingStatus=NONE`, errors)
    if (!all) return null
    const need = new Map()
    for (const st of ['NO_ANSWER', 'TRANSFER']) {
      const l = await fetchInquiryPages('callcenter', `${span}&partnerCounselingStatus=${st}`, errors)
      if (!l) return null
      for (const x of l) need.set(String(x.inquiryId), x)
    }
    const callRows = new Map()
    for (const x of [...all, ...need.values()]) {
      callRows.set(String(x.inquiryId), {
        kind: 'callcenter', inquiry_id: x.inquiryId, order_id: x.orderId ?? null, seller_product_id: null,
        vendor_item_id: Array.isArray(x.vendorItemId) ? (x.vendorItemId[0] ?? null) : (x.vendorItemId ?? null),
        item_name: x.itemName ?? null, status: x.csPartnerCounselingStatus ?? null, needs_answer: need.has(String(x.inquiryId)),
        inquired_at: x.inquiryAt || null, answered_at: x.answeredAt || null,
      })
    }
    return [...rows, ...callRows.values()]
  }
  // 쿠팡 시각은 '+09:00' 포함 ISO, DB 는 timestamptz — 시각은 ms 로 비교(해석 불가 값은 원문 비교)
  const tsKey = (v) => { if (!v) return ''; const t = new Date(v).getTime(); return Number.isNaN(t) ? String(v) : String(t) }
  const sameInquiry = (prev, row) => INQ_COLS.every((k) => INQ_TS.includes(k)
    ? tsKey(prev[k]) === tsKey(row[k])
    : String(prev[k] ?? '') === String(row[k] ?? ''))

  /**
   * 최근 days일(7일 창) 문의 + 7일 창 밖에 남은 미답변 문의의 창을 다시 읽어 바뀐 것만 기록.
   * days 를 크게 주면(예: 180) 과거분 백필 — 한 번만 돌리면 된다.
   */
  async function syncInquiries({ days = 7, maxStaleWindows = 8 } = {}) {
    const errors = []
    const now = new Date()
    const windows = new Map()
    for (let off = 0; off < days; off += 7) {
      const to = new Date(now.getTime() - off * 86400000)
      windows.set(fmtKstYmd(new Date(to.getTime() - 6 * 86400000)), fmtKstYmd(to))
    }
    const { data: staleOpen, error: se } = await sb.from('jimscanner_coupang_inquiries')
      .select('inquired_at').eq('needs_answer', true).lt('inquired_at', new Date(now.getTime() - 6 * 86400000).toISOString())
      .order('inquired_at', { ascending: false }).limit(200)
    if (se) errors.push(`문의 미답변분 조회: ${se.message}`)
    let extra = 0
    for (const s of staleOpen ?? []) {
      if (extra >= maxStaleWindows || !s.inquired_at) break
      const d = new Date(s.inquired_at)
      const fromYmd = fmtKstYmd(d)
      if ([...windows].some(([f, t]) => f <= fromYmd && fromYmd <= t)) continue // 이미 읽는 창 안
      windows.set(fromYmd, fmtKstYmd(new Date(Math.min(d.getTime() + 6 * 86400000, now.getTime()))))
      extra++
    }
    const byKey = new Map()
    for (const [from, to] of windows) {
      const rows = await fetchInquiryWindow(from, to, errors)
      for (const r of rows ?? []) byKey.set(`${r.kind}:${r.inquiry_id}`, r)
    }
    const rows = [...byKey.values()]
    const stored = new Map()
    for (const kind of ['online', 'callcenter']) {
      const ids = rows.filter((r) => r.kind === kind).map((r) => r.inquiry_id)
      for (let i = 0; i < ids.length; i += 200) {
        const { data, error } = await sb.from('jimscanner_coupang_inquiries').select(`kind, inquiry_id, ${INQ_COLS.join(', ')}`).eq('kind', kind).in('inquiry_id', ids.slice(i, i + 200))
        if (error) throw new Error(`문의 저장분 조회: ${error.message}`)
        for (const s of data ?? []) stored.set(`${s.kind}:${s.inquiry_id}`, s)
      }
    }
    const changedRows = rows.filter((r) => { const p = stored.get(`${r.kind}:${r.inquiry_id}`); return !p || !sameInquiry(p, r) })
      .map((r) => ({ ...r, last_synced_at: new Date().toISOString() }))
    for (let i = 0; i < changedRows.length; i += 200) {
      const { error } = await sb.from('jimscanner_coupang_inquiries').upsert(changedRows.slice(i, i + 200), { onConflict: 'kind,inquiry_id' })
      if (error) { errors.push(`문의 기록: ${error.message}`); break }
    }
    const open = rows.filter((r) => r.needs_answer).length
    log(`  고객문의 ${rows.length}건(미답변 ${open}) · 기록 ${changedRows.length}${errors.length ? ` · 오류 ${errors.length}` : ''}`)
    return { fetched: rows.length, open, changed: changedRows.length, errors }
  }

  /**
   * 결제진행 게이트(2026-11-08 사장님 "출고중지요청 걸린 주문은 결제진행 막아줘").
   * 쿠팡 주문 행 o(order_id·vendor_item_id·ordered_at)에 대해 막을 사유를 돌려준다:
   *  - 출고중지요청(RELEASE_STOP_UNCHECKED) 미처리 → 고객이 발주확인 뒤 취소 요청
   *  - 출고 전 취소·출고중지가 이미 완료(RETURNS_COMPLETED + CANCEL 이거나 품목 출고중지) → 취소된 주문
   * DB 는 매시 갱신이라 그 사이 들어온 요청을 놓치지 않게 쿠팡에서 이 주문만 바로 읽고(orderId 조회는 상태 없이 RETURN 전부 + CANCEL 따로),
   * 새로 보인 접수는 테이블·주문 행에도 반영한다. 쿠팡 조회가 실패하면 DB 접수로만 판정하고 warn 을 돌려준다(쿠팡 장애로 매입 전체가 멈추지 않게).
   * @returns {Promise<{ block: string|null, warn: string|null }>}
   */
  async function purchaseBlock(o) {
    const byId = new Map()
    const errors = []
    let warn = null
    if (envOk()) {
      const now = new Date()
      const ordered = o.ordered_at ? new Date(o.ordered_at) : now
      const from = new Date(Math.max((Number.isNaN(ordered.getTime()) ? now : ordered).getTime() - 86400000, now.getTime() - 30 * 86400000))
      const base = `createdAtFrom=${fmtKstYmd(from)}&createdAtTo=${fmtKstYmd(now)}&orderId=${encodeURIComponent(String(o.order_id))}`
      let okReturn = false, okCancel = false
      try {
        okReturn = await fetchReturnList(`order#${o.order_id}`, base, byId, errors)
        okCancel = await fetchReturnList(`order#${o.order_id} 취소`, `${base}&cancelType=CANCEL`, byId, errors)
      } catch (e) { errors.push(e instanceof Error ? e.message : String(e)) } // 네트워크 예외(ECONNRESET 등)도 '조회 실패'로
      if (!okReturn || !okCancel) warn = `쿠팡 출고중지·취소 실시간 확인 실패(${errors[0] ?? ''}) — 매시 수집분(DB)으로만 확인`
      else if (byId.size) {
        try { await recordReceipts([...byId.values()], errors) } catch (e) { log(`  [purchase-gate] 접수 기록 실패: ${e instanceof Error ? e.message : e}`) }
      }
    } else warn = '쿠팡 키 누락 — 출고중지 실시간 확인 못 함, DB로만 확인'
    // DB 접수도 합친다(실시간 조회 실패·31일 밖 대비). 실시간 결과가 있으면 그쪽 우선
    const { data: stored, error } = await sb.from('jimscanner_coupang_return_requests').select('receipt_id, raw_payload').eq('order_id', o.order_id)
    if (error) {
      // 쿠팡·DB 둘 다 확인 못 하면 막는다(취소된 주문을 살 위험) — 하나라도 되면 그걸로 판정
      if (warn) return { block: `쿠팡 출고중지·취소 여부를 확인할 수 없어 결제진행을 막았습니다(쿠팡: ${warn} / DB: ${error.message}). 잠시 후 다시 시도하세요.`, warn }
      warn = `DB 접수 조회 실패: ${error.message} — 쿠팡 실시간 조회로만 확인`
    }
    for (const s of stored ?? []) if (!byId.has(String(s.receipt_id)) && s.raw_payload) byId.set(String(s.receipt_id), s.raw_payload)

    const vid = o.vendor_item_id == null ? null : String(o.vendor_item_id)
    for (const rc of byId.values()) {
      const items = rc.returnItems ?? []
      const item = vid ? items.find((i) => String(i.vendorItemId) === vid) : undefined
      if (vid && items.length > 0 && !item) continue // 같은 주문의 다른 상품 접수
      const why = [rc.cancelReasonCategory1, rc.cancelReasonCategory2].filter(Boolean).join('/') || rc.cancelReason || '사유 없음'
      const partial = item && Number(item.cancelCount ?? 0) < Number(o.shipping_count ?? 1) ? ` (주문 ${o.shipping_count}개 중 ${item.cancelCount}개)` : ''
      if (rc.receiptStatus === 'RELEASE_STOP_UNCHECKED') {
        return { block: `🛑 쿠팡 출고중지요청(${why})${partial} — 고객이 취소를 요청한 주문이라 결제진행을 막았습니다. 매입처에 발주하지 말고 Wing에서 출고중지 처리하세요. 접수번호 ${rc.receiptId}`, warn }
      }
      // 출고 전 여부는 이 라인 품목 기준(한 접수에 출고 전·후 품목이 섞일 수 있음), 품목을 모르면 접수 전체 기준
      const preShip = rc.receiptType === 'CANCEL' || (item ? ['S', 'N'].includes(String(item.releaseStatus ?? '')) : isPreShip(rc))
      if (rc.receiptStatus === 'RETURNS_COMPLETED' && preShip) {
        const kind = rc.receiptType === 'CANCEL' ? '취소' : '출고중지'
        return { block: `쿠팡에서 ${kind} 완료된 주문(${why})${partial} — 결제진행을 막았습니다.${partial ? ' 남은 수량만 사야 하면 매입처에서 직접 주문하세요.' : ''} 접수번호 ${rc.receiptId}`, warn }
      }
    }
    return { block: null, warn }
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

    // 저장된 주문 — 비교를 못 하면(조회 실패) 예전처럼 전부 upsert
    const itemIds = [...new Set(orderItemsAll.flatMap((o) => (o.orderItems ?? []).map((it) => it.vendorItemPackageId || o.shipmentBoxId)).filter(Boolean))]
    const stored = new Map()
    for (let i = 0; i < itemIds.length; i += 200) {
      const { data, error } = await sb.from('jimscanner_coupang_orders').select(ORDER_COLS).in('order_item_id', itemIds.slice(i, i + 200))
      if (error) { log(`  저장된 주문 조회 실패 — 이번 회차는 전부 기록: ${error.message}`); stored.clear(); break }
      for (const s of data ?? []) stored.set(String(s.order_item_id), s)
    }

    let inserted = 0
    let unchanged = 0
    let errors = errorSamples.length
    for (const order of orderItemsAll) {
      try {
        const items = order.orderItems ?? []
        const payloadKey = canon(order)
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
          if (sameAsStored(stored.get(String(orderItemId)), row, payloadKey)) { unchanged++; continue }
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

    // 반품·취소 요청(출고중지요청 포함) — 주문 목록과 별개 API라 목록 실패와 무관하게 매 회차 읽는다
    let claims = { fetched: 0, open: 0, stopRequests: 0, changed: 0, flagged: 0, cancelled: 0, errors: [] }
    try {
      claims = await syncReturnRequests()
    } catch (e) {
      claims.errors = [e instanceof Error ? e.message : String(e)]
      log(`  반품·취소 요청 수집 실패: ${claims.errors[0]}`)
    }
    errors += claims.errors.length
    for (const m of claims.errors) if (errorSamples.length < 5) errorSamples.push(m)

    // 고객문의 건수·답변 상태(주문 화면 기간 카드용)
    let inquiries = { fetched: 0, open: 0, changed: 0, errors: [] }
    try {
      inquiries = await syncInquiries()
    } catch (e) {
      inquiries.errors = [e instanceof Error ? e.message : String(e)]
      log(`  고객문의 수집 실패: ${inquiries.errors[0]}`)
    }
    errors += inquiries.errors.length
    for (const m of inquiries.errors) if (errorSamples.length < 5) errorSamples.push(m)

    const durationMs = Date.now() - t0
    log(`[coupang-orders-sync/${triggeredBy}] total=${total} inserted=${inserted} unchanged=${unchanged} errors=${errors} reconcile(checked=${reconciled.checked} cancelled=${reconciled.cancelled} refreshed=${reconciled.refreshed}${reconciled.pending ? ` pending=${reconciled.pending}` : ''}) claims(fetched=${claims.fetched} open=${claims.open} stop=${claims.stopRequests} changed=${claims.changed} flagged=${claims.flagged}) inquiries(fetched=${inquiries.fetched} open=${inquiries.open} changed=${inquiries.changed}) (${(durationMs / 1000).toFixed(1)}s)`)

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

    return {
      total, inserted, unchanged, errors, errorSamples, durationMs,
      cancelled: reconciled.cancelled + claims.cancelled, refreshed: reconciled.refreshed,
      claimsOpen: claims.open, claimsStop: claims.stopRequests, claimsFlagged: claims.flagged,
      inquiriesOpen: inquiries.open,
    }
  }

  // syncReturnRequests·syncInquiries 는 과거분 백필(backfillDays·days)용으로도 노출
  return { syncRecentOrders, purchaseBlock, syncReturnRequests, syncInquiries }
}
