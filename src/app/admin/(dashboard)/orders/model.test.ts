// 실행: npm run test:ts  (tsx --test)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeCoupang, normalizeNaver, normalizeToss, summarize, filterOrders, sortOrders, paginate,
  parseParams, buildHref, legacyRedirectHref, countByPurchase, marketStatusBadge, coupangClaimBadge, hasOpenClaim, coupangClaimTodo, OPEN_CLAIMS_HREF,
  coupangClaimKind, periodActivity,
  type CoupangClaimRow, type CoupangOrderRow, type NaverOrderRow, type TossOrderRow,
} from './model'

const coupangRow = (over: Partial<CoupangOrderRow> = {}): CoupangOrderRow => ({
  id: 'c1', order_id: 1001, order_item_id: 5, seller_product_id: 77, product_name: '멜비유 수분크림', option_name: '150ml',
  shipping_count: 1, order_price: 24500, purchase_status: 'RECEIVED', purchase_ordered_at: null, purchase_unit_cost: 16200,
  purchase_total_cost: 19200, purchase_note: null, shipping_status: 'FINAL_DELIVERY', invoice_number: null, delivery_company: null,
  shipped_at: null, receiver_name: '홍길동', ordered_at: '2026-10-12T03:00:00+00:00',
  raw_payload: { receiver: { postCode: '04524', addr1: '서울', addr2: '1동', safeNumber: '050-1234' } },
  ...over,
})
const naverRow = (over: Partial<NaverOrderRow> = {}): NaverOrderRow => ({
  id: 'n1', product_order_id: '2026101200001', order_id: '20261012A', origin_product_no: 9, product_name: '홍삼스틱', option_name: null,
  quantity: 2, total_payment_amount: 30000, commission_amount: 1650, product_order_status: 'DELIVERED', place_order_status: 'OK',
  order_date: '2026-10-11T01:00:00+00:00', receiver_name: '김네이버', receiver_phone: null, receiver_address: '부산', delivery_company: null,
  tracking_number: null, shipped_at: null, purchase_status: 'RECEIVED', purchase_ordered_at: null, purchase_unit_cost: 10000,
  purchase_total_cost: 23000, supplier_order_no: null, ...over,
})
const tossRow = (over: Partial<TossOrderRow> = {}): TossOrderRow => ({
  id: 't1', order_product_id: 555, order_id: 42, product_name: '골프매트', option_name: null, quantity: 1, price: 20000,
  item_management_code: 'ggsan:12345', order_status: 'PAID', shipping_deadline_at: null, acknowledged_at: null,
  receiver_name: '박토스', receiver_phone: null, receiver_address: '대구', receiver_address_detail: '2층', receiver_zip_code: '41000',
  ordered_at: '2026-10-13T02:00:00+00:00', purchase_status: 'PENDING', purchase_ordered_at: null, purchase_total_cost: null,
  supplier_source: null, supplier_goods_no: null, ggsan_order_no: null, ggsan_order_status: null, ggsan_invoice_number: null,
  ggsan_carrier_name: null, toss_invoice_status: 'none', needs_attention: false, attention_reason: null, ...over,
})

test('쿠팡 정규화: 리스팅 조인 매입처·수수료 요율(화장품스토리 9.6%)·수령인', () => {
  const o = normalizeCoupang(coupangRow(), { source: 'cmtstory', source_goods_no: '1000001', source_detail_url: null })
  assert.equal(o.market, 'coupang')
  assert.equal(o.orderKey, '1001')
  assert.equal(o.supplierSource, 'cmtstory')
  assert.equal(o.supplierUrl, 'https://www.cmtstory.com/goods/goods_view.php?goodsNo=1000001')
  assert.deepEqual(o.fee, { kind: 'rate', rate: 0.096 })
  assert.deepEqual(o.receiver, { name: '홍길동', zip: '04524', address: '서울 1동', phone: '050-1234' })
  assert.equal(o.marketCancelled, false)
})

test('쿠팡 정규화: 주문별 매입처 오버라이드가 리스팅보다 우선, 취소 주문은 집계 제외 플래그', () => {
  const o = normalizeCoupang(
    coupangRow({ supplier_source: 'ggsan', supplier_goods_no: '999', shipping_status: 'CANCEL' }),
    { source: 'cmtstory', source_goods_no: '1', source_detail_url: 'https://x' },
  )
  assert.equal(o.supplierOverridden, true)
  assert.equal(o.supplierSource, 'ggsan')
  assert.equal(o.supplierUrl, 'https://www.ggsan.com/goods/goods_view.php?goodsNo=999')
  assert.equal(o.fee.kind === 'rate' && o.fee.rate, 0.106)
  assert.equal(o.marketCancelled, true)
})

test('네이버 정규화: 수수료는 실값, 반품은 집계 제외', () => {
  const o = normalizeNaver(naverRow({ product_order_status: 'RETURNED' }), { source: 'upickb2b', source_goods_no: 'ab' })
  assert.equal(o.market, 'naver')
  assert.deepEqual(o.fee, { kind: 'amount', amount: 1650 })
  assert.equal(o.marketCancelled, true)
  assert.equal(o.quantity, 2)
  assert.equal(marketStatusBadge(o).label, '반품')
})

test('토스 정규화: item_management_code에서 매입처 파싱, 11% 요율, 주소 합치기, 발송기한 임박 플래그', () => {
  const o = normalizeToss(tossRow())
  assert.equal(o.supplierSource, 'ggsan')
  assert.equal(o.supplierGoodsNo, '12345')
  assert.deepEqual(o.fee, { kind: 'rate', rate: 0.11 })
  assert.equal(o.receiver?.address, '대구 2층')
  assert.equal(marketStatusBadge(o).label, '결제완료')
  assert.equal(o.toss?.deadlineSoon, false)
  const now = Date.parse('2026-10-13T00:00:00Z')
  const soon = normalizeToss(tossRow({ shipping_deadline_at: '2026-10-13T20:00:00Z' }), now)
  assert.equal(soon.toss?.deadlineSoon, true)
  const shipped = normalizeToss(tossRow({ shipping_deadline_at: '2026-10-13T20:00:00Z', order_status: 'DELIVERING' }), now)
  assert.equal(shipped.toss?.deadlineSoon, false) // 이미 발송된 건은 경고 안 함
})

test('통합 집계: 마켓별 수수료 방식이 다르더라도 한 합계로, 취소·반품·매입취소 제외', () => {
  const orders = [
    normalizeCoupang(coupangRow(), { source: 'cmtstory', source_goods_no: '1', source_detail_url: null }), // 24,500 / 19,200 / 9.6%
    normalizeNaver(naverRow()), // 30,000 / 23,000 / 1,650 실값
    normalizeToss(tossRow({ purchase_total_cost: 15000 })), // 20,000 / 15,000 / 11%
    normalizeCoupang(coupangRow({ id: 'c2', purchase_status: 'CANCELLED' })),
    normalizeNaver(naverRow({ id: 'n2', product_order_status: 'CANCELED' })),
  ]
  const { total, byMarket } = summarize(orders)
  assert.equal(total.count, 3)
  assert.equal(total.revenue, 74500)
  assert.equal(total.cost, 57200)
  // 수수료: 2,352(쿠팡 9.6%) + 1,650(네이버 실값) + 2,200(토스 11%)
  assert.equal(total.fee, 2352 + 1650 + 2200)
  // 부가세: (24500−19200)/11=482 + (30000−23000)/11=636 + (20000−15000)/11=455
  assert.equal(total.vat, 482 + 636 + 455)
  assert.equal(total.net, 74500 - 57200 - total.fee - total.vat)
  assert.equal(byMarket.coupang.count, 1)
  assert.equal(byMarket.naver.count, 1)
  assert.equal(byMarket.toss.count, 1)
  assert.equal(byMarket.coupang.net + byMarket.naver.net + byMarket.toss.net, total.net)
  assert.equal(total.costMissing, 0)
})

test('매입원가 미입력은 costMissing으로 세고 원가 0 취급', () => {
  const { total } = summarize([normalizeToss(tossRow())])
  assert.equal(total.costMissing, 1)
  assert.equal(total.cost, 0)
  assert.equal(total.vat, Math.round(20000 / 11))
})

test('필터·정렬·페이지: 매입 상태/검색은 메모리, 정렬은 주문일·결제액', () => {
  const orders = [
    normalizeCoupang(coupangRow()),
    normalizeNaver(naverRow()),
    normalizeToss(tossRow()),
  ]
  assert.deepEqual(filterOrders(orders, { purchase: 'PENDING', q: '' }).map((o) => o.market), ['toss'])
  assert.deepEqual(filterOrders(orders, { purchase: '', q: '홍삼' }).map((o) => o.market), ['naver'])
  assert.deepEqual(sortOrders(orders, 'recent').map((o) => o.market), ['toss', 'coupang', 'naver'])
  assert.deepEqual(sortOrders(orders, 'oldest').map((o) => o.market), ['naver', 'coupang', 'toss'])
  assert.deepEqual(sortOrders(orders, 'price_desc').map((o) => o.market), ['naver', 'coupang', 'toss'])
  const pg = paginate(orders, 2, 2)
  assert.equal(pg.totalPages, 2)
  assert.equal(pg.rows.length, 1)
  assert.equal(paginate(orders, 99, 2).page, 2) // 범위 밖 페이지는 마지막으로
  assert.equal(countByPurchase(orders).get('RECEIVED'), 2)
})

test('파라미터 파싱: 잘못된 값은 기본값, 링크는 기본값 생략', () => {
  const p = parseParams({ market: 'naver', purchase: 'BOGUS', sort: 'price_desc', days: '15', page: '0', q: ' 크림 ' })
  assert.deepEqual(p, { market: 'naver', purchase: '', claim: '', q: '크림', sort: 'price_desc', page: 1, days: 30 })
  assert.equal(buildHref(p), '/admin/orders?market=naver&q=%ED%81%AC%EB%A6%BC&sort=price_desc')
  assert.equal(buildHref(p, { market: null, q: null, sort: 'recent', days: 0, page: 3 }), '/admin/orders?days=0&page=3')
  assert.equal(buildHref(parseParams({})), '/admin/orders')
})

test('옛 마켓별 페이지 → 통합 페이지 리다이렉트는 필터를 보존하고 마켓을 고정', () => {
  assert.equal(legacyRedirectHref('coupang', { purchase: 'PENDING', days: '90' }), '/admin/orders?market=coupang&purchase=PENDING&days=90')
  assert.equal(legacyRedirectHref('toss', {}), '/admin/orders?market=toss')
  assert.equal(legacyRedirectHref('naver', { market: 'coupang' }), '/admin/orders?market=naver')
})

// ─── 쿠팡 반품·취소 요청(출고중지요청 포함) ───
const claimRow = (over: Partial<CoupangClaimRow> = {}): CoupangClaimRow => ({
  receipt_id: 1948340844, order_id: 1001, receipt_type: 'RETURN', receipt_status: 'RETURNS_COMPLETED', release_stop_status: '비대상',
  reason_category1: '고객변심', reason_category2: '단순변심(사유없음)', reason: null, cancel_count: 1, fault_by_type: 'CUSTOMER',
  items: [{ vendorItemId: 555, cancelCount: 1, releaseStatus: 'Y' }], requested_at: '2026-11-08T09:15:12+00:00', completed_at: null,
  ...over,
})

test('쿠팡 반품 완료: 배송완료로 남은 라인도 매출 집계에서 빠지고 반품완료 배지', () => {
  const o = normalizeCoupang(coupangRow({ vendor_item_id: 555 }), null, [claimRow()])
  assert.equal(o.marketStatus, 'FINAL_DELIVERY')
  assert.equal(o.marketCancelled, true)
  assert.deepEqual(o.coupang?.claims.map((c) => [c.label, c.open, c.coversLine]), [['반품완료', false, true]])
  assert.match(o.coupang!.claims[0].title, /접수 11-08 18:15/) // KST 표기
  assert.equal(summarize([o]).total.count, 0)
})

test('쿠팡 출고중지요청: 진행 중 배지·필터 대상, 매출은 유지', () => {
  const o = normalizeCoupang(
    coupangRow({ vendor_item_id: 555, shipping_status: 'INSTRUCT', purchase_status: 'PENDING' }), null,
    [claimRow({ receipt_status: 'RELEASE_STOP_UNCHECKED', release_stop_status: '미처리', items: [{ vendorItemId: 555, cancelCount: 1, releaseStatus: 'N' }] })],
  )
  assert.equal(o.marketCancelled, false)
  assert.equal(o.coupang?.claims[0].label, '🛑 출고중지요청')
  assert.equal(hasOpenClaim(o), true)
  const other = normalizeCoupang(coupangRow({ id: 'c2', order_id: 1002 }))
  assert.deepEqual(filterOrders([o, other], { purchase: '', q: '', claim: 'open' }).map((x) => x.id), ['c1'])
  assert.equal(filterOrders([o, other], { purchase: '', q: '' }).length, 2)
})

test('쿠팡 접수: 같은 주문의 다른 품목엔 안 붙고, 일부 수량만 반품이면 매출 유지', () => {
  const otherItem = normalizeCoupang(coupangRow({ vendor_item_id: 777 }), null, [claimRow()])
  assert.deepEqual(otherItem.coupang?.claims, [])
  assert.equal(otherItem.marketCancelled, false)
  const partial = normalizeCoupang(coupangRow({ vendor_item_id: 555, shipping_count: 3 }), null, [claimRow({ items: [{ vendorItemId: 555, cancelCount: 1, releaseStatus: 'Y' }] })])
  assert.equal(partial.coupang?.claims[0].coversLine, false)
  assert.equal(partial.marketCancelled, false)
})

test('쿠팡 접수 배지: 취소완료·출고중지완료·반품접수 구분', () => {
  assert.equal(coupangClaimBadge({ receipt_type: 'CANCEL', receipt_status: 'RETURNS_COMPLETED', items: [] }).label, '취소완료')
  assert.equal(coupangClaimBadge({ receipt_type: 'RETURN', receipt_status: 'RETURNS_COMPLETED', items: [{ releaseStatus: 'S' }] }).label, '출고중지완료')
  assert.equal(coupangClaimBadge({ receipt_type: 'RETURN', receipt_status: 'RETURNS_COMPLETED', items: [] }).label, '반품완료')
  assert.equal(coupangClaimBadge({ receipt_type: 'RETURN', receipt_status: 'RETURNS_UNCHECKED', items: [{ releaseStatus: 'A' }] }).label, '↩ 반품접수')
})

test('상단 알림 링크 상수 = 반품 진행 필터 링크, 할 일 문구는 매입 상태별', () => {
  assert.equal(OPEN_CLAIMS_HREF, buildHref(parseParams({}), { market: 'coupang', claim: 'open', days: 0 }))
  assert.match(coupangClaimTodo('RELEASE_STOP_UNCHECKED', 'PENDING'), /발주하지 말고/)
  assert.match(coupangClaimTodo('RELEASE_STOP_UNCHECKED', 'ORDERED'), /매입처 주문 취소 후/)
  assert.match(coupangClaimTodo('RELEASE_STOP_UNCHECKED', 'RECEIVED'), /이미출고/)
  assert.match(coupangClaimTodo('RETURNS_UNCHECKED', 'RECEIVED'), /반품 승인/)
})

test('반품 진행 필터는 링크에서 유지된다', () => {
  const p = parseParams({ market: 'coupang', claim: 'open', days: '0' })
  assert.equal(p.claim, 'open')
  assert.equal(buildHref(p, { page: 2 }), '/admin/orders?market=coupang&claim=open&days=0&page=2')
  assert.equal(parseParams({ claim: 'weird' }).claim, '')
})

test('쿠팡 접수 분류: CANCEL=취소, 출고중지요청·출고 전 완료=출고중지, 출고 뒤=반품', () => {
  assert.equal(coupangClaimKind({ receipt_type: 'CANCEL', receipt_status: 'RETURNS_COMPLETED', items: [] }), 'cancel')
  assert.equal(coupangClaimKind({ receipt_type: 'RETURN', receipt_status: 'RELEASE_STOP_UNCHECKED', items: [{ releaseStatus: 'N' }] }), 'stop')
  assert.equal(coupangClaimKind({ receipt_type: 'RETURN', receipt_status: 'RETURNS_COMPLETED', items: [{ releaseStatus: 'S' }] }), 'stop')
  assert.equal(coupangClaimKind({ receipt_type: 'RETURN', receipt_status: 'RETURNS_COMPLETED', items: [{ releaseStatus: 'Y' }] }), 'return')
  // 출고중지요청에 '이미출고'로 답하면 반품 접수로 이어진다
  assert.equal(coupangClaimKind({ receipt_type: 'RETURN', receipt_status: 'RETURNS_UNCHECKED', items: [{ releaseStatus: 'A' }] }), 'return')
})

test('기간 카드: 쿠팡은 접수·문의 테이블, 네이버·토스는 주문 상태로 세고 미처리를 따로 센다', () => {
  const orders = [
    normalizeCoupang(coupangRow({ shipping_status: 'CANCEL' }), null), // 쿠팡 주문 행 취소는 접수와 겹치므로 안 셈
    normalizeCoupang(coupangRow({ id: 'c2' }), null),
    normalizeNaver(naverRow({ product_order_status: 'RETURNED' })),
    normalizeNaver(naverRow({ id: 'n2', product_order_status: 'DELIVERED', claim_status: 'RETURN_REQUEST' })),
    normalizeNaver(naverRow({ id: 'n3', product_order_status: 'CANCELED', claim_status: 'CANCEL_DONE' })),
    normalizeToss(tossRow({ order_status: 'CANCELED_PAYMENT' })),
  ]
  const coupang = {
    claims: [
      { receipt_id: 1, receipt_type: 'RETURN', receipt_status: 'RELEASE_STOP_UNCHECKED', items: [{ releaseStatus: 'N' }] },
      { receipt_id: 2, receipt_type: 'RETURN', receipt_status: 'RETURNS_COMPLETED', items: [{ releaseStatus: 'S' }] },
      { receipt_id: 3, receipt_type: 'RETURN', receipt_status: 'RETURNS_UNCHECKED', items: [{ releaseStatus: 'Y' }] },
      { receipt_id: 4, receipt_type: 'CANCEL', receipt_status: 'RETURNS_COMPLETED', items: [] },
    ],
    inquiries: [{ kind: 'online', needs_answer: true }, { kind: 'callcenter', needs_answer: false }, { kind: 'online', needs_answer: null }],
  }
  const a = periodActivity(orders, coupang)
  assert.equal(a.coupang, 'ok')
  assert.equal(a.orders, 6)
  assert.deepEqual(a.stop, { total: 2, open: 1 })
  assert.deepEqual(a.returns, { total: 3, open: 2 }) // 쿠팡 반품접수 1 + 네이버 반품완료 1 + 네이버 반품요청 1(진행)
  assert.deepEqual(a.cancels, { total: 3, open: 0 }) // 쿠팡 취소 1 + 네이버 취소 1 + 토스 결제취소 1
  assert.deepEqual(a.inquiries, { total: 3, open: 1 })

  const naverOnly = periodActivity(orders.filter((o) => o.market === 'naver'), undefined)
  assert.equal(naverOnly.coupang, 'na')
  assert.deepEqual(naverOnly.stop, { total: 0, open: 0 })
  assert.deepEqual(naverOnly.returns, { total: 2, open: 1 })
  assert.equal(periodActivity([], null).coupang, 'error')
})
