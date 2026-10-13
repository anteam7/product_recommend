// 실행: npm run test:ts  (tsx --test)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeCoupang, normalizeNaver, normalizeToss, summarize, filterOrders, sortOrders, paginate,
  parseParams, buildHref, legacyRedirectHref, countByPurchase, marketStatusBadge,
  type CoupangOrderRow, type NaverOrderRow, type TossOrderRow,
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
  assert.deepEqual(p, { market: 'naver', purchase: '', q: '크림', sort: 'price_desc', page: 1, days: 30 })
  assert.equal(buildHref(p), '/admin/orders?market=naver&q=%ED%81%AC%EB%A6%BC&sort=price_desc')
  assert.equal(buildHref(p, { market: null, q: null, sort: 'recent', days: 0, page: 3 }), '/admin/orders?days=0&page=3')
  assert.equal(buildHref(parseParams({})), '/admin/orders')
})

test('옛 마켓별 페이지 → 통합 페이지 리다이렉트는 필터를 보존하고 마켓을 고정', () => {
  assert.equal(legacyRedirectHref('coupang', { purchase: 'PENDING', days: '90' }), '/admin/orders?market=coupang&purchase=PENDING&days=90')
  assert.equal(legacyRedirectHref('toss', {}), '/admin/orders?market=toss')
  assert.equal(legacyRedirectHref('naver', { market: 'coupang' }), '/admin/orders?market=naver')
})
