// 실행: npm run test:ts  (tsx --test)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePurchaseNote } from './depositNote'

test('캠핑문 적립금 + 무통장 — 실제 입금액은 무통장 금액, 예금주 괄호 포함', () => {
  const p = parsePurchaseNote('[적립금] 26,000원 사용 / [무통장] 우리은행 1002000000001 (예금주 (주)매입처) 3,000원 입금')
  assert.equal(p.mileageUsed, 26000)
  assert.deepEqual(p.deposit, { kind: 'cash', bank: '우리은행', account: '1002000000001', holder: '(주)매입처', amount: 3000, deadline: null })
  assert.deepEqual(p.rest, [])
})

test('무통장만(건강산) — 앞에 다른 메모가 붙어도 읽는다', () => {
  const p = parsePurchaseNote('매입처 변경: ggsan → upickb2b / [무통장] 국민은행 66040000000002 (예금주 주식회사 매입처) 19,000원 입금')
  assert.equal(p.mileageUsed, null)
  assert.equal(p.deposit?.amount, 19000)
  assert.equal(p.deposit?.holder, '주식회사 매입처')
  assert.deepEqual(p.rest, ['매입처 변경: ggsan → upickb2b'])
})

test('은행명 없는 무통장', () => {
  const p = parsePurchaseNote('[무통장]  1002000000001 3,000원 입금')
  assert.deepEqual(p.deposit, { kind: 'cash', bank: '', account: '1002000000001', holder: null, amount: 3000, deadline: null })
})

test('77바이오 가상계좌 — 기한 포함', () => {
  const p = parsePurchaseNote('[가상계좌] 기업은행 07500000000003 (예금주 가상계좌예금주) 14,300원을 2026-09-18 까지 입금')
  assert.deepEqual(p.deposit, { kind: 'virtual', bank: '기업은행', account: '07500000000003', holder: '가상계좌예금주', amount: 14300, deadline: '2026-09-18' })
  assert.equal(parsePurchaseNote('[가상계좌] 기업은행 07500000000003 (예금주 (주)매입처) 14,300원을 2026-09-18 까지 입금').deposit?.holder, '(주)매입처')
})

test('결제 기록이 아닌 메모·적립금 전액 결제는 그대로 남긴다', () => {
  const p = parsePurchaseNote('[적립금] 29,000원 결제완료 · 잔액 약 550원')
  assert.equal(p.deposit, null)
  assert.equal(p.mileageUsed, null)
  assert.deepEqual(p.rest, ['[적립금] 29,000원 결제완료 · 잔액 약 550원'])
  assert.deepEqual(parsePurchaseNote(null), { deposit: null, mileageUsed: null, rest: [] })
})
