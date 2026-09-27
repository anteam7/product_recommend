/**
 * 네이버 커머스 API 주문 쓰기·동기화 — 로컬 실행 공용 모듈 (쿠팡 scripts/lib/coupang-invoice.mjs 미러).
 *
 * 왜 로컬인가: 네이버 커머스 API는 IP 허용목록제라 Vercel 라우트에서는 GW.IP_NOT_ALLOWED 로 막힌다.
 * 브라우저→127.0.0.1 헬퍼 폴백도 기기·브라우저 권한에 따라 막혀 신뢰할 수 없다(쿠팡 2026-08-20 교훈,
 * 네이버 발주확인도 2026-09-26 5건 전부 실패). 그래서 집 PC(허용 IP)에서 도는
 *   - scripts/order-server.mjs            (purchase_jobs 잡: naver_confirm / naver_dispatch)
 *   - scripts/local-cron-naver-orders-sync.mjs (상태 동기화 · 매입처 송장 자동수집 → 자동 발송처리)
 * 가 이 모듈을 공유한다.
 *
 * 사용: const ops = createNaverOrderOps({ sb, log: console.log })
 *       await ops.refreshByIds(['2026092668205621'])      // 네이버 실값으로 DB 갱신
 *       await ops.confirm('2026092668205621')              // 발주확인
 *       await ops.dispatch('2026092668205621')             // 발송처리(게이트·멱등·DB 전이)
 */
import { naverApi } from './naver-api.mjs'

const TABLE = 'jimscanner_naver_orders'
const MAX_ATTEMPTS = 5

/** 더 이상 바뀌지 않는 상태 — 진행 중 주문 재조회 대상에서 제외 */
export const NAVER_FINAL_STATUSES = new Set(['PURCHASE_DECIDED', 'CANCELED', 'RETURNED', 'EXCHANGED', 'CANCELED_BY_NOPAYMENT'])
/** 네이버에 이미 발송된 상태 — 발송처리 API 없이 manual_done 동기화 */
const ALREADY_DISPATCHED = new Set(['DELIVERING', 'DELIVERED', 'PURCHASE_DECIDED', 'EXCHANGED'])
/** 발송 불가 상태 */
const NOT_DISPATCHABLE = new Set(['PAYMENT_WAITING', 'CANCELED', 'RETURNED', 'CANCELED_BY_NOPAYMENT'])
const DISPATCH_DONE = new Set(['registered', 'manual_done'])

// 택배사 한글명(어드민 InvoiceCell·매입처 표기) → 네이버 deliveryCompanyCode.
// CJGLS·HANJIN·HYUNDAI(=롯데택배)는 네이버 개발자 포럼 실사용 예로 확인. 나머지는 네이버/쿠팡 공용 표기 관례 —
// 틀리면 발송처리가 실패해 failed + needs_attention 으로 드러난다(잘못 발송되지는 않음). 매입처 송장은 실측상 CJ·한진뿐.
const CARRIER_CODES = [
  [/CJ|대한통운/i, 'CJGLS'],
  [/한진/, 'HANJIN'],
  [/롯데|현대택배/, 'HYUNDAI'],
  [/우체국/, 'EPOST'],
  [/로젠/, 'KGB'],
  [/경동/, 'KDEXP'],
  [/대신/, 'DAESIN'],
  [/GS\s*Postbox|GS편의점|편의점택배/i, 'CVSNET'],
]
// 네이버 응답의 delivery.deliveryCompany 는 코드로 온다(실측: CJGLS, HANJIN) → DB엔 어드민 표기(한글명)로 저장
const CODE_TO_NAME = { CJGLS: 'CJ대한통운', HANJIN: '한진택배', HYUNDAI: '롯데택배', EPOST: '우체국택배', KGB: '로젠택배', KDEXP: '경동택배', DAESIN: '대신택배', CVSNET: 'GSPostbox' }
export function naverCodeToCarrierName(code) {
  return CODE_TO_NAME[String(code ?? '').trim().toUpperCase()] ?? (code || null)
}
export function carrierToNaverCode(name) {
  const s = String(name ?? '').trim()
  if (!s) return null
  if (CODE_TO_NAME[s.toUpperCase()]) return s.toUpperCase() // 이미 네이버 코드
  for (const [re, code] of CARRIER_CODES) if (re.test(s)) return code
  return null
}

/** 송장번호 정규화 — 숫자만(유픽 CJ 송장은 '6995-6837-5375'처럼 하이픈 포함) */
export function normalizeTracking(raw) {
  const d = String(raw ?? '').replace(/\D/g, '')
  return d.length >= 8 ? d : null
}

/** 네이버 dispatchDate 형식: 밀리초 + 타임존 필수 (예: 2026-09-27T10:40:00.000+09:00) */
function kstIsoMs(d = new Date()) {
  return new Date(d.getTime() + 9 * 3600e3).toISOString().replace('Z', '+09:00')
}

/**
 * 네이버 상품주문 → DB 행. 응답 형태 2종을 모두 받는다:
 *   GET product-orders(조건형)  = { productOrderId, content: { order, productOrder, delivery } }
 *   POST product-orders/query   = { order, productOrder, delivery }  → content 래핑으로 통일(raw_payload 호환:
 *                                  order-server resolveNaverOrder 가 raw_payload.content.productOrder 를 읽는다)
 * 우리가 기록하는 컬럼(purchase_*, supplier_*, naver_dispatch_*, needs_attention …)은 넣지 않는다 → upsert 가 보존.
 * 배송 컬럼(tracking_number/delivery_company/shipped_at)은 **네이버에 값이 있을 때만** 넣는다
 * (null 로 덮으면 어드민에서 입력한 송장이 지워진다).
 */
export function naverItemToRow(item) {
  const o = item?.content ? item : { productOrderId: item?.productOrder?.productOrderId, content: item }
  const po = o.content?.productOrder ?? {}
  const od = o.content?.order ?? {}
  const dv = o.content?.delivery ?? {}
  const addr = po.shippingAddress
  const commissions = [po.paymentCommission, po.saleCommission, po.channelCommission, po.knowledgeShoppingSellingInterlockCommission].filter((v) => typeof v === 'number')
  const now = new Date().toISOString()
  const row = {
    product_order_id: String(o.productOrderId ?? po.productOrderId ?? ''),
    order_id: String(od.orderId ?? o.orderId ?? ''),
    channel_product_no: po.productId ? String(po.productId) : null,
    origin_product_no: po.originalProductId ? Number(po.originalProductId) : null,
    product_name: po.productName ?? '',
    option_name: po.productOption ?? null,
    quantity: po.quantity ?? 1,
    total_payment_amount: po.totalPaymentAmount ?? null,
    commission_amount: commissions.length ? commissions.reduce((a, b) => a + b, 0) : null,
    product_order_status: po.productOrderStatus ?? '',
    place_order_status: po.placeOrderStatus ?? null,
    claim_status: po.claimStatus ?? null,
    payment_date: od.paymentDate ?? null,
    order_date: od.orderDate ?? od.paymentDate ?? now,
    receiver_name: addr?.name ?? null,
    receiver_phone: addr?.tel1 ?? null,
    receiver_address: addr ? [addr.baseAddress, addr.detailedAddress].filter(Boolean).join(' ') : null,
    raw_payload: { productOrderId: String(o.productOrderId ?? po.productOrderId ?? ''), content: o.content },
    last_synced_at: now,
    updated_at: now,
  }
  if (dv.deliveryCompany) row.delivery_company = naverCodeToCarrierName(dv.deliveryCompany)
  if (dv.trackingNumber) row.tracking_number = dv.trackingNumber
  if (dv.sendDate) row.shipped_at = dv.sendDate
  if (dv.deliveredDate) row.delivered_at = dv.deliveredDate
  return row
}

export function createNaverOrderOps({ sb, log = () => {} }) {
  const nowIso = () => new Date().toISOString()
  const logAction = (action, target_id, summary, metadata) =>
    sb.from('jimscanner_admin_actions').insert({ actor: 'local', action, target_type: 'naver_order', target_id, summary, metadata }).then(() => {}, () => {})

  /** POST /query — 상품주문 상세(최대 300건/호출). 실패 시 throw(fail-closed). */
  async function fetchDetails(ids) {
    const out = []
    for (let i = 0; i < ids.length; i += 300) {
      const batch = ids.slice(i, i + 300).map(String)
      const r = await naverApi('POST', '/v1/pay-order/seller/product-orders/query', { productOrderIds: batch })
      if (r.status !== 200) throw new Error(`네이버 상세조회 HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 160)}`)
      out.push(...(r.body?.data ?? []))
    }
    return out
  }

  /** 네이버 항목들을 DB에 반영(upsert). 반환 = 성공 건수 */
  async function upsertItems(items) {
    let ok = 0
    for (const it of items) {
      const row = naverItemToRow(it)
      if (!row.product_order_id) continue
      const { error } = await sb.from(TABLE).upsert(row, { onConflict: 'product_order_id' })
      if (error) log(`  [naver] upsert 실패 ${row.product_order_id}: ${error.message}`)
      else ok++
    }
    return ok
  }

  async function refreshByIds(ids) {
    if (!ids.length) return { fetched: 0, upserted: 0, items: [] }
    const items = await fetchDetails(ids)
    return { fetched: items.length, upserted: await upsertItems(items), items }
  }

  /**
   * 변경된 상품주문 ID — GET last-changed-statuses (창 최대 24h, more 페이징).
   * ⚠ 발주확인(placeOrderStatus)은 '상태 변경'이 아니라 여기 안 잡힌다(2026-09-27 실측) → 진행 중 주문 재조회로 보완.
   */
  async function changedIdsSince(from, to = new Date()) {
    const ids = new Set()
    for (let wFrom = new Date(from); wFrom < to; wFrom = new Date(wFrom.getTime() + 24 * 3600e3)) {
      const wTo = new Date(Math.min(wFrom.getTime() + 24 * 3600e3, to.getTime()))
      let moreFrom = null, moreSequence = null
      for (let page = 0; page < 50; page++) {
        const qs = new URLSearchParams({ lastChangedFrom: kstIsoMs(moreFrom ? new Date(moreFrom) : wFrom), lastChangedTo: kstIsoMs(wTo) })
        if (moreSequence) qs.set('moreSequence', moreSequence)
        const r = await naverApi('GET', `/v1/pay-order/seller/product-orders/last-changed-statuses?${qs}`)
        if (r.status !== 200) throw new Error(`변경조회 HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 160)}`)
        for (const s of r.body?.data?.lastChangeStatuses ?? []) ids.add(String(s.productOrderId))
        const more = r.body?.data?.more
        if (!more?.moreFrom) break
        moreFrom = more.moreFrom; moreSequence = more.moreSequence ?? null
      }
    }
    return [...ids]
  }

  async function loadRow(productOrderId) {
    const { data, error } = await sb.from(TABLE)
      .select('id, product_order_id, product_name, purchase_status, purchase_ordered_at, purchase_received_at, tracking_number, delivery_company, shipped_at, place_order_status, product_order_status, naver_dispatch_status, naver_dispatch_attempts')
      .eq('product_order_id', String(productOrderId)).maybeSingle()
    if (error) throw new Error(`DB 조회 실패: ${error.message}`)
    return data
  }

  /** 발주확인 API 호출만(게이트 없음) */
  async function callConfirm(productOrderId) {
    const r = await naverApi('POST', '/v1/pay-order/seller/product-orders/confirm', { productOrderIds: [String(productOrderId)] })
    const success = r.body?.data?.successProductOrderIds?.map(String)?.includes(String(productOrderId)) ?? false
    const fail = r.body?.data?.failProductOrderInfos?.find((f) => String(f.productOrderId) === String(productOrderId))
    const already = /이미.{0,10}(발주|확인)|ALREADY/i.test(fail?.message ?? '')
    if (r.status === 200 && (success || already)) return { ok: true, detail: already ? '이미 발주확인됨' : 'OK' }
    return { ok: false, detail: `HTTP ${r.status} ${fail?.code ?? ''} ${fail?.message ?? JSON.stringify(r.body).slice(0, 150)}`.trim() }
  }

  /** 발주확인 — 네이버 실상태 재조회 후 결제완료(PAYED)·미확인일 때만 호출. 멱등. */
  async function confirm(productOrderId) {
    const id = String(productOrderId)
    const row = await loadRow(id)
    if (!row) return { ok: false, status: 404, detail: '주문 없음(DB)' }
    const [live] = await fetchDetails([id])
    if (!live) return { ok: false, status: 404, detail: '네이버에서 주문을 찾지 못함' }
    await upsertItems([live])
    const po = live.productOrder ?? live.content?.productOrder ?? {}
    if (po.placeOrderStatus === 'OK') return { ok: true, status: 200, detail: '이미 발주확인됨' }
    if (po.productOrderStatus !== 'PAYED') return { ok: false, status: 409, skipped: true, detail: `발주확인 불가 상태(${po.productOrderStatus})` }
    const r = await callConfirm(id)
    if (r.ok) {
      await sb.from(TABLE).update({ place_order_status: 'OK', updated_at: nowIso() }).eq('id', row.id)
      log(`[naver-confirm] ${id} → OK`)
      await logAction('naver_order_confirm', row.id, `주문#${id} 네이버 발주확인 (${(row.product_name ?? '').slice(0, 24)})`, { detail: r.detail })
    }
    return { ...r, status: r.ok ? 200 : 502 }
  }

  /**
   * 발송처리 — 게이트(네이버 실상태 재조회 fail-closed) · 멱등 · DB 전이.
   *   이미 네이버에 발송됨(배송중 이후) → API 없이 manual_done + 발송완료(RECEIVED) 동기화
   *   클레임(취소·반품 요청 등)·발송불가 상태·택배사 미매핑·송장 없음 → failed + needs_attention
   *   결제완료(PAYED) → (미확인이면 발주확인 먼저) → dispatch → registered + RECEIVED
   */
  async function dispatch(productOrderId) {
    const id = String(productOrderId)
    const row = await loadRow(id)
    if (!row) return { ok: false, status: 404, detail: '주문 없음(DB)' }
    if (DISPATCH_DONE.has(row.naver_dispatch_status)) return { ok: true, status: 200, detail: `이미 처리됨(${row.naver_dispatch_status})` }
    if ((row.naver_dispatch_attempts ?? 0) >= MAX_ATTEMPTS) return { ok: false, status: 429, detail: `재시도 한도(${MAX_ATTEMPTS}회) 초과 — 스마트스토어센터에서 확인` }

    const fail = async (detail, { attention = true, countAttempt = true } = {}) => {
      const upd = { naver_dispatch_status: 'failed', naver_dispatch_error: detail.slice(0, 500), updated_at: nowIso() }
      if (countAttempt) upd.naver_dispatch_attempts = (row.naver_dispatch_attempts ?? 0) + 1
      if (attention) { upd.needs_attention = true; upd.attention_reason = detail.slice(0, 200) }
      await sb.from(TABLE).update(upd).eq('id', row.id)
      log(`[naver-dispatch] ${id} ✗ ${detail}`)
      return { ok: false, status: 409, detail }
    }
    // 네이버에 이미 발송된 주문 — 송장이 비어 있으면 네이버 값으로 채우고 발송완료로 맞춘다
    const syncManualDone = async (po, dv, note) => {
      const upd = { naver_dispatch_status: 'manual_done', naver_dispatch_error: null, needs_attention: false, attention_reason: null, updated_at: nowIso() }
      if (!row.tracking_number && dv.trackingNumber) upd.tracking_number = dv.trackingNumber
      if (!row.delivery_company && dv.deliveryCompany) upd.delivery_company = naverCodeToCarrierName(dv.deliveryCompany)
      if (!row.shipped_at && dv.sendDate) upd.shipped_at = dv.sendDate
      if (row.purchase_status !== 'CANCELLED') {
        upd.purchase_status = 'RECEIVED'
        if (!row.purchase_ordered_at) upd.purchase_ordered_at = nowIso()
        if (!row.purchase_received_at) upd.purchase_received_at = nowIso()
      }
      await sb.from(TABLE).update(upd).eq('id', row.id)
      log(`[naver-dispatch] ${id} = manual_done (${note})`)
      return { ok: true, status: 200, detail: `네이버에 이미 발송됨(${note}) — 동기화만` }
    }

    let live
    try { [live] = await fetchDetails([id]) } catch (e) { return { ok: false, status: 502, detail: `네이버 재조회 실패 — 발송 보류: ${e.message}` } }
    if (!live) return fail('네이버에서 주문을 찾지 못함')
    await upsertItems([live])
    const po = live.productOrder ?? {}
    const dv = live.delivery ?? {}
    const st = po.productOrderStatus
    if (ALREADY_DISPATCHED.has(st)) return syncManualDone(po, dv, st)
    if (po.claimStatus && !/REJECT/.test(po.claimStatus)) return fail(`네이버 클레임 진행 중(${po.claimStatus}) — 발송 중단`, { countAttempt: false })
    if (NOT_DISPATCHABLE.has(st) || st !== 'PAYED') return fail(`발송 불가 상태(${st})`, { countAttempt: false })

    const trackingNumber = normalizeTracking(row.tracking_number)
    const code = carrierToNaverCode(row.delivery_company)
    if (!trackingNumber) return fail('송장번호 없음/형식 오류', { countAttempt: false })
    if (!code) return fail(`택배사 미매핑(${row.delivery_company ?? '없음'}) — 네이버 택배사 코드 확인 필요`, { countAttempt: false })

    // 발주확인 전이면 먼저(쿠팡 ack→invoice 순서와 동일). 실패해도 발송처리는 시도한다.
    if (po.placeOrderStatus !== 'OK') {
      const c = await callConfirm(id)
      if (c.ok) await sb.from(TABLE).update({ place_order_status: 'OK' }).eq('id', row.id)
      else log(`[naver-dispatch] ${id} 발주확인 선행 실패(계속 진행): ${c.detail}`)
    }

    const r = await naverApi('POST', '/v1/pay-order/seller/product-orders/dispatch', {
      dispatchProductOrders: [{ productOrderId: id, deliveryMethod: 'DELIVERY', deliveryCompanyCode: code, trackingNumber, dispatchDate: kstIsoMs() }],
    })
    const success = r.status === 200 && (r.body?.data?.successProductOrderIds ?? []).map(String).includes(id)
    if (success) {
      const now = nowIso()
      const upd = {
        naver_dispatch_status: 'registered', naver_dispatched_at: now, naver_dispatch_error: null,
        naver_dispatch_attempts: (row.naver_dispatch_attempts ?? 0) + 1,
        needs_attention: false, attention_reason: null,
        product_order_status: 'DELIVERING', tracking_number: trackingNumber, updated_at: now,
      }
      if (!row.shipped_at) upd.shipped_at = now
      if (row.purchase_status !== 'CANCELLED') {
        upd.purchase_status = 'RECEIVED'
        if (!row.purchase_ordered_at) upd.purchase_ordered_at = now
        if (!row.purchase_received_at) upd.purchase_received_at = now
      }
      await sb.from(TABLE).update(upd).eq('id', row.id)
      log(`[naver-dispatch] ${id} ✓ ${code} ${trackingNumber}`)
      await logAction('naver_order_dispatch', row.id, `주문#${id} 네이버 발송처리 ${row.delivery_company} ${trackingNumber} (${(row.product_name ?? '').slice(0, 24)})`, { code, trackingNumber })
      return { ok: true, status: 200, detail: `발송처리 완료 ${row.delivery_company} ${trackingNumber}` }
    }
    const f = r.body?.data?.failProductOrderInfos?.find((x) => String(x.productOrderId) === id)
    const detail = `발송처리 실패 HTTP ${r.status} ${f?.code ?? ''} ${f?.message ?? JSON.stringify(r.body).slice(0, 150)}`.trim()
    // 9999 '주문상태 및 클레임상태를 확인하세요' = 그 사이 상태가 바뀐 경우(이미 발송 등) — 재조회해 동기화 판단
    try {
      const [again] = await fetchDetails([id])
      if (again && ALREADY_DISPATCHED.has(again.productOrder?.productOrderStatus)) { await upsertItems([again]); return syncManualDone(again.productOrder, again.delivery ?? {}, again.productOrder.productOrderStatus) }
    } catch { /* 재조회 실패 → 실패로 기록 */ }
    // 마지막 시도였으면 사람이 보게, 아니면 다음 회차 재시도(조용히)
    return fail(detail, { attention: (row.naver_dispatch_attempts ?? 0) + 1 >= MAX_ATTEMPTS })
  }

  return { fetchDetails, upsertItems, refreshByIds, changedIdsSince, confirm, dispatch }
}
