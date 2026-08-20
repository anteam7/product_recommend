/**
 * 쿠팡 OpenAPI(HMAC) 발주확인(acknowledgement) + 송장등록(invoices) — 로컬 실행 공용 모듈.
 *
 * 왜 로컬인가: Vercel 라우트(update/route.ts 의 ack, register-invoice/route.ts)는 쿠팡 OpenAPI IP 접근제어에
 * 막혀(403) 실제 쓰기가 불가하다(2026-08-20 확정). 그래서 집 PC(허용 IP)에서 도는
 *   - scripts/order-server.mjs  (/coupang-ack, /coupang-invoice — 어드민 브라우저 폴백)
 *   - scripts/local-cron-ggsan-sync.mjs (매입처 송장 자동수집 → 자동등록)
 * 가 이 모듈을 공유한다. 로직은 register-invoice/route.ts 의 미러(게이트·멱등·DB 전이) — 바꿀 때 양쪽 동기화.
 *
 * 사용: const ops = createCoupangInvoiceOps({ sb, env, log: console.log })
 *       await ops.ackByOrderId('32102411494184')
 *       await ops.registerInvoice({ orderId: '32102411494184' })  // 또는 { id: '<uuid>' }
 */
import crypto from 'node:crypto'
import { carrierToCode } from './coupang-carrier-map.mjs'

const ACK_OR_LATER = new Set(['INSTRUCT', 'DEPARTURE', 'DELIVERING', 'FINAL_DELIVERY'])
/** 쿠팡 쪽에 송장이 이미 올라간 상태(배송지시 이후). 이 상태면 invoices 호출 없이 manual_done 으로 동기화 */
const INVOICE_ALREADY_ON_COUPANG = new Set(['DEPARTURE', 'DELIVERING', 'FINAL_DELIVERY'])
const CANCELLED = new Set(['CANCEL', 'CANCELLED', 'RETURNS', 'RETURN', 'EXCHANGE'])
const ACK_ALREADY_RE = /이미.{0,8}(처리|확인|준비)|상품준비중|출고지시|already.{0,12}(process|acknowledg|done)/i
const INV_DONE = new Set(['uploaded', 'duplicate', 'manual_done'])
const MAX_ATTEMPTS = 5
const TABLE = 'jimscanner_coupang_orders'
const SELECT = 'id, order_id, shipment_box_id, vendor_item_id, product_name, shipping_status, receiver_name, purchase_status, ggsan_invoice_number, ggsan_carrier_name, ggsan_shipped_at, invoice_number, delivery_company, shipped_at, coupang_invoice_status, coupang_invoice_attempts'

/** 송장번호 정규화 — 유픽(Cafe24) CJ 송장은 '6995-6837-5375' 처럼 하이픈 포함으로 노출됨. 쿠팡은 숫자만 받는다. */
export function normalizeInvoiceNo(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '')
  return digits.length >= 8 ? digits : null
}

// invoices 응답 파싱 — register-invoice/route.ts parseInvoicesResult 미러
function parseInvoicesResult(json, text) {
  const item = json && Array.isArray(json.responseList) ? json.responseList[0] : null
  if (item && typeof item.succeed === 'boolean') return { succeed: item.succeed, resultCode: String(item.resultCode ?? ''), message: String(item.resultMessage ?? '') }
  if (/"succeed"\s*:\s*false|failResultMap|"resultCode"\s*:\s*"?FAIL|등록\s*실패/i.test(text)) return { succeed: false, resultCode: 'FAIL', message: text.slice(0, 200) }
  return { succeed: null, resultCode: String(json?.responseCode ?? ''), message: text.slice(0, 200) }
}
const isDuplicateInvoice = (r) => /ALREADY|DUP|EXIST/i.test(r.resultCode) || /이미.{0,4}등록|중복.{0,4}(송장|운송장|등록)|6개월|already.{0,12}(register|exist)|duplicate/i.test(r.message)

export function createCoupangInvoiceOps({ sb, env, log = () => {} }) {
  const HOST = env.COUPANG_API_HOST || 'https://api-gateway.coupang.com'
  const vendorId = env.COUPANG_VENDOR_ID
  const envOk = () => !!(vendorId && env.COUPANG_ACCESS_KEY && env.COUPANG_SECRET_KEY)
  const now = () => new Date().toISOString()

  async function api(method, urlPath, body = null) {
    const dt = new Date().toISOString().substring(2, 19).replace(/[-:]/g, '') + 'Z'
    const signature = crypto.createHmac('sha256', env.COUPANG_SECRET_KEY).update(dt + method + urlPath).digest('hex')
    const res = await fetch(`${HOST}${urlPath}`, {
      method,
      headers: {
        Authorization: `CEA algorithm=HmacSHA256, access-key=${env.COUPANG_ACCESS_KEY}, signed-date=${dt}, signature=${signature}`,
        'Content-Type': 'application/json;charset=UTF-8',
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* text */ }
    return { status: res.status, text, json }
  }

  const logAction = (target_id, summary, metadata) =>
    sb.from('jimscanner_admin_actions').insert({ actor: 'local', action: 'coupang_invoice_register', target_type: 'coupang_order', target_id, summary, metadata }).then(() => {}, () => {})

  /** 발주확인(결제완료 ACCEPT → 상품준비중 INSTRUCT). 이미 상품준비중 이후면 멱등 통과. */
  async function ackByOrderId(orderId) {
    try {
      if (!envOk()) return { ok: false, status: 500, detail: '쿠팡 API 키/VENDOR_ID 미설정(.env.local)' }
      const { data: ord, error } = await sb.from(TABLE).select('id, order_id, shipment_box_id, shipping_status').eq('order_id', orderId).limit(1).maybeSingle()
      if (error) return { ok: false, status: 500, detail: `DB 조회 실패: ${error.message}` }
      if (!ord) return { ok: false, status: 404, detail: '주문 없음' }
      if (ACK_OR_LATER.has(String(ord.shipping_status ?? '').toUpperCase())) return { ok: true, status: 200, detail: `이미 상품준비중 이후(${ord.shipping_status})` }
      if (ord.shipment_box_id == null) return { ok: false, status: 422, detail: 'shipmentBoxId 없음' }
      const r = await api('PUT', `/v2/providers/openapi/apis/api/v4/vendors/${vendorId}/ordersheets/acknowledgement`, { vendorId, shipmentBoxIds: [Number(ord.shipment_box_id)] })
      const already = ACK_ALREADY_RE.test(r.text)
      if (r.status === 200 || already) {
        await sb.from(TABLE).update({ shipping_status: 'INSTRUCT', last_synced_at: now() }).eq('id', ord.id)
        log(`[coupang-ack] order#${orderId} box=${ord.shipment_box_id} → INSTRUCT (${already ? 'already' : 'OK'})`)
        return { ok: true, status: 200, detail: already ? '이미 처리됨' : 'OK' }
      }
      log(`[coupang-ack] order#${orderId} HTTP ${r.status} ${r.text.slice(0, 200)}`)
      return { ok: false, status: 502, detail: `HTTP ${r.status} ${r.text.slice(0, 150)}` }
    } catch (e) {
      return { ok: false, status: 502, detail: e?.message || String(e) }
    }
  }

  /**
   * 송장등록 풀 플로우. 소스: ggsan/유픽 크론 감지 송장(ggsan_*) 우선, 없으면 InvoiceCell 수동(invoice_number/delivery_company).
   * 반환 { ok, status, detail, aborted?, invoice_status? }  invoice_status ∈ uploaded|duplicate|manual_done|failed
   */
  async function registerInvoice({ id = null, orderId = null }) {
    const tag = `[coupang-invoice] ${id ? `id=${id}` : `order#${orderId}`}`
    try {
      if (!envOk()) return { ok: false, status: 500, detail: '쿠팡 API 키/VENDOR_ID 미설정(.env.local)' }
      let q = sb.from(TABLE).select(SELECT)
      q = id ? q.eq('id', id) : q.eq('order_id', orderId)
      const { data: o, error } = await q.limit(1).maybeSingle()
      if (error) return { ok: false, status: 500, detail: `DB 조회 실패: ${error.message}` }
      if (!o) return { ok: false, status: 404, detail: '주문 없음' }
      const upd = (patch) => sb.from(TABLE).update(patch).eq('id', o.id)
      const abort = async (reason) => { await upd({ needs_attention: true, attention_reason: reason }); log(`${tag} abort: ${reason}`); return { ok: false, status: 409, aborted: true, detail: reason } }

      // 멱등 가드
      const invStatus = o.coupang_invoice_status ?? 'none'
      if (INV_DONE.has(invStatus)) return { ok: true, status: 200, detail: `이미 처리됨(${invStatus})`, invoice_status: invStatus }

      const invoiceNo = normalizeInvoiceNo(o.ggsan_invoice_number ?? o.invoice_number)
      const carrierName = o.ggsan_carrier_name ?? o.delivery_company ?? null
      const source = o.ggsan_invoice_number ? 'supplier' : 'manual'
      const shipUpper = String(o.shipping_status ?? '').toUpperCase()

      // 동기화: 쿠팡이 이미 배송지시 이후 = Wing 등에서 송장이 이미 등록됨 → API 호출 없이 manual_done + RECEIVED
      if (INVOICE_ALREADY_ON_COUPANG.has(shipUpper)) {
        const t = now()
        await upd({
          coupang_invoice_status: 'manual_done', purchase_status: 'RECEIVED', purchase_received_at: t,
          invoice_number: o.invoice_number ?? invoiceNo, delivery_company: o.delivery_company ?? carrierName,
          shipped_at: o.shipped_at ?? o.ggsan_shipped_at ?? t, coupang_invoice_error: null, last_synced_at: t,
        })
        log(`${tag} 쿠팡 이미 ${o.shipping_status} → manual_done 동기화`)
        return { ok: true, status: 200, detail: `쿠팡에 이미 등록됨(${o.shipping_status}) — 발송완료 동기화`, invoice_status: 'manual_done' }
      }

      if ((o.coupang_invoice_attempts ?? 0) >= MAX_ATTEMPTS) return abort('등록실패(재시도 상한)')

      // HARD GATE ②③
      if (!o.receiver_name) return abort('수령인 정보 없음')
      if (!invoiceNo) return abort('송장번호 없음')
      const code = carrierToCode(carrierName)
      if (code == null) return abort(`택배사 미매핑(${carrierName ?? '미선택'})`)
      if (o.shipment_box_id == null) return abort('shipmentBoxId 없음')
      if (o.vendor_item_id == null) return abort('vendorItemId 없음')

      // HARD GATE ① 취소/반품 — DB 1차 + 쿠팡 단건 재조회(fail-closed)
      if (CANCELLED.has(shipUpper)) return abort('주문취소/반품')
      const sheet = await api('GET', `/v2/providers/openapi/apis/api/v4/vendors/${vendorId}/ordersheets/${o.shipment_box_id}`)
      if (sheet.status !== 200) return { ok: false, status: 502, detail: `쿠팡 주문상태 재조회 실패(HTTP ${sheet.status}) — 등록 보류: ${sheet.text.slice(0, 120)}` }
      const d = sheet.json?.data
      const sheetStatus = String((Array.isArray(d) ? d[0]?.status : d?.status) ?? '').toUpperCase()
      if (!sheetStatus) return abort('쿠팡 주문상태 확인 불가(파싱 실패) — 안전상 보류')
      if (CANCELLED.has(sheetStatus)) return abort('주문취소/반품')
      if (INVOICE_ALREADY_ON_COUPANG.has(sheetStatus)) {
        // DB가 낡았고 쿠팡은 이미 배송지시 이후 → 동기화
        const t = now()
        await upd({ coupang_invoice_status: 'manual_done', purchase_status: 'RECEIVED', purchase_received_at: t, shipping_status: sheetStatus, invoice_number: o.invoice_number ?? invoiceNo, delivery_company: o.delivery_company ?? carrierName, shipped_at: o.shipped_at ?? o.ggsan_shipped_at ?? t, last_synced_at: t })
        return { ok: true, status: 200, detail: `쿠팡에 이미 등록됨(${sheetStatus}) — 발송완료 동기화`, invoice_status: 'manual_done' }
      }

      // STEP ① SHIPPED + pending 선커밋(crash-safe)
      const pre = { last_synced_at: now() }
      if (o.purchase_status !== 'SHIPPED' && o.purchase_status !== 'RECEIVED') pre.purchase_status = 'SHIPPED'
      if (invStatus !== 'pending' && invStatus !== 'acknowledged') pre.coupang_invoice_status = 'pending'
      await upd(pre)

      // STEP ② acknowledgement (멱등)
      const ack = await api('PUT', `/v2/providers/openapi/apis/api/v4/vendors/${vendorId}/ordersheets/acknowledgement`, { vendorId, shipmentBoxIds: [Number(o.shipment_box_id)] })
      if (ack.status !== 200 && !ACK_ALREADY_RE.test(ack.text)) {
        await upd({ coupang_invoice_status: 'failed', coupang_invoice_error: `ack HTTP ${ack.status}: ${ack.text.slice(0, 300)}`, coupang_invoice_attempts: (o.coupang_invoice_attempts ?? 0) + 1, last_synced_at: now() })
        log(`${tag} ack HTTP ${ack.status} ${ack.text.slice(0, 200)}`)
        return { ok: false, status: 502, detail: `발주확인 실패 HTTP ${ack.status} ${ack.text.slice(0, 120)}`, invoice_status: 'failed' }
      }
      await upd({ coupang_invoice_status: 'acknowledged', coupang_acknowledged_at: now(), shipping_status: ACK_OR_LATER.has(shipUpper) ? o.shipping_status : 'INSTRUCT', last_synced_at: now() })

      // STEP ③ invoices
      const inv = await api('POST', `/v2/providers/openapi/apis/api/v4/vendors/${vendorId}/orders/invoices`, {
        vendorId,
        orderSheetInvoiceApplyDtos: [{
          shipmentBoxId: Number(o.shipment_box_id), orderId: Number(o.order_id), vendorItemId: Number(o.vendor_item_id),
          deliveryCompanyCode: code, invoiceNumber: invoiceNo, splitShipping: false, preSplitShipped: false, estimatedShippingDate: '',
        }],
      })
      const r = parseInvoicesResult(inv.json, inv.text)
      const t = now()
      const mirror = { purchase_status: 'RECEIVED', coupang_invoice_uploaded_at: t, coupang_invoice_company_code: code, purchase_received_at: t, invoice_number: invoiceNo, delivery_company: carrierName, shipped_at: o.ggsan_shipped_at ?? o.shipped_at ?? t, shipping_status: 'DEPARTURE', last_synced_at: t }
      const name = (o.product_name ?? '').slice(0, 24)

      if (inv.status === 200 && r.succeed === true) {
        await upd({ ...mirror, coupang_invoice_status: 'uploaded', coupang_invoice_error: null })
        await logAction(o.id, `주문#${o.order_id} 송장등록 성공 ${code} ${invoiceNo} [${source}/local] (${name})`, { code, invoice: invoiceNo, source, via: 'local' })
        log(`${tag} uploaded ${code} ${invoiceNo} [${source}]`)
        return { ok: true, status: 200, detail: 'OK', invoice_status: 'uploaded' }
      }
      if (isDuplicateInvoice(r)) {
        await upd({ ...mirror, coupang_invoice_status: 'duplicate', needs_attention: true, attention_reason: '송장중복(6개월/이미등록) — 매칭 확인' })
        await logAction(o.id, `주문#${o.order_id} 송장 중복(기등록) ${invoiceNo} [${source}/local]`, { code, invoice: invoiceNo, source, duplicate: true, via: 'local' })
        log(`${tag} duplicate ${invoiceNo}`)
        return { ok: true, status: 200, detail: '중복 송장 — 기등록으로 간주(확인 필요)', invoice_status: 'duplicate' }
      }
      if (inv.status === 200 && r.succeed === null) {
        await upd({ ...mirror, coupang_invoice_status: 'uploaded', needs_attention: true, attention_reason: '쿠팡 등록응답 형식 미확인 — Wing에서 등록 확인 요망' })
        log(`${tag} 200 but unknown format: ${inv.text.slice(0, 200)}`)
        return { ok: true, status: 200, detail: '등록 응답형식 미확인 — Wing 확인 요망', invoice_status: 'uploaded' }
      }
      const attempts = (o.coupang_invoice_attempts ?? 0) + 1
      const fail = { coupang_invoice_status: 'failed', coupang_invoice_error: `invoices HTTP ${inv.status}: ${inv.text.slice(0, 300)}`, coupang_invoice_attempts: attempts, last_synced_at: now() }
      if (attempts >= MAX_ATTEMPTS) { fail.needs_attention = true; fail.attention_reason = '등록실패(재시도 상한)' }
      await upd(fail)
      log(`${tag} invoices HTTP ${inv.status} ${inv.text.slice(0, 200)}`)
      return { ok: false, status: 502, detail: `송장등록 실패 HTTP ${inv.status} ${(r.message || inv.text).slice(0, 120)}`, invoice_status: 'failed' }
    } catch (e) {
      log(`${tag} error ${e?.message || e}`)
      return { ok: false, status: 502, detail: e?.message || String(e) }
    }
  }

  return { ackByOrderId, registerInvoice, api }
}
