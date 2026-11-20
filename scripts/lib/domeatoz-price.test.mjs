// node --test scripts/lib/domeatoz-price.test.mjs — 도매아토즈 가격 규칙(사장님 2026-11-20: 최소 순마진 10% · 시세 모르면 15% · 시세 있으면 최저가 −1,000원)
import test from 'node:test'
import assert from 'node:assert/strict'
import { decide, decideNoMarket, floorPrice, targetPrice, costOf, COUPANG_FEE } from './domeatoz-price.mjs'
import { netProfit } from './campingmoon-price.mjs'

const margin = (price, cost) => netProfit(price, cost, COUPANG_FEE) / price

test('하한 = 순마진 10%(또는 순이익 2,000원), 시세 모를 때 = 15%', () => {
  const cost = costOf(20250, 3000) // 일화 맥콜 350ml 24캔
  assert.ok(margin(floorPrice(cost), cost) >= 0.0995)
  assert.ok(margin(targetPrice(cost), cost) >= 0.1495)
  const cheap = costOf(3000, 3000) // 작은 원가는 2,000원 쪽이 더 큼
  assert.ok(netProfit(floorPrice(cheap), cheap, COUPANG_FEE) >= 1995)
})

test('시세 있음 — 최저가 −1,000원, 10% 상한 없음', () => {
  const d = decide(17730, 3000, [34800]) // 복음자리 딸기잼 350g x 2: 쿠팡 최저 34,800
  assert.equal(d.verdict, 'OK')
  assert.equal(d.price, 33800)
  assert.ok(d.margin > 0.2)
})

test('1,000원을 못 깎으면 최저가 −1%, 그것도 하한 밑이면 STRUCTURAL', () => {
  const cost = costOf(10000, 3000), floor = floorPrice(cost)
  const low = floor + 500 // −1,000원은 하한 밑, −1%는 하한 위
  const d = decide(10000, 3000, [low])
  assert.equal(d.verdict, 'OK')
  assert.ok(d.price >= floor && d.price < low)
  assert.equal(decide(10000, 3000, [floor - 100]).verdict, 'STRUCTURAL')
})

test('decideNoMarket — 시세 없음 15% · STRUCTURAL 하한 10% · OK 그대로', () => {
  const none = decideNoMarket(20250, 3000, [])
  assert.equal(none.verdict, 'TARGET'); assert.equal(none.basis, 'no-market')
  assert.ok(none.margin >= 0.149)
  const st = decideNoMarket(10000, 3000, [5000])
  assert.equal(st.verdict, 'TARGET'); assert.equal(st.basis, 'floor')
  assert.equal(st.price, st.floor)
  const ok = decideNoMarket(17730, 3000, [34800])
  assert.equal(ok.verdict, 'OK'); assert.equal(ok.price, 33800)
  assert.equal(decideNoMarket(0, 3000, []).verdict, 'NO_COST')
})
