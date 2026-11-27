// node --test scripts/lib/domeatoz-spec.test.mjs — 도매아토즈 규격 해석(삼일유통 표기 + 2026-11-20 다른 공급사 표기)
import test from 'node:test'
import assert from 'node:assert/strict'
import { specOf, purchaseSpecOf, titleMatches, ambiguousPack, hiddenPack } from './domeatoz-spec.mjs'

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

test('manualSpecOf — 사람 입력 규격(관리자 화면)', async () => {
  const { manualSpecOf } = await import('./domeatoz-spec.mjs')
  assert.deepEqual(manualSpecOf({ unit: 'g', per: 1.2, pieces: 400 }), { mode: 'piece', weightG: 1.2, volumeMl: null, pieces: 400, perPack: 400, packs: 1 })
  assert.deepEqual(manualSpecOf({ unit: 'ml', per: 500, pieces: 1 }), { mode: 'single', weightG: null, volumeMl: 500, packs: 1 })
  assert.deepEqual(manualSpecOf({ pieces: 50 }), { mode: 'count', weightG: null, volumeMl: null, pieces: 50 })
  assert.equal(manualSpecOf({ attrs: { 가공식품맛: '오리지널' } }), null) // 옵션 값만 → 규격은 이름에서
  assert.equal(manualSpecOf(null), null)
  assert.equal(manualSpecOf({ unit: 'kg', per: 1, pieces: 2 }).mode, 'count') // 단위 이상 → 개수만
})

test('buildPurchaseOptions extra — 사람이 넣은 필수 구매옵션 값', async () => {
  const { buildPurchaseOptions } = await import('./coupang-purchase-options.mjs')
  const attrs = [
    { attributeTypeName: '개당 중량', required: 'MANDATORY', groupNumber: '1', usableUnits: ['g', 'kg'] },
    { attributeTypeName: '수량', required: 'MANDATORY', groupNumber: 'NONE', usableUnits: ['개'] },
    { attributeTypeName: '가공식품맛', required: 'MANDATORY', groupNumber: 'NONE' },
  ]
  const spec = { mode: 'piece', weightG: 45, volumeMl: null, pieces: 15, perPack: 15, packs: 1 }
  assert.match(buildPurchaseOptions(attrs, spec, 1).error, /가공식품맛/)
  const ok = buildPurchaseOptions(attrs, spec, 1, { extra: { 가공식품맛: '오리지널' } })
  assert.equal(ok.error, undefined)
  assert.deepEqual(ok.attributes.find((a) => a.attributeTypeName === '가공식품맛'), { attributeTypeName: '가공식품맛', attributeValueName: '오리지널', exposed: 'EXPOSED' })
})

test('titleMatches — 브랜드가 다르면 다른 상품(2026-11-20 꽃샘↔담터 오매칭)', () => {
  const ours = '꽃샘 생강차플러스 30T(15T x 2개)'
  assert.equal(titleMatches(ours, specOf(ours), '담터 생강차플러스, 30g, 30개'), false)
  assert.equal(titleMatches(ours, specOf(ours), '꽃샘 생강차플러스 30T 생강음료'), true)
  // 회사명 ↔ 브랜드명(앞 2글자)·영문 브랜드
  const cj = 'CJ제일제당 햇반 210g X 12개'
  assert.equal(titleMatches(cj, specOf(cj), 'CJ 햇반 백미밥, 210g, 12개'), true)
  assert.equal(titleMatches(cj, specOf(cj), '오뚜기 맛있는 오뚜기밥 햇반 210g, 12개'), false)
  const gd = '광동제약 옥수수수염차 1.5L (12페트)'
  assert.equal(titleMatches(gd, specOf(gd), '광동 옥수수수염차, 1.5L, 12개'), true)
})

test('titleMatches — 회사명이 빠진 쿠팡 제목은 단어 2개 이상이면 통과', () => {
  const lt = '롯데 레쓰비 마일드 240ml x 60캔'
  assert.equal(titleMatches(lt, specOf(lt), '레쓰비 마일드 커피, 240ml, 60개'), true)
  const dy = '동일 생강차 50T'
  assert.equal(titleMatches(dy, specOf(dy), '자연생각 대추 생강차, 18g, 50개입, 1개'), false)
})

test('hiddenPack · titleMatches — 박스·묶음 수량이 숨은 쿠팡 제목은 다른 상품(2026-11-27 생강한차 50스틱 127,410원 사고)', () => {
  const m = (ours, title) => titleMatches(ours, specOf(ours), title)
  // ① 괄호 안 수량이 내역이 아님
  assert.equal(m('고향 생강한차 50스틱', '생강한차 (8개입) 50스틱 1BOX 고향'), false)
  assert.equal(m('누텔라 370g 초콜릿 초코잼', '누텔라 370g (1박스-15개) 초콜릿 초코잼'), false)
  assert.equal(m('광야식품 시리얼귀리 안동 참마차 60스틱', '60스틱 (4개입) 광야식품 시리얼귀리 안동 1BOX 참마차'), false)
  // ② 용량 앞의 수량
  assert.equal(m('이엔푸드 시찌미 향신료조제품 240g 시치미 후리가케', '후리가께 주먹밥재료 후리가케 일본시치미 이엔푸드 시찌미 15개 X 240g 향신료조제품'), false)
  assert.equal(m('리고 딸기시럽 585g 과일시럽 빙수재료 카페 토핑시럽', '6개 카페 X 토핑시럽 음료시럽 딸기라떼 딸기시럽 리고 빙수재료 요거트 585g 과일시럽'), false)
  // ③ 원플러스원
  assert.equal(m('꽃샘 꿀사과차 1kg', '1kg 꽃샘 원플러스원) 꿀사과차 (무배 /'), false)
  // 농도가 다른 용량 없는 제목은 다른 상품, 용량 없는 같은 상품 제목은 개수로 통과
  assert.equal(m('오뚜기 양조식초 500ml x 6개', '호기마트 오뚜기2배현미식초6개 양조식초'), false)
  assert.equal(m('빙그레 야채타임 70g X 12개', '호기마트 야채타임12개 빙그레스낵'), true)
  // 내역·환산 괄호, 쉼표 칸 수량, 같은 제목은 그대로 통과
  assert.equal(m('젖병모양 젤리빈스 800g 알록달록 젤리빈', '젖병모양  젤리빈스 800g (40gx20개) 알록달록 젤리빈'), true)
  assert.equal(m('하인즈 핫도그 렐리쉬 375ml X 2개', 'Heinz 하인즈 핫도그 렐리쉬 소스 12.7 fl oz(375ml) x 2팩'), true)
  assert.equal(m('움트리 프리미엄 강겨자 410g X 6개 식당 냉면겨자', '움트리 프리미엄 강겨자 410g X 6개 식당 냉면겨자'), true)
  assert.equal(m('청솔 자판기용 쑥차 900g 1BOX (12개입)', '청솔 자판기용 쑥차 900g 12개입 1BOX 음료 분말 차 머신 재료'), true)
  assert.equal(m('웰그린 복숭아녹차 340ml (20페트) x 2박스', '웰그린 복숭아녹차 340ml (20페트) x 2박스 shn62177Jv'), true)
  assert.equal(m('짱구 21곡 초코바 15g x 15개', '[하루셀렉] 초코스낵바 21곡초코바 짱구 21곡 초코바 15g 15개입'), true)
  assert.equal(hiddenPack('삼양 불닭볶음면, 2개, 140g'), false) // 용량 앞 쉼표 칸 수량은 specOf 가 이미 곱함
  assert.equal(hiddenPack('동일 달콤우유맛 스틱 15T (15개입)'), false)
  // 앞에서 같은 수량을 한 번 더 쓴 제목은 통과
  assert.equal(m('오뚜기 사과식초 360ml x 5개', '[몰고랑] 사과식초5개 오뚜기사과식초 사과식초 360ml x 5개'), true)
})

test('titleMatches — 농도(2배·3배)가 다르면 다른 상품(2026-11-27)', () => {
  const m = (ours, title) => titleMatches(ours, specOf(ours), title)
  assert.equal(m('오뚜기 사과식초 900ml X 5개', '오뚜기 3배 사과식초 900ml x 5개'), false)
  assert.equal(m('오뚜기 2배 현미식초 900ml x 3개', '오뚜기 2배 현미식초 900ml x 3개 식초'), true)
  assert.equal(m('오뚜기 2배 현미식초 900ml x 3개', '오뚜기2배현미식초 900ml 3개'), true)
  assert.equal(m('오뚜기 2배 현미식초 900ml x 3개', '오뚜기 현미식초 900ml x 3개'), false)
  assert.equal(m('해태 갈아만든배 340ml x 24캔', '해태 갈아만든배 340ml, 24개'), true) // '배'(과일)는 농도 아님
})
