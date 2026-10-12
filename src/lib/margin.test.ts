// 실행: npm run test:ts  (tsx --test)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { netVat, netProfit, VAT_DIVISOR } from './margin'
import { feeRateFor, coupangFee, FEE_RATE } from './coupang/fee'

test('부가세는 (결제금액 − 매입원가) ÷ 11 — 매입세액 공제 반영', () => {
  // 멜비유 수분크림 실주문(2026-10-12): 결제 24,500 / 매입 16,200 + 배송 3,000
  assert.equal(netVat(24500, 19200), Math.round(5300 / VAT_DIVISOR)) // 482
  assert.equal(netVat(24500, 19200), 482)
})

test('매입원가가 결제액보다 크면 부가세 0 (환급은 0으로 취급)', () => {
  assert.equal(netVat(5000, 9000), 0)
})

test('매입원가 미입력(null)은 0 취급 → 결제액 전액 기준 부가세', () => {
  assert.equal(netVat(11000, null), 1000)
  assert.equal(netVat(11000, undefined), 1000)
})

test('화장품스토리 주문은 9.6% 수수료 + 순부가세로 순마진 ≈ 10% (가격 산정기 설계와 일치)', () => {
  const rev = 24500, cost = 19200
  const fee = coupangFee(rev, 'cmtstory')
  assert.equal(fee, 2352)
  const p = netProfit(rev, cost, fee)
  assert.equal(p.vat, 482)
  assert.equal(p.net, 24500 - 19200 - 2352 - 482) // 2,466
  assert.ok(p.netPct >= 10 && p.netPct < 10.2, `netPct=${p.netPct}`)
})

test('매입처 미등록은 기본 10.6%', () => {
  assert.equal(feeRateFor('ggsan'), FEE_RATE)
  assert.equal(feeRateFor(null), FEE_RATE)
  assert.equal(feeRateFor(undefined), FEE_RATE)
  assert.equal(feeRateFor('cmtstory'), 0.096)
})

test('옛 공식(결제액÷11, 10.6%)은 같은 주문을 약 2%로 과소 표시했다 — 회귀 방지 기준값', () => {
  const rev = 24500, cost = 19200
  const oldNet = rev - cost - Math.round(rev * 0.106) - Math.round(rev / 11)
  assert.equal(oldNet, 476)
  const p = netProfit(rev, cost, coupangFee(rev, 'cmtstory'))
  assert.ok(p.net - oldNet > 1900)
})

test('revenue 0이면 netPct 0 (0 나누기 방지)', () => {
  const p = netProfit(0, 0, 0)
  assert.equal(p.netPct, 0)
  assert.equal(p.net, 0)
})
