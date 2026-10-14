#!/usr/bin/env node
/**
 * 쿠팡 등록분(jimscanner_coupang_listings.request_payload) → 토스쇼핑 상품 등록. (docs/plan-toss-shopping.md §3)
 *
 *   node scripts/toss-register.mjs --spid=16227431281 --dry            # 변환 결과만 출력
 *   node scripts/toss-register.mjs --spid=16227431281                  # 등록 → 즉시 숨김(hide) → jimscanner_toss_listings 기록
 *   node scripts/toss-register.mjs --spid=... --show                   # 등록 후 숨기지 않음
 *   node scripts/toss-register.mjs --spid=... --opt-qty=3개 --opt-unit=30포 --prep-days=3 --origin=sale
 *   node scripts/toss-register.mjs --check=835157677                   # 토스 상품 상태(검수/노출) 조회 + DB 갱신
 *   node scripts/toss-register.mjs --spid=... --ban=명품,최고          # 상품명·검색태그에서 금칙어 토큰 제거(토스 "검색태그 금칙어" 반려 대응, 기본 명품)
 *
 * 규칙(실측 기준):
 *  - 상품명 1~100자 [0-9a-zA-Z가-힣 ()\-·\[\]/&+,~.*_#] — 등록 후 변경 불가(반려 시만) → 쿠팡 registered_title 사용
 *  - 썸네일 1:1 600px 이상 → 미달 시 sharp 로 800x800 contain 변환 후 Supabase site-assets 업로드(toss/{spid}/thumb.jpg)
 *  - 상세 = 쿠팡 contents 이미지(IMAGE*) 순서대로 DESCRIPTION, HTML 이면 DESCRIPTION_HTML. 가로 600px 미만은 확대해 site-assets 에 올린 URL 로 교체(토스 검수 기준)
 *  - 고시 = PROCESSED_FOOD(가공식품, 쿠팡과 동일 전략) 항목 id 매핑. 건기식 판매업 신고 전까지 HEALTH_FUNCTIONAL_FOOD 미사용
 *  - 판매옵션 = 카테고리 제약 템플릿(수량 + (택1) 개당 수량|개당 캡슐/정) 자동 파싱, --opt-qty/--opt-unit 로 강제
 *  - 가격: salePrice = 쿠팡 list_price_krw 에 수수료 차이 보정(토스 11% vs 쿠팡 10.6% → 같은 순이익, 약 +0.5%, lib/toss-price.mjs; --no-fee-adjust 로 끔),
 *          MSP 이상 검사. originPrice = ggsan 정가(있고 ≥ sale) / --origin=sale 이면 동일. 기등록분 가격 동기화는 scripts/toss-reprice.mjs
 *  - 배송: NORMAL/NORMAL, preparationDays 3(영업일=발송기한·페널티 기준), FREE, 제주/도서산간 미배송(쿠팡 remoteAreaDeliverable N 미러), CJ
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'
import sharp from 'sharp'
import { tossApi, tossRegisterProduct, tossHideProduct, tossProduct, tossConstraintTemplate, tossNotices, tossExchangeRefundLocations, tossDeliveryLocations, tossDeliveryCompanies, PARTNER_NAME } from './lib/toss-api.mjs'
import { tossPriceFromCoupang } from './lib/toss-price.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }))
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d }
const has = (k) => process.argv.includes(`--${k}`)
// 묶음 수를 토스 '수량' 옵션에 그대로 올리면(2개·6개…) 검수가 "옵션 수량 또는 가격 정보" 반려나 수동 검수(90분+)로 돌린다 —
// 2026-10-14 실측: 수량>1 29건 중 통과 3건(반려 11·90분 초과 15), 수량=1 은 79건 중 56건 통과. 기본은 수량 1개(세트)로 올리고 구성은 제목에 남긴다.
// 묶음 수를 수량에 쓰려면 --pack-qty(또는 --opts="수량=N개").
const PACK_QTY = has('pack-qty')
const DRY = has('dry'), SHOW = has('show')
const PREP_DAYS = parseInt(arg('prep-days', '3'), 10)
const ORIGIN_MODE = arg('origin', 'ggsan') // ggsan | sale
const CONTACT = '010-4164-3802'
const RETURN_ONEWAY = 3000, EXCHANGE_ROUNDTRIP = 6000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 카테고리 매핑 (토스 식품>건강식품 leaf, 2026-08-19 실측 id) ──
const CAT_RULES = [
  [/유산균|프로바이오|락토|바이오틱스|포스트바이오|낙산균/, 59849],
  [/오메가\s*3|오메가3|알티지|epa\b|rtg/i, 59847], [/dha/i, 59793],
  [/루테인|지아잔틴/, 59817], [/밀크씨슬|밀크시슬|실리마린/, 59823],
  [/콜라겐|히알루론/, 59863], [/글루코사민|콘드로이친|관절/, 59805], [/msm|식이유황/i, 59797],
  [/쏘팔메토/, 59837], [/커큐민|강황|울금/, 59859], [/코큐텐|코엔자임|큐텐/, 59861],
  [/감마리놀렌|달맞이|보라지/, 59801], [/로얄제리|로열젤리|벌화분/, 59815], [/마늘/, 59819],
  [/스피루리나/, 59835], [/클로렐라/, 59871], [/크릴/, 59869], [/크랜베리/, 59867], [/석류/, 59833],
  [/블루베리/, 59827], [/빌베리/, 59829], [/레시틴/, 59813], [/마카/, 59821], [/초록입홍합/, 59853], [/초유/, 59855],
  [/알로에/, 59845], [/보스웰리아/, 59825], [/징코|은행잎/, 59851], [/레스베라트롤/, 59811], [/아사이/, 59839], [/아스타잔틴|아스타크산틴/, 59841],
  [/mct/i, 59795], [/감초/, 59803], [/녹차|카테킨/, 59809], [/삼부커스|엘더베리/, 59831], [/퀘세틴|퀘르세틴/, 59865], [/카무카무/, 59857], [/아유르베다/, 59843],
  // ── 2026-10-13 확장(toss-health-leaves.json 131개 기준). 위 규칙이 먼저 매칭되므로 기존 등록분 분류는 그대로다 ──
  // 비타민/미네랄
  [/멀티\s*비타민|종합\s*비타민|멀티비타민/, 59897], [/비타민\s*b|비타민비|b\s*군|b\s*컴플렉스/i, 59903], [/비타민\s*c(?![a-z])|비타민씨/i, 59905],
  [/비타민\s*d(?![a-z])|비타민디/i, 59907], [/비타민\s*e(?![a-z])|토코페롤/i, 59909], [/비타민\s*k(?![a-z])/i, 59911], [/비타민\s*a(?![a-z])/i, 59901],
  [/마그네슘/, 59895], [/칼슘/, 59925], [/철분/, 59921], [/엽산/, 59917], [/바이오틴/, 59899], [/아연/, 59915], [/셀레늄|셀렌/, 59913], [/비타민/, 59893],
  // 기타건강식품
  [/프로폴리스/, 59881], [/효소/, 59887], [/폴리코사놀/, 59879], [/트리뷸러스/, 59875], [/sam-?e|메티오닌/i, 59799],
  // 홍삼 (형태별 leaf) — 젤리/캡슐/환/절편/농축액 순, 나머지는 진액/파우치
  [/홍삼.*(젤리|캔디)|(젤리|캔디).*홍삼/, 59997], [/홍삼.*캡슐/, 59999], [/홍삼.*환(?![경장])/, 60001], [/홍삼.*(절편|정과)/, 59993], [/홍삼.*(농축|홍삼정(?!과))/, 59991], [/홍삼|인삼|고려삼/, 59995],
  // 건강즙 (종류별)
  [/흑마늘|마늘.*(즙|진액)/, 59949], [/양배추/, 59971], [/도라지|배즙/, 59953], [/흑염소|녹용|장어/, 59947], [/사과즙|사과.*즙/, 59963], [/비트/, 59961], [/칡/, 59977],
  [/헛개/, 59981], [/호박.*즙|호박즙/, 59983], [/양파.*즙|양파즙/, 59973], [/매실/, 59951], [/복분자/, 59957], [/아로니아/, 59967], [/오디/, 59975], [/포도즙|포도.*즙/, 59979], [/abc\s*(즙|주스)/i, 59943],
  [/백수오|하수오/, 59955], [/즙|진액|파우치|액상스틱/, 59945],
  // 다이어트/헬스
  [/가르시니아/, 60015], [/\bcla\b|공액\s*리놀레산/i, 60013], [/다이어트\s*쉐이크|쉐이크/, 60019], [/디톡스|클렌즈|해독/, 60027], [/다이어트|슬림|체지방|체중/, 60017],
  [/프로틴|단백질\s*보충|웨이\s*프로틴/, 60055], [/bcaa/i, 60033], [/아르기닌/, 60041], [/크레아틴/, 60059], [/타우린/, 60061], [/글루타민/, 60035], [/카르니틴/, 60045],
  // ── 일반 식품(2026-10-13 사용자 요청 "올리브오일 같은 일반 식품도 등록되게", lib/toss-food-leaves.json 1,280 leaf 기준) ──
  // 식용유 — 캡슐 제품(호두오일 캡슐 등)은 제외해 영양제로 남긴다
  [/올리브\s*(오일|유)/, 29191], [/들기름/, 29183], [/참기름/, 29195], [/코코넛\s*오일/, 29179],
  [/(호두|아마씨|플랙시드|햄프씨드|대마종자|아보카도|포도씨|해바라기|호박씨|카놀라|현미유|식용)\s*(오일|유)(?![\s\S]*캡슐)/, 29177],
  // 잡곡·씨앗
  [/볶음\s*참깨|참깨(?!드레싱|가루)/, 28455], [/볶음\s*들깨|들깨(?!가루|유)/, 28437], [/귀리|오트밀/, 28429], [/율무(?!차)/, 28451],
  // 꿀·시럽·잼 ("꿀담은"·"꿀배" 같은 상품명 수식은 제외)
  [/벌집꿀/, 26527], [/허니파우더|벌화분/, 26531], [/벌꿀|사양꿀|아카시아꿀|밤꿀|야생화꿀|꿀(?![가-힣])/, 26529], [/메이플\s*시럽/, 26537], [/아가베/, 26539],
  // 가루(미숫·선식·콩) — 건강분말(60005) 규칙보다 앞에 둔다
  [/미숫가루|미숫/, 26693], [/선식/, 26695], [/콩가루/, 26697], [/누룽지/, 26575],
  // 건과·견과
  [/건대추|대추(?!차|즙)/, 27927], [/푸룬|건자두/, 27937], [/건블루베리/, 27933], [/건망고/, 27929], [/건포도/, 27943], [/곶감/, 27945], [/감말랭이/, 27923],
  [/혼합\s*견과|믹스\s*넛|믹스넛/, 27999], [/호두(?!오일|유)/, 27995], [/캐슈/, 27985], [/피스타치오/, 27987],
  // 차·커피
  [/커피\s*믹스|믹스\s*커피/, 29329], [/드립백|티백\s*커피/, 29315], [/커피/, 29319],
  [/곡물차|보리차|현미차|옥수수차/, 29419], [/율무차/, 29425], [/천마차|마차\b/, 29427], [/국화차/, 29439], [/카모마일|캐모마일/, 29463], [/페퍼민트/, 29467], [/루이보스/, 29449],
  [/히비스커스/, 29469], [/자스민|재스민/, 29459], [/보이차/, 29455], [/콤부차/, 29465], [/허브\s*티|허브차|꽃차/, 29443], [/우롱차/, 29415], [/홍차/, 29473], [/\S+차\s*\d+\s*(티백|포|개입)|티백/, 29441],
  // 식초
  [/애사비|사과\s*초모\s*식초|사과\s*식초/, 29141], [/발사믹/, 29137], [/음용\s*식초|마시는\s*식초|흑초/, 29149], [/식초/, 29133],
  // 음료·간식
  [/꿀물/, 27585], [/비타민\s*음료/, 27587], [/에너지\s*음료/, 27591], [/주스/, 27511], [/약과/, 27683], [/강정/, 27681], [/한과/, 27691], [/곤약\s*젤리/, 27875], [/다크\s*초콜릿/, 27887],
  // 환/분말, 영양식, 허브
  [/건강환|침환|\d+\s*환(?![경장])/, 60007], [/분말|파우더|가루/, 60005], [/영양식|환자식|성인분유|연하식/, 59931], [/허브|추출물|추출분말|잎(?![가-힣])/, 59885],
]
const DEFAULT_CAT = 59807 // 기타영양제
const mapCategory = (t) => { for (const [re, id] of CAT_RULES) if (re.test(t || '')) return id; return DEFAULT_CAT }

// ── 고시: 쿠팡 가공식품 detailName → 토스 PROCESSED_FOOD item id (GET /notices?categoryCode=PROCESSED_FOOD 실측) ──
const PF_MAP = [
  [/제품명/, 321], [/식품의 유형/, 323], [/생산자 및 소재지|생산자/, 325], [/소비기한|제조연월일|품질유지/, 327],
  [/용량|중량|수량/, 329], [/원재료/, 331], [/영양성분/, 333], [/유전자변형/, 335], [/주의사항/, 337], [/수입식품/, 339], [/전화번호|상담/, 341],
]
const PF_ALL = [319, 321, 323, 325, 327, 329, 331, 333, 335, 337, 339, 341] // 319 = 헤더 항목(표시사항)도 내용 필수 — 실측 BAD_REQUEST

// ── 상품명/키워드 ──
// 토스 "검색태그 금칙어" 반려(2026-10-14 더존건강 '명품 황제 …' 3건): "검색태그에 상품명 금칙어와 동일한 단어는 입력할 수 없어요 (금칙어: 명품)".
// 금칙어 목록은 비공개 — 실측된 단어(명품) + 러너가 반려 메시지에서 뽑아 --ban= 으로 넘긴 단어를 상품명·검색태그 토큰에서 제거한다(검색태그는 과장 표현도 넓게 제외).
const NAME_BANNED = new Set(['명품', ...String(arg('ban', '')).split(/[,\s/]+/).map((w) => w.trim()).filter(Boolean)])
const TAG_BANNED = new Set([...NAME_BANNED, '최고', '최저가', '1위', '1등', '베스트', '특가', '할인', '무료배송', '정품', '추천', '인기'])
const stripBanned = (name) => { const toks = name.split(' '); const out = toks.filter((t) => !NAME_BANNED.has(t)); if (out.length !== toks.length) console.log(`  ℹ 상품명 금칙어 제거: ${toks.filter((t) => NAME_BANNED.has(t)).join(', ')} → ${out.join(' ')}`); return out.join(' ').trim() || name }
const cleanName = (t) => (t || '').replace(/\s*-\s*(수량별 판매가[^()]*|쿠팡[^()]*|오픈마켓[^()]*|본사[^()]*|노출가[^()]*)$/g, '').replace(/[^0-9A-Za-z가-힣 ()\-·\[\]/&+,~.*_#]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100)
function keywords(title, brand) {
  const stop = /^(\d|x$|mg|kg|ml|g$|정$|캡슐$|포$|개입|박스|병|슈퍼|프리미엄|골드|플러스|함유|선물세트|세트|정품|본사|상시|모니터링|노출가|준수|반드시)/i
  const toks = (title || '').replace(/[^0-9A-Za-z가-힣\s]/g, ' ').split(/\s+/).map((t) => t.replace(/\s/g, '')).filter((t) => t.length >= 2 && t.length <= 10 && !stop.test(t) && !/^\d/.test(t))
  const out = new Set(toks.slice(0, 6))
  if (brand && /^[0-9A-Za-z가-힣]{1,10}$/.test(brand)) out.add(brand)
  for (const [re, kw] of [[/유산균|프로바이오/, '유산균'], [/낙산균/, '낙산균'], [/오메가\s*3/i, '오메가3'], [/루테인/, '루테인'], [/콜라겐/, '콜라겐'], [/밀크씨슬|밀크시슬/, '밀크씨슬'], [/홍삼/, '홍삼'], [/비타민/, '비타민'], [/커큐민/, '커큐민'], [/msm/i, 'MSM'], [/징코|은행잎/, '은행잎'], [/프로폴리스/, '프로폴리스'], [/멀티비타민|종합비타민/, '멀티비타민'], [/선물세트/, '선물세트'], [/젤리/, '젤리'], [/스틱/, '스틱']]) if (re.test(title || '')) out.add(kw)
  return [...out].filter((k) => /^[0-9a-zA-Z가-힣]{1,10}$/.test(k) && !TAG_BANNED.has(k)).slice(0, 10)
}

// ── 판매옵션: 카테고리 제약 템플릿의 모든 옵션을 채움 (2025.06.16~ salesOption 전부 필수, 택1 그룹은 1개) ──
// 자동 파싱(제목/옵션명) + --opts="수량=1개;개당 용량=70ml;개당 수량=30개" 식 오버라이드(키는 부분일치). 단위는 템플릿 unitValues 로 강제.
function parseUnits(title, itemName, attrs, extra) {
  // 제목에 수량·중량 토큰이 하나도 없을 때만 고시 제품명/포장단위(ggsan 원문, "60gx3병")를 제목 다음·쿠팡 itemName 앞에 끼운다 — itemName 은
  // 쿠팡 속성("3 회분")에서 만들어져 "3정 1박스"처럼 틀릴 수 있다(2026-10-14 홍삼분말세트 "상품 정보 불일치" 반려). 제목에 정보가 있으면 종전과 동일.
  const titleHasUnits = /\d\s*(kg|g|mg|ml|l|정|캡슐|환|포|스틱|매|팩|개입|박스|병|통|세트)(?![a-z가-힣])/i.test(title || '')
  const t = `${title || ''} ${!titleHasUnits && extra ? extra : ''} ${itemName || ''}`
  const per = t.match(/(\d+)\s*(포|스틱|개입|매|팩)/)
  // 제목 자체에 "x 10포" 가 있으면 그 낱개 단위가 진짜다 — 쿠팡 itemName 은 "10정 1박스" 처럼 정으로 적힌 경우가 많다(2026-10-13 다이어트 카페·석류젤리)
  const perTitle = (title || '').match(/(\d+)\s*(포|스틱|개입|매|팩)/)
  const cap = t.match(/(\d+)\s*(정|캡슐|환)/)
  // 병·통·캔으로만 세는 상품(알부민 25ml x 30병, 아토셀 500ml x 3병): 정/캡슐/포 토큰이 없으면 병 수를 낱개 수(N개)로 본다 —
  // 2026-10-14 "25ml x 30병"이 수량 30개 + 캡슐/정 30정으로 올라가 반려·수동검수
  // 제목에 병·통·캔이 있고 정/캡슐/포 토큰이 없으면 제목이 진짜다 — 쿠팡 itemName '2정 1박스'(속성 '2 회분'에서 생성)가 정 수로 잡혀 '1L x 2병'의 병 수를 못 세던 문제(2026-10-14 오미자 진액)
  const capTitle = (title || '').match(/(\d+)\s*(정|캡슐|환)/)
  const bottlesTitle = !perTitle && !capTitle ? (title || '').match(/(\d+)\s*(병|통|캔)(?![가-힣])/) : null
  const bottles = bottlesTitle || (!per && !cap ? t.match(/(\d+)\s*(병|통|캔)(?![가-힣])/) : null)
  const capEff = bottlesTitle ? null : cap
  const vol = t.match(/(\d+(?:\.\d+)?)\s*(ml|mL|ML|l|L)\b/)
  // g/kg 는 "10g x 30포"(식품 스틱) 처럼 x 앞에 와도 낱개 중량이다. mg 만 "1,000mg x 120정"(함량)이라 x 앞이면 제외 (2026-10-13 일반 식품 확장)
  // 경계: 끝/비영문/"x숫자"("15gx30포" 처럼 붙여 쓴 경우) — 영단어 안의 g(gram 등)는 제외
  const wt = t.match(/(\d+(?:\.\d+)?)\s*(kg|g)(?=$|[^a-z]|x\d)/i) || t.match(/(\d+(?:\.\d+)?)\s*(mg)\b(?!\s*[x×])/)
  // 제목에 용량/중량이 없으면 쿠팡 속성(개당 용량/개당 중량, 0 이 아닐 때)으로 보충
  const attrNum = (type) => { const v = attrs?.find((a) => a.attributeTypeName === type)?.attributeValueName; const m = /(\d+(?:\.\d+)?)\s*([a-zA-Z]+)/.exec(v || ''); return m && Number(m[1]) > 0 ? m : null }
  const attrVol = attrNum('개당 용량'), attrWt = attrNum('개당 중량')
  // \b 는 한글 뒤에서 단어 경계가 안 생겨 "10포 4박스" 의 4박스를 못 잡던 문제(2026-10-13) → 한글 미후속 lookahead
  // 묶음 수량: 제목을 먼저 보고(쿠팡 itemName 의 "1박스" 가 제목의 "2개" 를 덮지 않게), "120정 2개"·"60캡슐 3통" 처럼 낱개 토큰 뒤의 "N개" 도 x 없이 인정
  // — 2026-10-14 종근당 MSM 120정 2개 가 수량 1개로 등록됨. g/ml 뒤의 "N개"("20g 10개" = 낱개 수)는 제외
  const packRes = [/[x×]\s*(\d+)\s*(박스|개|세트|병|통|팩)/i, /(\d+)\s*(박스|세트|병|통)(?![가-힣])/, /(?:정|캡슐|환|포|스틱|매)\s*(\d+)\s*(개|통|병|박스)(?![가-힣])/]
  const firstPack = (s) => { for (const re of packRes) { const m = (s || '').match(re); if (m) return m } return null }
  const pack = firstPack(title) || firstPack(t)
  const attrQty = attrs?.find((a) => a.attributeTypeName === '수량')?.attributeValueName?.match(/(\d+)/)?.[1]
  const volM = vol || attrVol, wtM = wt || attrWt
  const liquid = /즙|주스|진액|액상|음료|오일|시럽|식초|드링크|워터|에센스/.test(title || '') // g→ml 대체 허용 여부(가루·정제는 제외)
  // 단일 용기 상품(분말·가루·청·꿀·오일·스프레이·통흑마늘·케일…): 낱개(포·정·병) 토큰이 없고 중량/용량만 있으면 '개당 수량 1개'(용기 1개)가 사실이지 자리값이 아니다.
  // 진액·즙·보액(2100ml = 70ml x 30포 박스)·정제·스틱 류는 낱개 수를 모르는 것이므로 제외 — 2026-10-14 OPTS_UNKNOWN 48건 중 9건이 이 유형으로 매 회차 건너뜀
  const powder = /분말|가루|파우더/.test(title || '')
  const singleNeg = /진액|보액|액상|앰플|스틱|포(?![가-힣])|정(?![가-힣])|캡슐|환(?![가-힣])|알약|정제|젤리|티백|박스|세트|회분/.test(title || '') || (!powder && /즙/.test(title || ''))
  const single = !per && !capEff && !bottles && (!pack || pack[1] === '1') && !!(volM || wtM) && /분말|가루|파우더|청(?![가-힣])|꿀|오일|스프레이|흑마늘|케일|곡물|견과|씨드|원두/.test(title || '') && !singleNeg
  return { liquid, qty: pack ? pack[1] : (attrQty || '1'), per: per ? per[1] : (bottles ? bottles[1] : null), perUnit: per ? (per[2] === '개입' ? '개' : per[2]) : (bottles ? '개' : null), perTitle: perTitle ? perTitle[1] : null, perTitleUnit: perTitle ? (perTitle[2] === '개입' ? '개' : perTitle[2]) : null, cap: capEff ? capEff[1] : null, capUnit: capEff ? capEff[2] : null, single, vol: volM ? volM[1] : null, volUnit: volM ? volM[2].toLowerCase() : null, wt: wtM ? wtM[1] : null, wtUnit: wtM ? wtM[2].toLowerCase() : null }
}
function forceUnit(value, unitValues) {
  if (!unitValues?.length) return value
  if (unitValues.some((u) => value.endsWith(u))) return value
  const num = value.replace(/[^0-9.]/g, '') || '1'
  const u = value.replace(/[0-9.\s]/g, '')
  const alias = { ml: ['ml', 'cc', 'ML'], g: ['g'], 개: ['개', '개입', '입', '매'], 정: ['정', '캡슐', '개'], 캡슐: ['캡슐', '개', '정'], 포: ['포', '스틱', '개', '봉'], 스틱: ['스틱', '포', '개'] }
  for (const cand of alias[u] || []) if (unitValues.includes(cand)) return num + cand
  return num + unitValues[0]
}
// 자동값을 못 찾아 '1개' 같은 자리값을 넣은 옵션 목록 — --require-opts 면 등록하지 않고 종료(코드 3, "OPTS_UNKNOWN")해 일괄 러너가 건너뛰게 한다
const OPT_WARN = []
function buildOptions(template, ctx, optsArg) {
  const opts = template?.categorySalesOptions ?? []
  const ov = {}
  for (const kv of (optsArg || '').split(';').map((x) => x.trim()).filter(Boolean)) { const i = kv.indexOf('='); if (i > 0) ov[kv.slice(0, i).trim()] = kv.slice(i + 1).trim() }
  // 키 매칭: 정확 일치(공백·(택1) 무시) 우선, 없을 때만 부분 일치 — "수량" 오버라이드가 "개당 수량"까지 덮던 버그 수정(2026-10-13)
  const norm = (x) => x.replace(/\s|\(택1\)/g, '')
  const templateKeys = opts.map((o) => norm(o.key))
  const override = (key) => {
    const keys = Object.keys(ov)
    const exact = keys.find((x) => norm(x) === norm(key))
    if (exact) return ov[exact]
    // 부분 일치는 템플릿의 다른 옵션 키와 정확히 일치하는 오버라이드("수량")는 제외 — 그 값은 그 옵션의 것이다
    const k = keys.find((x) => !templateKeys.includes(norm(x)) && (norm(key).includes(norm(x)) || norm(x).includes(norm(key))))
    return k ? ov[k] : null
  }
  const u = parseUnits(ctx.title, ctx.itemName, ctx.attrs, ctx.extra)
  const auto = (key) => {
    if (/^수량$/.test(key)) { if (!PACK_QTY && u.qty !== '1') console.log(`  ℹ 묶음 ${u.qty}개 구성 → 수량 1개(세트)로 등록 (묶음 수를 쓰려면 --pack-qty)`); return PACK_QTY ? `${u.qty}개` : '1개' }
    // 액상(즙·주스 키워드)인데 제목이 g 로만 적힌 경우(푸룬주스 20g x 14포) 템플릿이 용량만 받으면 g≈ml 로 넣는다. 가루·정제는 제외.
    if (/용량/.test(key)) return u.vol ? `${u.vol}${u.volUnit}` : (u.liquid && u.wt && u.wtUnit === 'g' ? `${u.wt}ml` : null)
    if (/중량/.test(key)) return u.wt ? `${u.wt}${u.wtUnit}` : null
    // 템플릿에 '개당 수량' 이 없는 카테고리(다이어트식품 등)는 '개당 캡슐/정' 에 낱개(포/스틱)를 넣는다 — 단위는 forceUnit 이 템플릿 허용값으로 맞춤
    if (/캡슐|정/.test(key)) return u.perTitle ? `${u.perTitle}${u.perTitleUnit}` : (u.cap ? `${u.cap}${u.capUnit}` : null)
    if (/개당 수량|수량/.test(key)) { if (u.per) return `${u.per}${u.perUnit}`; if (u.single) { console.log('  ℹ 단일 용기 상품(분말·청·꿀 등) → 개당 수량 1개'); return '1개' } return null }
    return null
  }
  const out = []
  // 1) 택1 아닌 옵션: 전부 채움 (오버라이드 > 자동 > '1'+첫단위)
  for (const o of opts.filter((x) => !x.isOneOfRequiredGroup)) {
    let v = override(o.key) ?? auto(o.key) ?? (/^수량$/.test(o.key) ? '1개' : null)
    if (!v) { v = '1' + (o.unitValues?.[0] || '개'); console.log(`  ⚠ 옵션 '${o.key}' 자동값 없음 → ${v} (필요시 --opts 로 지정)`); OPT_WARN.push(`${o.key}→${v}`) }
    out.push({ groupName: o.key, valueName: forceUnit(v, o.unitValues) })
  }
  // 2) 택1 그룹: 오버라이드가 가리키는 키 > 자동 파싱 가능한 키 > 개당 수량 '1개'
  const oneOf = opts.filter((x) => x.isOneOfRequiredGroup)
  if (oneOf.length) {
    let chosen = oneOf.find((o) => override(o.key) != null), value = chosen ? override(chosen.key) : null
    // 제목에 "x 15포/스틱" 처럼 낱개 단위가 있으면 '개당 수량'을 먼저 본다 — 쿠팡 itemName 이 "15정"으로 잘못 적힌 젤리 스틱이
    // 템플릿 순서(캡슐/정 먼저) 때문에 "15정"으로 등록되던 문제(2026-10-13 석류젤리 dry-run)
    // 낱개(포/스틱)가 있으면 '개당 수량' → '개당 캡슐/정'(포 단위 허용) → 중량/용량 순으로 본다: 홍삼차 3g x 100포 는 "100포"가 "3g"보다 정보가 많다
    const rank = (o) => (/개당 수량/.test(o.key) ? 0 : /캡슐|정/.test(o.key) ? 1 : 2)
    const ordered = u.per ? [...oneOf].sort((a, b) => rank(a) - rank(b)) : oneOf
    if (!chosen) for (const o of ordered) { const a = auto(o.key); if (a) { chosen = o; value = a; break } }
    if (!chosen && u.single) { const o = oneOf.find((x) => /개당 수량/.test(x.key)); if (o) { chosen = o; value = '1개'; console.log('  ℹ 단일 용기 상품(분말·청·꿀 등) → 개당 수량 1개') } }
    if (!chosen) { chosen = oneOf.find((o) => /개당 수량/.test(o.key)) || oneOf[0]; value = '1' + (chosen.unitValues?.[0] || '개'); console.log(`  ⚠ 택1 옵션 자동값 없음 → ${chosen.key}=${value}`); OPT_WARN.push(`${chosen.key}→${value}`) }
    out.push({ groupName: chosen.key, valueName: forceUnit(value, chosen.unitValues) })
  }
  // 값 규칙: [0-9a-zA-Z가-힣*()-_+/.]{1,30}
  for (const o of out) o.valueName = o.valueName.replace(/[^0-9a-zA-Z가-힣*()\-_+/.]/g, '').slice(0, 30)
  return out
}

// ── ggsan 보조정보(정가·제조사·원산지) ──
async function ggsanInfo(goodsNo) {
  try {
    const G = 'https://www.ggsan.com'; const c = new Map()
    const set = (h) => { if (!h) return; for (const part of h.split(/,(?=[^;]+=)/)) { const [kv] = part.split(';'); const eq = kv.indexOf('='); if (eq < 0) continue; c.set(kv.slice(0, eq).trim(), kv.slice(eq + 1).trim()) } }
    const fx = async (u, i = {}) => { const r = await fetch(u, { redirect: 'manual', ...i, headers: { 'User-Agent': 'Mozilla/5.0', Cookie: [...c].map(([k, v]) => `${k}=${v}`).join('; '), ...(i.headers || {}) } }); set(r.headers.get('set-cookie')); return r }
    await fx(`${G}/member/login.php`)
    await fx(`${G}/member/login_ps.php`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: `${G}/member/login.php` }, body: new URLSearchParams({ loginId: env.GGSAN_USER, loginPwd: env.GGSAN_PASS, saveId: 'y', returnUrl: `${G}/main/index.php` }).toString() })
    const html = await (await fx(`${G}/goods/goods_view.php?goodsNo=${goodsNo}`)).text()
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&[a-z]+;/g, ' ').replace(/\s+/g, ' ')
    const price = /name=["']set_goods_price["'][^>]*value=["'](\d+)/.exec(html)?.[1]
    const allUrls = [...new Set([...html.matchAll(/https?:\/\/[^\s"'\\)<>]+\.(?:jpe?g|png|gif|webp)/gi)].map((m) => m[0].replace(/[\\)>"']+$/, '')))]
    const goodsImgs = allUrls.filter((u) => /godomall-storage\.cdn-nhncommerce\.com/.test(u) && u.includes(`/goods/${goodsNo}/`))
    return {
      html,
      images_main: goodsImgs.filter((u) => /\/(big|magnify)\//.test(u) && !/thumb/.test(u)),
      images_detail: goodsImgs.filter((u) => /\/detail\//.test(u) && !/thumb/.test(u)),
      images_content: allUrls.filter((u) => /\/editor\/goods\//i.test(u)),
      in_stock: !!(price && +price > 0), price: price ? +price : null,
      list: +(text.match(/정가\s*([\d,]+)\s*원/)?.[1] || '').replace(/,/g, '') || null,
      // 제조사/원산지: 태그 기반(라벨 다음 셀) 우선, 텍스트 폴백. 원산지 "제품 상세 참조" 류는 null
      maker: (html.match(/제조사<\/[^>]+>\s*<[^>]+>([^<]{1,60})</)?.[1] || text.match(/제조사\s*(.{1,40}?)\s+원산지/)?.[1] || '').trim() || null,
      origin: ((html.match(/원산지<\/[^>]+>\s*<[^>]+>([^<]{1,40})</)?.[1] || text.match(/원산지\s*([가-힣A-Za-z]+)/)?.[1] || '').trim().replace(/.*참조.*/, '') || null),
      msp: +(text.match(/절대\s*준수[^0-9]{0,15}([\d,]{4,})\s*원/)?.[1] || '').replace(/,/g, '') || null,
    }
  } catch (e) { console.log('  ⚠ ggsan 보조정보 실패:', e.message); return null }
}

// ── 썸네일: 토스 검수 규칙(텍스트·로고·워터마크·테두리 금지, 여백 없이 꽉 채움, 1:1 600px+) ──
// 소스 이미지(ggsan/유픽)는 브랜드 로고·뱃지·콜아웃이 얹혀 있어 그대로 내면 REJECT(2026-08-19 실측) → Gemini 이미지 모델로
// "패키지 자체 인쇄 외 오버레이 제거 + 흰 배경 + 프레임 채움" 클린 패키지샷 생성. 실패 시 리사이즈 폴백(--no-gemini 로 강제).
async function geminiPackshot(buf, mime, strict = false) {
  const key = env.GEMINI_API_KEY
  if (!key || has('no-gemini')) return null
  const strictLine = strict ? `
COMPOSITION RULE (MANDATORY): the image must be FULL-BLEED SQUARE — the product must extend to all four edges of the frame (touching or nearly touching every edge), tightly zoomed in. If the product is tall or narrow (bottle, spray, stick, pouch) and the reference photo also shows its outer box, place the box next to it so the arrangement is roughly square; do NOT add units or packaging that are not in the reference (the listing is for exactly what is shown). Absolutely no large empty background areas on any side.` : ''
  const hint = arg('hint') ? `
EXTRA INSTRUCTION: ${arg('hint')}` : ''
  const prompt = `Create a clean Korean e-commerce product thumbnail (packshot) from the reference photo.${strictLine}${hint}
Keep the EXACT same product: same packaging, same box/bottle/pouch shape, same colors, and the text that is PRINTED ON THE PACKAGING must stay readable and unchanged. Do NOT invent a different product.
REMOVE everything that is not the physical product: overlaid brand logos, badges, certification marks, speech bubbles, callouts, promotional text, banners, borders, watermarks, and gift-bag callouts. If a shopping bag or gift box is part of the set, you may keep it but without overlaid text.
Pure white background (#FFFFFF). The ENTIRE product must be fully visible — nothing cropped or cut off at any edge — and it should fill most of the frame with only small, even margins (about 3-5%), no large empty areas. Square 1:1 aspect ratio, at least 1000x1000. Soft studio lighting, photorealistic, sharp focus. No mirror reflection under the product (a faint soft shadow is fine). No added text, letters, numbers, logos or graphics.`
  for (const model of ['gemini-3.1-flash-image-preview', 'gemini-2.5-flash-image']) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: mime, data: buf.toString('base64') } }] }], generationConfig: { responseModalities: ['IMAGE'] } }) })
      if (res.ok) { const d = await res.json(); const part = (d.candidates?.[0]?.content?.parts || []).find((x) => x.inlineData?.data); if (part) return { buf: Buffer.from(part.inlineData.data, 'base64'), model } }
      else console.log(`  ⚠ gemini ${model} HTTP ${res.status}`)
    } catch (e) { console.log(`  ⚠ gemini ${model}: ${e.message}`) }
  }
  return null
}
// strict=true(재검수용): 풀블리드 프롬프트 + 최대 3회 생성 중 가장 정사각에 가까운 결과 채택 → 근사 정사각이면 cover(중앙 크롭)로 여백 0, 아니면 100% fit
// ── 상세 이미지 가로 600px 미만 → 확대 후 site-assets 업로드 (토스 "상세 이미지 검증 실패: N번 상세 이미지 가로 크기가 최소 600 이상", 2026-10-14 7건 전부 이 사유) ──
const DETAIL_MIN_W = 600
async function ensureDetailWidth(images, spid) {
  let fixed = 0, failed = 0
  for (const im of images) {
    if (im.type !== 'DESCRIPTION' || !im.url) continue
    try {
      const r = await fetch(im.url, { signal: AbortSignal.timeout(60_000) })
      if (!r.ok) { failed++; console.log(`  ⚠ 상세 ${im.order} 다운로드 ${r.status} — 원본 URL 유지`); continue }
      const b = Buffer.from(await r.arrayBuffer())
      const m = await sharp(b, { limitInputPixels: false }).metadata()
      if (!m.width || m.width >= DETAIL_MIN_W) continue
      const out = await sharp(b, { limitInputPixels: false }).resize({ width: DETAIL_MIN_W, withoutEnlargement: false }).jpeg({ quality: 90 }).toBuffer() // 세로는 비율 유지
      const key = `toss/${spid}/detail_${im.order}_${Date.now()}.jpg`
      const { error } = await sb.storage.from('site-assets').upload(key, out, { contentType: 'image/jpeg', upsert: true })
      if (error) { failed++; console.log(`  ⚠ 상세 ${im.order} 업로드 실패: ${error.message} — 원본 유지`); continue }
      im.url = sb.storage.from('site-assets').getPublicUrl(key).data.publicUrl
      fixed++
      console.log(`  ℹ 상세 ${im.order} 가로 ${m.width}px < ${DETAIL_MIN_W} → ${DETAIL_MIN_W}px 로 확대 업로드`)
    } catch (e) { failed++; console.log(`  ⚠ 상세 ${im.order} 확인 실패: ${String(e.message).slice(0, 80)} — 원본 유지`) }
  }
  return { fixed, failed }
}

async function ensureThumb(url, spid, { clean = true, strict = false } = {}) {
  // url 은 문자열 또는 후보 배열. 쿠팡 payload 에 저장된 ggsan CDN 경로가 나중에 404 가 되는 경우(2026-10-14 포스파티딜세린·NMN 3건, 공급처 이미지 교체)가
  // 있어 대표 → 쿠팡 CDN 사본 → ggsan 현재 페이지 대표 → 나머지 payload 이미지 순으로 받아지는 첫 이미지를 쓴다.
  const urls = [...new Set((Array.isArray(url) ? url : [url]).filter(Boolean))]
  let src = null
  const errs = []
  for (const u of urls) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(60_000) })
      if (!r.ok) { errs.push(`${r.status} …${u.slice(-50)}`); continue }
      const b = Buffer.from(await r.arrayBuffer())
      await sharp(b).metadata() // 404 HTML 같은 비이미지 응답 걸러냄
      src = b
      if (u !== urls[0]) console.log(`  ⚠ 대표 이미지 대체 → …${u.slice(-60)} (원본 ${errs[0] || '실패'})`)
      break
    } catch (e) { errs.push(`${String(e.message).slice(0, 40)} …${u.slice(-50)}`) }
  }
  if (!src) throw new Error(`썸네일 다운로드 실패: ${errs.join(' | ').slice(0, 300)}`)
  // --crop=left,top,width,height (0~1 비율) : 원본에서 일부(예: 박스만)만 잘라 Gemini 에 넘김 — 모델이 레이아웃을 보존해 재구성을 안 하므로 입력을 바꿔야 함
  if (arg('crop')) {
    const v = arg('crop').split(',').map(Number)
    if (v.length !== 4 || v.some((x) => !Number.isFinite(x) || x < 0 || x > 1) || v[0] + v[2] > 1 || v[1] + v[3] > 1 || v[2] <= 0 || v[3] <= 0) throw new Error('--crop=left,top,width,height (0~1 비율, left+width≤1, top+height≤1)')
    const [l, t, w, h] = v
    const m0 = await sharp(src).metadata()
    const left = Math.round(l * m0.width), top = Math.round(t * m0.height)
    const width = Math.min(Math.round((l + w) * m0.width), m0.width) - left, height = Math.min(Math.round((t + h) * m0.height), m0.height) - top
    src = await sharp(src).extract({ left, top, width, height }).toBuffer()
  }
  const m = await sharp(src).metadata()
  let buf = src, note = `${m.width}x${m.height}${arg('crop') ? ' (crop ' + arg('crop') + ')' : ''}`
  // 배경 화이트닝: 모서리 평균이 밝은 회색(225~254)이면 선형 게인으로 255로 끌어올림(Gemini 가 회색 배경을 내는 경우 — 리탱글 실측). 그 다음 흰 여백 트림.
  const whiten = async (b) => {
    try {
      const { data, info } = await sharp(b).raw().toBuffer({ resolveWithObject: true })
      const px = (x, y) => { const i = (y * info.width + x) * info.channels; return (data[i] + data[i + 1] + data[i + 2]) / 3 }
      const corners = [px(2, 2), px(info.width - 3, 2), px(2, info.height - 3), px(info.width - 3, info.height - 3)]
      const bg = Math.min(...corners)
      if (bg >= 225 && bg < 254) return await sharp(b).linear(255 / bg, 0).toBuffer()
    } catch { /* keep */ }
    return b
  }
  const trimmed = async (b0) => { const b = await whiten(b0); try { const t = await sharp(b).trim({ background: '#ffffff', threshold: 12 }).toBuffer(); const tm = await sharp(t).metadata(); if (tm.width > 50 && tm.height > 50) return { buf: t, w: tm.width, h: tm.height } } catch { /* keep */ } const mm = await sharp(b).metadata(); return { buf: b, w: mm.width, h: mm.height } }
  if (clean) {
    const mime = m.format === 'png' ? 'image/png' : 'image/jpeg'
    let best = null
    for (let attempt = 0; attempt < (strict ? 3 : 1); attempt++) {
      const g = await geminiPackshot(src, mime, strict)
      if (!g) break
      const t = await trimmed(g.buf); const ratio = t.w / t.h; const score = Math.abs(Math.log(ratio))
      if (!best || score < best.score) best = { ...t, score, model: g.model }
      if (score < 0.12) break // 충분히 정사각
    }
    if (best) { buf = best.buf; note += ` → gemini(${best.model}${strict ? ',strict' : ''}) 클린 패키지샷` } else note += ' → gemini 실패, 리사이즈 폴백'
  }
  // 흰 여백 트림 → 1:1 (토스 "여백 없이 꽉 채움" 규칙). strict: 근사 정사각(비율 0.85~1.18)이면 cover 크롭으로 여백 0, 그 외 100% fit. 기본: 94% fit + 패딩.
  const core = await trimmed(buf)
  const size = 1200
  const ratio = core.w / core.h
  let out
  if (false && strict && ratio >= 0.85 && ratio <= 1.18) { // cover 크롭은 제품이 잘려 "비율/여백" 반려를 오히려 유발(징코 실측) → 비활성, 97% fit 사용
    out = await sharp(core.buf).resize(size, size, { fit: 'cover', position: 'centre' }).jpeg({ quality: 92 }).toBuffer()
    note += ' (cover 크롭)'
  } else {
    const inner = Math.round(size * (strict ? 0.96 : 0.92)) // 실측: 제품이 프레임에 닿거나 잘리면 "여백/비율" 반려 → 여유 마진 유지
    const fitted = await sharp(core.buf).resize(inner, inner, { fit: 'inside', withoutEnlargement: false }).toBuffer()
    const fm = await sharp(fitted).metadata()
    out = await sharp(fitted).extend({ top: Math.floor((size - fm.height) / 2), bottom: Math.ceil((size - fm.height) / 2), left: Math.floor((size - fm.width) / 2), right: Math.ceil((size - fm.width) / 2), background: { r: 255, g: 255, b: 255, alpha: 1 } }).jpeg({ quality: 92 }).toBuffer()
    if (strict) console.log(`  ⚠ 비율 ${ratio.toFixed(2)} — cover 불가, 100% fit(여백 잔존 가능)`)
  }
  note += ` (트림 ${core.w}x${core.h})`
  const key = `toss/${spid}/thumb_${Date.now()}.jpg` // 캐시 회피용 타임스탬프(토스가 URL을 다운로드해 저장)
  const { error } = await sb.storage.from('site-assets').upload(key, out, { contentType: 'image/jpeg', upsert: true })
  if (error) throw new Error('site-assets 업로드 실패: ' + error.message)
  const pub = sb.storage.from('site-assets').getPublicUrl(key).data.publicUrl
  return { url: pub, note: `${note} → ${size}x${size} 업로드`, buf: out }
}

// ── 토스 공통 id (교환반품지/묶음그룹/택배사) ──
async function tossRefs() {
  const [ex, dl, dc] = await Promise.all([tossExchangeRefundLocations(), tossDeliveryLocations(), tossDeliveryCompanies()])
  const exMain = (ex.data?.items ?? []).find((x) => x.isMain && x.address) || (ex.data?.items ?? []).find((x) => x.address)
  const dlMain = (dl.data?.items ?? []).find((x) => x.isMain) || (dl.data?.items ?? [])[0]
  const cj = (dc.data?.deliveryCompanies ?? []).find((x) => x.name === 'CJ대한통운' && x.isEnabled)
  if (!exMain || !dlMain || !cj) throw new Error(`토스 기준정보 누락: 교환반품지=${!!exMain} 묶음그룹=${!!dlMain} CJ=${!!cj}`)
  return { exchangeRefundLocationId: exMain.id, deliveryLocationId: dlMain.id, deliveryCompanyId: cj.id }
}

// ── 변환 ──
async function buildPayload(listing, refs) {
  let p = listing.request_payload; let it = p?.items?.[0]
  let gPre = null
  if (!it) {
    // 쿠팡 payload 가 비어 있는 리스팅(수동 등록 등) → ggsan 페이지에서 직접 구성 (대표=magnify/big 첫 장, 상세=에디터 이미지)
    if (listing.source !== 'ggsan') throw new Error('request_payload 비어 있음 — ggsan 외 소스는 직접 구성 미지원')
    gPre = await ggsanInfo(listing.source_goods_no)
    if (!gPre?.html) throw new Error('ggsan 페이지 조회 실패')
    const rep = gPre.images_main[0] || gPre.images_detail[0]
    if (!rep) throw new Error('ggsan 대표 이미지 없음')
    const contents = gPre.images_content.map((u) => ({ contentsType: 'IMAGE_NO_SPACE', contentDetails: [{ detailType: 'IMAGE', content: u }] }))
    if (!contents.length) throw new Error('ggsan 에디터 상세 이미지 없음')
    it = { itemName: listing.registered_title, images: [{ imageType: 'REPRESENTATION', vendorPath: rep }], contents, notices: [], attributes: [], taxType: 'TAX', originalPrice: gPre.list || null }
    p = { sellerProductName: listing.registered_title, brand: listing.brand, items: [it], remoteAreaDeliverable: 'N', returnCharge: RETURN_ONEWAY }
    console.log(`  ℹ payload 없음 → ggsan 직접 구성: 대표 ${rep.slice(-40)} / 상세 ${contents.length}장`)
  }
  const name = stripBanned(cleanName(arg('name') || listing.registered_title || p.sellerProductName))
  const brand = (listing.brand || p.brand || '').replace(/[^0-9a-zA-Z가-힣 *()\-_+/.,]/g, '').trim().slice(0, 50) || null
  if (brand && /없음|중국|기타|OEM|협력사/i.test(brand)) throw new Error(`브랜드 금지어: ${brand}`)
  const categoryId = parseInt(arg('cat', ''), 10) || mapCategory(`${name} ${listing.display_category_name || ''}`)
  const tpl = await tossConstraintTemplate(categoryId)
  if (!tpl.ok) throw new Error(`제약 템플릿 조회 실패 ${JSON.stringify(tpl.error)}`)
  if (!(tpl.data?.productNoticeInfoTemplateTypes ?? []).includes('PROCESSED_FOOD')) throw new Error(`카테고리 ${categoryId}(${tpl.data?.categoryName})는 PROCESSED_FOOD 고시 불가: ${JSON.stringify(tpl.data?.productNoticeInfoTemplateTypes)}`)
  const g = gPre || (listing.source === 'ggsan' ? await ggsanInfo(listing.source_goods_no) : null)
  if (g && g.in_stock === false) throw new Error('ggsan 품절 — 등록 중단')

  // 가격
  if (!listing.list_price_krw || listing.list_price_krw < 1) throw new Error('list_price_krw 없음')
  // 토스 수수료(11%)가 쿠팡(10.6%)보다 높아 같은 가격이면 순이익이 줄어든다 → 같은 순이익이 나오는 가격으로 보정(lib/toss-price.mjs, 약 +0.5%). --no-fee-adjust 로 끔
  const salePrice = has('no-fee-adjust') ? listing.list_price_krw : tossPriceFromCoupang(listing.list_price_krw, listing.source)
  const msp = listing.msp_price_krw || g?.msp || 0
  if (msp && salePrice < msp) throw new Error(`판매가 ${salePrice} < MSP ${msp}`)
  let originPrice = salePrice
  if (ORIGIN_MODE !== 'sale') { const cand = g?.list || it.originalPrice || 0; if (cand >= salePrice) originPrice = cand }

  // 옵션
  const legacy = [arg('opt-qty') ? `수량=${arg('opt-qty')}` : null, arg('opt-unit') ? `개당 수량=${arg('opt-unit')}` : null].filter(Boolean).join(';')
  OPT_WARN.length = 0
  const noticeText = (it.notices || []).filter((n) => /제품명|포장단위/.test(n.noticeCategoryDetailName || '')).map((n) => n.content).filter((c) => c && !/참조/.test(c)).join(' ')
  const options = buildOptions(tpl.data, { title: listing.registered_title, itemName: it.itemName, attrs: it.attributes, extra: noticeText }, [arg('opts'), legacy].filter(Boolean).join(';'))

  // --require-opts: 자리값으로 채운 옵션이 있으면 등록하지 않고 종료(코드 3) — 일괄 러너가 OPTS_UNKNOWN 으로 건너뛰고 로그에 남긴다
  if (has('require-opts') && OPT_WARN.length) { console.error(`OPTS_UNKNOWN: ${OPT_WARN.join('; ')} — 제목/속성에서 수량·중량·용량을 못 찾음. 수동: --opts="키=값;…"`); process.exit(3) }

  // 이미지
  const rep = (it.images || []).find((i) => i.imageType === 'REPRESENTATION') || (it.images || [])[0]
  if (!rep) throw new Error('대표 이미지 없음')
  // 대표 이미지 후보: payload 대표 → 쿠팡 CDN 사본 → ggsan 현재 페이지 대표(공급처가 이미지를 바꿔 옛 URL 이 404 인 경우) → 나머지 payload 이미지
  const thumbSrcs = [rep.vendorPath, rep.cdnPath, ...(g?.images_main ?? []), ...(it.images || []).flatMap((i) => [i.vendorPath, i.cdnPath])]
  const thumb = DRY ? { url: 'DRY-RUN(썸네일 생략)', note: 'dry: 생성 생략' } : await ensureThumb(thumbSrcs, listing.seller_product_id)
  if (thumb.buf) { try { const { writeFileSync, mkdirSync } = await import('node:fs'); const dir = path.join(process.env.TEMP || '.', 'toss-thumbs'); mkdirSync(dir, { recursive: true }); writeFileSync(path.join(dir, `${listing.seller_product_id}.jpg`), thumb.buf) } catch { /* preview only */ } }
  const images = [{ type: 'THUMBNAIL', order: 0, url: thumb.url }]
  let order = 1
  const htmlParts = []
  for (const c of it.contents || []) for (const d of c.contentDetails || []) {
    if (d.detailType === 'IMAGE' && d.content) { if (d.content.length > 255) { console.log('  ⚠ 255자 초과 이미지 URL 스킵'); continue } images.push({ type: 'DESCRIPTION', order: order++, url: d.content }) }
    else if (d.detailType === 'TEXT' && d.content) htmlParts.push(d.content)
  }
  if (images.length === 1 && htmlParts.length) images.push({ type: 'DESCRIPTION_HTML', order: 1, html: htmlParts.join('\n') })
  if (images.length === 1) throw new Error('상세 이미지/HTML 없음 (DESCRIPTION 필수)')
  if (!DRY) await ensureDetailWidth(images, listing.seller_product_id) // 600px 미만 상세컷은 확대 업로드로 교체(실패 시 원본 유지 — 반려되면 러너가 1회 재등록)

  // 고시 (PROCESSED_FOOD)
  const byId = new Map()
  for (const n of it.notices || []) { const hit = PF_MAP.find(([re]) => re.test(n.noticeCategoryDetailName || '')); if (hit && n.content) byId.set(hit[1], n.content) }
  const comp = [...options.filter((o) => o.groupName !== '수량').map((o) => o.valueName), options.find((o) => o.groupName === '수량')?.valueName].filter(Boolean).join(' x ')
  if (!byId.get(321) || /참조/.test(byId.get(321))) byId.set(321, name)
  if (g?.maker) byId.set(325, `${g.maker} (원산지 ${g.origin || '상품 상세페이지 참조'})`)
  // 쿠팡 고시의 용량/수량 칸은 상품명을 그대로 넣은 경우가 많음 → 숫자 없는 값이면 파싱한 구성(예: 30포 x 3개)으로 교체
  const v329 = byId.get(329) || ''
  const looksLikeName = !v329 || /참조/.test(v329) || v329 === byId.get(321) || v329.includes(name.slice(0, 15)) || !/\d\s*(포|정|캡슐|개|ml|g|kg|박스|세트|병)/i.test(v329)
  if (looksLikeName) byId.set(329, comp ? `${comp} (상세페이지 참조)` : '상품 상세페이지 참조')
  byId.set(341, byId.get(341) || CONTACT)
  byId.set(319, '「식품등의 표시·광고에 관한 법률」 및 「식품등의 표시기준」에 따른 표시사항은 아래 세부 항목 및 상품 상세페이지 참조')
  const noticeItems = PF_ALL.map((id) => ({ id, content: (byId.get(id) || '상품 상세페이지 참조').replace(/상세설명 참조/g, '상품 상세페이지 참조').slice(0, 4000) }))

  const payload = {
    partnerName: PARTNER_NAME,
    name, brandName: brand || undefined, categoryId, isTaxFree: it.taxType === 'FREE',
    managementCode: `cp${listing.seller_product_id}`,
    images,
    stocks: [{ options, remainingCount: 99, isHide: false, isMainPrice: true, originPrice, salePrice, managementCode: `${listing.source}:${listing.source_goods_no}` }],
    notice: { categoryCode: 'PROCESSED_FOOD', items: noticeItems },
    exposure: { searchKeywords: keywords(name, brand), description: `${name}. 구성 ${comp || '상세페이지 참조'}. 상세 설명 이미지를 참고해 주세요.`.slice(0, 1500) },
    deliveryPolicy: {
      deliveryType: 'NORMAL', deliveryMethod: 'NORMAL', preparationDays: PREP_DAYS,
      deliveryLocationId: refs.deliveryLocationId, deliveryCompanyId: refs.deliveryCompanyId,
      deliveryFeeType: 'FREE', deliveryFee: 0, minimumPurchasePrice: 0,
      isJejuAndIslandsMountainsDelivery: p.remoteAreaDeliverable === 'Y', jejuDeliveryFee: 0, islandsMountainsDeliveryFee: 0,
    },
    exchangeReturnPolicy: {
      exchangeRefundLocationId: refs.exchangeRefundLocationId,
      refundOneWayDeliveryFee: p.returnCharge || RETURN_ONEWAY, exchangeRoundTripDeliveryFee: (p.returnCharge || RETURN_ONEWAY) * 2 || EXCHANGE_ROUNDTRIP,
      applicationMethodDescription: '토스쇼핑 주문 상세에서 교환/반품 신청. 단순변심 교환/반품은 상품 수령 후 7일 이내, 미개봉 상태에서 가능합니다.',
      applicationTermDescription: '상품 수령 후 7일 이내 (상품 하자·오배송은 수령 후 3개월 이내, 안 날로부터 30일 이내). 식품 특성상 개봉·섭취 후에는 단순변심 반품이 어렵습니다.',
    },
  }
  return { payload, meta: { thumb: thumb.note, categoryName: tpl.data?.categoryName, ggsan: g, msp, salePrice, originPrice } }
}

async function upsertListing(row) {
  const { error } = await sb.from('jimscanner_toss_listings').upsert(row, { onConflict: 'toss_product_id' })
  if (error) console.log('  ⚠ toss_listings 기록 실패:', error.message)
}

// ── --rethumb=<toss_product_id> [--apply] [--thumb-url=] : 썸네일 재생성(클린 패키지샷) → 미리보기 저장 → --apply 시 PUT(전체 교체, 재검수) ──
if (arg('rethumb')) {
  const pid = Number(arg('rethumb'))
  const { data: row } = await sb.from('jimscanner_toss_listings').select('*').eq('toss_product_id', pid).single()
  if (!row?.request_payload) { console.error('toss_listings 에 request_payload 없음'); process.exit(1) }
  const cur = await tossProduct(pid); if (!cur.ok) { console.error('토스 상품 조회 실패', cur.error); process.exit(1) }
  let thumbUrl = arg('thumb-url')
  if (!thumbUrl) {
    const { data: cp } = await sb.from('jimscanner_coupang_listings').select('request_payload').eq('seller_product_id', row.coupang_seller_product_id).single()
    const it = cp?.request_payload?.items?.[0]
    const rep = (it?.images || []).find((i) => i.imageType === 'REPRESENTATION') || (it?.images || [])[0]
    const srcUrl = arg('src') || rep?.vendorPath || rep?.cdnPath
    if (!srcUrl) { console.error('원본 대표이미지 없음 (--src= 로 지정)'); process.exit(1) }
    const t = await ensureThumb(srcUrl, row.coupang_seller_product_id, { clean: true, strict: has('strict') })
    thumbUrl = t.url
    const { writeFileSync } = await import('node:fs')
    const prev = path.join(process.env.TEMP || '.', `toss_thumb_${pid}.jpg`); writeFileSync(prev, t.buf)
    console.log(`  썸네일 ${t.note}
  URL ${thumbUrl}
  미리보기 ${prev}`)
  }
  if (!has('apply')) { console.log('  (--apply 를 붙이면 PUT 으로 교체합니다)'); process.exit(0) }
  const payload = JSON.parse(JSON.stringify(row.request_payload))
  payload.images = payload.images.map((im) => im.type === 'THUMBNAIL' ? { ...im, url: thumbUrl } : im)
  // 옵션 id 유지(없이 보내면 새 itemId 발급) — GET 의 stocks[].id/itemId 를 붙여 보냄
  const curStocks = cur.data.stocks || []
  payload.stocks = payload.stocks.map((st, i) => ({ ...st, id: curStocks[i]?.id, itemId: curStocks[i]?.itemId }))
  const r = await tossApi('PUT', `/products/${pid}/v2`, { body: payload, timeoutMs: 30 * 60_000 })
  console.log('  PUT 응답:', r.ok ? 'OK' : JSON.stringify(r.error))
  if (!r.ok) process.exit(1)
  await sleep(1000)
  const g = await tossProduct(pid); const d = g.data || {}
  await upsertListing({ toss_product_id: pid, inspection_status: d.inspectionStatus ?? null, exposure_status: d.exposureStatus ?? null, rejection_reasons: d.rejectionReasons ?? null, toss_item_id: d.stocks?.[0]?.itemId ?? row.toss_item_id, request_payload: payload, last_response: g.raw, last_synced_at: new Date().toISOString(), updated_at: new Date().toISOString() })
  console.log(`✓ 썸네일 교체 → inspection=${d.inspectionStatus} | itemId ${d.stocks?.[0]?.itemId} (기존 ${row.toss_item_id})`)
  process.exit(0)
}

// ── --check ──
if (arg('check')) {
  const id = arg('check')
  const r = await tossProduct(id)
  if (!r.ok) { console.log('조회 실패', r.error); process.exit(1) }
  const d = r.data
  const stock0 = d.stocks?.[0]
  console.log(`토스 ${id} | ${d.name} | inspection=${d.inspectionStatus} exposure=${d.exposureStatus} | sale ${stock0?.salePrice} orig ${stock0?.originPrice} remain ${stock0?.remainingCount} | itemId ${stock0?.itemId ?? stock0?.id}`)
  if (d.rejectionReasons?.length) console.log('반려 사유:', JSON.stringify(d.rejectionReasons, null, 1))
  const gr = await tossApi('GET', '/product-items/grouped-by-products', { query: { productIds: id, pageSize: 5 } })
  for (const it of gr.data?.items?.[0]?.productItems || []) if (it.rejectReasons?.length) console.log(`  아이템 ${it.itemId} ${it.status?.code}: ` + it.rejectReasons.map((x) => `${x.title} — ${x.message}`).join(' / '))
  const sum = gr.data?.items?.[0]; if (sum) console.log(`  요약: ${sum.summaryStatus?.status}(${sum.summaryStatus?.label}) productInspection=${sum.productInspectionStatus} isHide=${sum.productIsHide}`)
  for (const im of d.images || []) if (im.inspectionStatus && im.inspectionStatus !== 'COMPLETE') console.log(`  이미지 ${im.type}#${im.order ?? im.indexOrder}: ${im.inspectionStatus}`)
  await upsertListing({ toss_product_id: Number(id), inspection_status: d.inspectionStatus, exposure_status: d.exposureStatus, rejection_reasons: d.rejectionReasons ?? null, toss_item_id: stock0?.itemId ?? null, last_response: d, last_synced_at: new Date().toISOString(), updated_at: new Date().toISOString() })
  process.exit(0)
}

// ── 등록 ──
const SPID = arg('spid')
if (!SPID) { console.error('사용: --spid=<seller_product_id> [--dry] [--show] [--cat=] [--opt-qty=] [--opt-unit=] [--prep-days=3] [--origin=ggsan|sale] | --check=<toss_product_id>'); process.exit(1) }
const { data: listing, error } = await sb.from('jimscanner_coupang_listings').select('*').eq('seller_product_id', Number(SPID)).single()
if (error || !listing) { console.error('쿠팡 리스팅 없음:', error?.message); process.exit(1) }
// FAILED(등록 자체가 실패해 토스에 없는 행)는 중복으로 보지 않는다 — 원인 수정 후 --force 없이 재시도 가능, 성공하면 아래에서 지운다
const { data: dup } = await sb.from('jimscanner_toss_listings').select('toss_product_id,inspection_status').eq('coupang_seller_product_id', Number(SPID)).or('inspection_status.is.null,inspection_status.neq.FAILED').limit(1)
if (dup?.length && !has('force')) { console.error(`이미 토스 등록됨: ${dup[0].toss_product_id} (${dup[0].inspection_status}) — --force 로 중복 등록 가능(페널티 주의)`); process.exit(1) }

console.log(`▶ ${listing.registered_title} | ${listing.source} ${listing.source_goods_no} | 쿠팡가 ${listing.list_price_krw} MSP ${listing.msp_price_krw} 도매 ${listing.dome_price_krw}`)
const refs = await tossRefs()
const { payload, meta } = await buildPayload(listing, refs)
console.log(`  카테고리 ${payload.categoryId} ${meta.categoryName}`)
console.log(`  옵션 ${JSON.stringify(payload.stocks[0].options)} | sale ${meta.salePrice} origin ${meta.originPrice} (MSP ${meta.msp})`)
console.log(`  썸네일 ${meta.thumb} | 상세 이미지 ${payload.images.length - 1}장 | 키워드 ${payload.exposure.searchKeywords.join(',')}`)
console.log(`  고시 ${payload.notice.items.map((i) => `${i.id}=${i.content.slice(0, 18)}`).join(' | ')}`)
if (DRY) { console.log('\n[DRY] payload:\n' + JSON.stringify(payload, null, 1).slice(0, 6000)); process.exit(0) }

const t0 = Date.now()
const reg = await tossRegisterProduct(payload)
console.log(`  등록 응답(${((Date.now() - t0) / 1000).toFixed(1)}s):`, reg.ok ? `OK id=${reg.data?.id}` : JSON.stringify(reg.error))
if (!reg.ok) {
  await sb.from('jimscanner_toss_listings').insert({ coupang_seller_product_id: listing.seller_product_id, source: listing.source, source_goods_no: listing.source_goods_no, name: payload.name, brand: payload.brandName ?? null, category_id: payload.categoryId, sale_price: meta.salePrice, origin_price: meta.originPrice, msp_price_krw: meta.msp || null, dome_price_krw: listing.dome_price_krw, management_code: payload.managementCode, inspection_status: 'FAILED', request_payload: payload, last_response: reg.raw, updated_at: new Date().toISOString() })
  process.exit(1)
}
const productId = reg.data.id
let hidden = false
if (!SHOW) { await sleep(800); const h = await tossHideProduct(productId); hidden = h.ok; console.log('  숨김:', h.ok ? 'OK' : JSON.stringify(h.error)) }
await sleep(800)
const g = await tossProduct(productId)
const d = g.data || {}
await upsertListing({
  toss_product_id: productId, coupang_seller_product_id: listing.seller_product_id, source: listing.source, source_goods_no: listing.source_goods_no,
  name: payload.name, brand: payload.brandName ?? null, category_id: payload.categoryId, sale_price: meta.salePrice, origin_price: meta.originPrice,
  msp_price_krw: meta.msp || null, dome_price_krw: listing.dome_price_krw, toss_item_id: d.stocks?.[0]?.itemId ?? null, management_code: payload.managementCode,
  inspection_status: d.inspectionStatus ?? null, exposure_status: d.exposureStatus ?? null, rejection_reasons: d.rejectionReasons ?? null, hidden,
  request_payload: payload, last_response: g.raw, registered_at: new Date().toISOString(), last_synced_at: new Date().toISOString(), updated_at: new Date().toISOString(),
})
// 이전 실패 기록(FAILED, 토스에 없는 행)은 성공했으니 정리 — 남겨두면 일괄 러너 후보 선별·가격 동기화가 같은 spid 를 두 행으로 본다
{ const { error: delErr } = await sb.from('jimscanner_toss_listings').delete().eq('coupang_seller_product_id', listing.seller_product_id).eq('inspection_status', 'FAILED'); if (delErr) console.log(`  (FAILED 행 정리 실패: ${delErr.message})`) }
console.log(`✓ 토스 상품 ${productId} 등록 | inspection=${d.inspectionStatus} exposure=${d.exposureStatus} | itemId ${d.stocks?.[0]?.itemId}`)
console.log(`  상태 확인: node scripts/toss-register.mjs --check=${productId}`)
