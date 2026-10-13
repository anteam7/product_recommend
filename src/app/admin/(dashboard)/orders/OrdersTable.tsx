import { CostCell } from './CostCell'
import { PurchaseStatusCell as CoupangPurchaseStatusCell } from './coupang/PurchaseStatusCell'
import { InvoiceCell as CoupangInvoiceCell } from './coupang/InvoiceCell'
import { GgsanTrackingCell } from './coupang/GgsanTrackingCell'
import { DepositInfo } from './coupang/DepositInfo'
import PurchaseButton from './coupang/PurchaseButton'
import { PurchaseStatusCell as NaverPurchaseStatusCell } from './naver/PurchaseStatusCell'
import { InvoiceCell as NaverInvoiceCell } from './naver/InvoiceCell'
import { PurchaseCell as TossPurchaseCell } from './toss/PurchaseCell'
import {
  MARKET_META, PURCHASE_AUTOMATED_SOURCES, SUPPLIER_LABELS, marketStatusBadge, fmt, fmtDate,
  type Market, type UnifiedOrder,
} from './model'

/** 마켓별 매입 기록 API — CostCell(매입가) 공통 body: { id, purchase_unit_cost, purchase_total_cost } */
const UPDATE_ENDPOINT: Record<Market, string> = {
  coupang: '/api/admin/coupang-orders/update',
  naver: '/api/admin/naver-orders/update',
  toss: '/api/admin/toss-orders/update',
}
// 💳 결제진행(자동주문) 버튼을 그릴 매입처 — order-server.mjs 가 마켓별로 지원하는 범위(통합 전 각 페이지와 동일).
// 쿠팡은 SUPPORTED_SOURCES 전부, 네이버·토스는 건강산/유픽B2B 만 검증됨.
const AUTOMATED_SOURCES: Record<Market, readonly string[]> = {
  coupang: PURCHASE_AUTOMATED_SOURCES,
  naver: ['ggsan', 'upickb2b'],
  toss: ['ggsan', 'upickb2b'],
}
export function OrdersTable({ rows, emptyText }: { rows: UnifiedOrder[]; emptyText: string }) {
  return (
    <div className="overflow-x-auto bg-white border rounded">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-gray-600 text-xs">
          <tr>
            <th className="px-3 py-2 text-left font-semibold whitespace-nowrap">마켓 · 주문일</th>
            <th className="px-3 py-2 text-left font-semibold w-[26%]">상품 / 옵션</th>
            <th className="px-3 py-2 text-center font-semibold">수량</th>
            <th className="px-3 py-2 text-right font-semibold">결제금액</th>
            <th className="px-3 py-2 text-right font-semibold">매입가</th>
            <th className="px-3 py-2 text-center font-semibold">매입 상태</th>
            <th className="px-3 py-2 text-center font-semibold">마켓 상태</th>
            <th className="px-3 py-2 text-left font-semibold">매입처 추적</th>
            <th className="px-3 py-2 text-left font-semibold">송장</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={9} className="px-3 py-12 text-center text-gray-400 text-sm">{emptyText}</td>
            </tr>
          )}
          {rows.map((o) => {
            const meta = MARKET_META[o.market]
            const ms = marketStatusBadge(o)
            const supplierName = SUPPLIER_LABELS[o.supplierSource ?? ''] ?? o.supplierSource ?? '매입처'
            const canAutoPurchase = o.purchaseStatus === 'PENDING' && !!o.supplierGoodsNo && AUTOMATED_SOURCES[o.market].includes(o.supplierSource ?? '')
            const purchaseQty = o.quantity * o.bundleSize
            return (
              <tr key={`${o.market}:${o.id}`} className={`border-t align-top ${meta.rowHover}`}>
                {/* 마켓 · 주문일 */}
                <td className="px-3 py-2 whitespace-nowrap">
                  <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-semibold ${meta.badgeCls}`}>
                    {meta.icon} {meta.label}
                  </span>
                  <div className="text-[11px] text-gray-500 mt-1 tabular-nums">{fmtDate(o.orderedAt)}</div>
                </td>

                {/* 상품 / 옵션 */}
                <td className="px-3 py-2">
                  <div className="font-medium text-gray-900 line-clamp-2">{o.productName}</div>
                  {o.optionName && <div className="text-[11px] text-gray-500 mt-0.5">{o.optionName}</div>}
                  <div className="text-[10px] text-gray-400 mt-0.5 flex items-center gap-2 flex-wrap">
                    <span>{o.orderLabel}</span>
                    {o.supplierUrl && (
                      <a
                        href={o.supplierUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-semibold hover:bg-amber-200"
                        title={`매입처(${supplierName}) 상세페이지에서 매입${o.supplierOverridden ? ' — 이 주문만 매입처 변경(리스팅 매칭과 다름)' : ''}`}
                      >
                        🛒 {supplierName} 매입{o.supplierGoodsNo ? ` ${o.supplierGoodsNo}` : ''}{o.supplierOverridden ? ' ·주문별' : ''} →
                      </a>
                    )}
                  </div>
                  {o.receiver && (
                    <div className="text-[11px] text-gray-600 mt-1">
                      📦 <span className="font-medium text-gray-800">{o.receiver.name ?? '-'}</span>
                      {o.receiver.zip ? <span className="text-gray-400"> ({o.receiver.zip})</span> : null}
                      {o.receiver.address ? <span> · {o.receiver.address}</span> : null}
                      {o.receiver.phone ? <span className="text-gray-400"> · {o.receiver.phone}</span> : null}
                    </div>
                  )}
                  {canAutoPurchase && (
                    <div className="mt-1">
                      <PurchaseButton orderId={o.orderKey} source={o.supplierSource} />
                      <span className="text-[10px] text-gray-400 ml-1">헬퍼 꺼져 있으면 자동 기동</span>
                    </div>
                  )}
                  {/* 77bio 가상계좌(주문마다 새 번호)는 행에서 바로 보여야 [✓입금완료] 처리가 가능. 일반 메모는 한 줄로. */}
                  {o.purchaseNote && <DepositInfo note={o.purchaseNote} awaiting={o.purchaseStatus === 'AWAITING_DEPOSIT'} />}
                </td>

                {/* 수량 */}
                <td className="px-3 py-2 text-center tabular-nums">
                  {o.quantity}
                  {o.bundleSize > 1 && (
                    <div className="text-[11px] font-semibold text-amber-700 whitespace-nowrap" title="묶음 옵션 — 매입처에서는 주문 수량 × 묶음 수만큼 산다">
                      매입 {purchaseQty}개
                      <div className="font-normal text-gray-500">{o.bundleSize}개 묶음</div>
                    </div>
                  )}
                </td>

                {/* 결제금액 */}
                <td className="px-3 py-2 text-right tabular-nums font-semibold">{fmt(o.revenue)}</td>

                {/* 매입가 */}
                <td className="px-3 py-2 text-right">
                  <CostCell
                    endpoint={UPDATE_ENDPOINT[o.market]}
                    id={o.id}
                    unitCost={o.purchaseUnitCost}
                    totalCost={o.purchaseTotalCost}
                    quantity={o.quantity}
                    revenue={o.revenue}
                    fee={o.fee}
                  />
                </td>

                {/* 매입 상태 — 마켓별 셀(각자 update API·후속 잡이 다름) */}
                <td className="px-3 py-2 text-center">
                  {o.market === 'coupang' && o.coupang && (
                    <CoupangPurchaseStatusCell id={o.id} orderId={o.orderKey} status={o.purchaseStatus} orderedAt={o.purchaseOrderedAt} ggsanOrderNo={o.coupang.ggsanOrderNo} />
                  )}
                  {o.market === 'naver' && o.naver && (
                    <NaverPurchaseStatusCell id={o.id} status={o.purchaseStatus} orderedAt={o.purchaseOrderedAt} supplierOrderNo={o.naver.supplierOrderNo} />
                  )}
                  {o.market === 'toss' && o.toss && (
                    <TossPurchaseCell id={o.id} status={o.purchaseStatus} orderedAt={o.purchaseOrderedAt} ggsanOrderNo={o.toss.ggsanOrderNo} needsAttention={o.needsAttention} attentionReason={o.attentionReason} />
                  )}
                </td>

                {/* 마켓 상태 */}
                <td className="px-3 py-2 text-center">
                  <div className="flex flex-col items-center gap-1">
                    <span className={`inline-block px-2 py-0.5 rounded text-xs ${ms.cls}`}>{ms.label}</span>
                    {o.market === 'naver' && o.naver && (
                      <>
                        {o.marketStatus === 'PAYED' && o.naver.placeOrderStatus !== 'OK' ? (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 font-semibold" title="발주확인 전 — 매입 상태를 '발주완료'로 바꾸면 자동으로 발주확인됩니다">⚠ 발주확인 필요</span>
                        ) : o.naver.placeOrderStatus === 'OK' ? (
                          <span className="text-[10px] text-emerald-600">✓ 발주확인</span>
                        ) : null}
                        {o.naver.claimStatus && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-100 text-rose-700" title="네이버 클레임(취소·반품·교환) 진행 상태">클레임 {o.naver.claimStatus}</span>
                        )}
                        {o.needsAttention && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-semibold" title={o.attentionReason ?? ''}>⚠ 확인 필요{o.attentionReason ? `: ${o.attentionReason.slice(0, 40)}` : ''}</span>
                        )}
                      </>
                    )}
                    {o.market === 'toss' && o.toss && (
                      <>
                        {o.toss.acknowledgedAt && <span className="text-[10px] text-gray-400">발주확인 {fmtDate(o.toss.acknowledgedAt)}</span>}
                        {o.toss.shippingDeadlineAt && (
                          <span className={`text-[10px] tabular-nums ${o.toss.deadlineSoon ? 'text-rose-600 font-bold' : 'text-gray-500'}`} title="발송기한(영업일) 초과는 토스 페널티 — ⚠ 표시가 뜨면 우선 처리">
                            기한 {o.toss.shippingDeadlineAt}{o.toss.deadlineSoon ? ' ⚠' : ''}
                          </span>
                        )}
                      </>
                    )}
                  </div>
                </td>

                {/* 매입처 추적 */}
                <td className="px-3 py-2 text-xs">
                  {o.market === 'coupang' && o.coupang && (
                    <GgsanTrackingCell
                      id={o.id}
                      orderId={o.orderKey}
                      ggsanOrderNo={o.coupang.ggsanOrderNo}
                      ggsanOrderStatus={o.coupang.ggsanOrderStatus}
                      ggsanInvoiceNumber={o.coupang.ggsanInvoiceNumber}
                      ggsanCarrierName={o.coupang.ggsanCarrierName}
                      ggsanShippedAt={o.coupang.ggsanShippedAt}
                      coupangInvoiceStatus={o.coupang.coupangInvoiceStatus}
                      needsAttention={o.needsAttention}
                      attentionReason={o.attentionReason}
                    />
                  )}
                  {o.market === 'naver' && o.naver && (
                    o.naver.supplierOrderStatus
                      ? <span className="text-gray-600" title="매입처 주문상세 상태(매시 크론이 확인)">매입처: {o.naver.supplierOrderStatus}</span>
                      : <span className="text-gray-300">–</span>
                  )}
                  {o.market === 'toss' && o.toss && (
                    o.toss.ggsanOrderStatus
                      ? <span className="text-gray-600" title="매입처 주문상세 상태(매시 크론이 확인)">매입처: {o.toss.ggsanOrderStatus}</span>
                      : <span className="text-gray-300">–</span>
                  )}
                </td>

                {/* 송장 */}
                <td className="px-3 py-2 text-xs">
                  {o.market === 'coupang' && o.coupang && (
                    <CoupangInvoiceCell
                      id={o.id}
                      orderId={o.orderKey}
                      invoiceNumber={o.coupang.invoiceNumber}
                      deliveryCompany={o.coupang.deliveryCompany}
                      shippedAt={o.coupang.shippedAt}
                      coupangInvoiceStatus={o.coupang.coupangInvoiceStatus}
                    />
                  )}
                  {o.market === 'naver' && o.naver && (
                    <NaverInvoiceCell
                      id={o.id}
                      trackingNumber={o.naver.trackingNumber}
                      deliveryCompany={o.naver.deliveryCompany}
                      shippedAt={o.naver.shippedAt}
                      dispatchStatus={o.naver.dispatchStatus}
                      dispatchError={o.naver.dispatchError}
                      supplierInvoice={o.naver.supplierInvoiceNumber}
                    />
                  )}
                  {o.market === 'toss' && o.toss && (
                    o.toss.ggsanInvoiceNumber ? (
                      <div className="text-gray-600">
                        {o.toss.ggsanCarrierName ?? '?'} {o.toss.ggsanInvoiceNumber}{' '}
                        {o.toss.tossInvoiceStatus === 'registered' ? <span className="text-emerald-600">✓토스등록</span>
                          : o.toss.tossInvoiceStatus === 'failed' ? <span className="text-rose-600">✗등록실패</span>
                          : <span className="text-amber-600">등록대기</span>}
                      </div>
                    ) : <span className="text-gray-300">–</span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
