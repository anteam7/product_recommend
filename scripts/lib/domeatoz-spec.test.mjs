// node --test scripts/lib/domeatoz-spec.test.mjs — 도매아토즈 규격 해석(삼일유통 표기 + 2026-11-20 다른 공급사 표기)
import test from 'node:test'
import assert from 'node:assert/strict'
import { specOf, purchaseSpecOf, titleMatches, ambiguousPack } from './domeatoz-spec.mjs'

const tot = (n) => specOf(n).total
const cnt = (n) => specOf(n).count

test('삼일유통 표기 — 괄호는 내역이라 곱하지 않는다', () => {
  assert.equal(tot('맥심 커피 10g x 45T (15개입x3개)'), 450)
  assert.equal(tot('보노 체다치즈 스프 63g(3개입) x 3박스'), 189)
  assert.equal(tot('칭따오 355mlx48캔'), 355 * 48)
  assert.equal(tot('초코하임 142g 5개'), 710)
  assert.equal(tot('백제 멸치 쌀국수 100g x 10 x 2'), 2000)
  assert.equal(specOf('딸기 192g + 사과 192g 각2개').set, true)
})

test('다른 공급사 표기 — 대문자 X 곱하기', () => {
  assert.equal(cnt('동일 달콤우유맛 스틱 15스틱 X2'), 30)
  assert.equal(tot('삼립 하이면 신포차우동 얼큰한맛 424g X 5개'), 2120)
  assert.equal(tot('땅콩분태(차오름 1kg)X15'), 15000)
  // 치수·영문 단어·영문 단위는 수량 아님
  assert.equal(cnt('세모네모 POP꽂이 170X70mm'), 1)
  assert.equal(cnt('루젠 BMW X5 차박커튼'), 1)
  assert.equal(cnt('의류용핸들 100mm X 10m'), 1)
  assert.equal(cnt('MAX2 젤리'), 1)
  assert.equal(cnt('어떤 상품 12 X 3'), 1) // 단위 없는 숫자 뒤 X 는 수량으로 안 읽음(모호)
})

test('다른 공급사 표기 — 1BOX (N개입) · 용량 (N캔/페트/병/팩)', () => {
  assert.equal(tot('광동제약 비타500 젤리 48g 1BOX (50개입)'), 2400)
  assert.equal(cnt('동일 달콤우유맛 스틱 15스틱 1BOX (20개입)'), 300)
  assert.equal(tot('해태음료 갈아만든배 340ml (24캔)'), 340 * 24)
  assert.equal(tot('아카페라 올데이 아메리카노 1000ml (6페트)'), 6000)
  assert.equal(tot('웰그린 레몬녹차 340ml (20페트) x 2박스'), 340 * 40)
  // 스틱·봉·포·개입은 개당/전체를 모르므로 괄호 안을 곱하지 않는다(대신 ambiguousPack 으로 보류)
  assert.equal(tot('어떤 차 15g (10스틱)'), 15)
})

test('ambiguousPack — 용량 바로 뒤 (N개입)만', () => {
  assert.equal(ambiguousPack('허쉬 초코바 43g (24개입)'), true)
  assert.equal(ambiguousPack('보노 체다치즈 스프 63g(3개입) x 3박스'), true)
  assert.equal(ambiguousPack('광동제약 비타500 젤리 48g 1BOX (50개입)'), false)
  assert.equal(ambiguousPack('해태음료 갈아만든배 340ml (24캔)'), false)
})

test('purchaseSpecOf · titleMatches — 수량이 다르면 다른 상품', () => {
  assert.deepEqual(purchaseSpecOf('해태음료 갈아만든배 340ml (24캔)'), { mode: 'piece', weightG: null, volumeMl: 340, pieces: 24, perPack: 24, packs: 1 })
  const ours = '동일 달콤우유맛 스틱 15스틱 X2'
  assert.equal(titleMatches(ours, specOf(ours), '동일 달콤우유맛 스틱 15스틱 1BOX (20개입)'), false)
  assert.equal(titleMatches(ours, specOf(ours), '동일 달콤우유맛 스틱 15스틱 X2'), true)
  const can = '해태음료 갈아만든배 340ml (24캔)'
  assert.equal(titleMatches(can, specOf(can), '해태 갈아만든배 포도봉봉 340ml 2종  세트'), false)
  assert.equal(titleMatches(can, specOf(can), '해태 갈아만든배 340ml, 24개'), true)
})
