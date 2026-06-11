/**
 * 표준카테고리 재배정 — '기타건강보조식품'(50002615)에 박힌 상품을 정확한 세분류로 PUT.
 * 검색 적합도(노출) 개선 목적. 이름 키워드 룰 → leafCategoryId 변경 → DB 동기화.
 *   node --env-file=.env.local scripts/naver-recategorize.mjs [--dry] [--limit=N]
 */
import { naverApi } from './lib/naver-api.mjs'
import { createClient } from '@supabase/supabase-js'

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const DRY = process.argv.includes('--dry')
const LIMIT = parseInt((process.argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1] || '0') || 0
const sleep = (ms) => new Promise((s) => setTimeout(s, ms))

// 우선순위 순 매칭 (첫 매치 적용). 매핑 없으면 기타건강보조식품 유지.
const RULES = [
  [/글루타치온/, '50017200', '글루타치온'],
  [/비오틴/, '50007044', '비타민제>비오틴'],
  [/폴리코사놀/, '50007032', '폴리코사놀'],
  [/콘드로이친|소연골/, '50017140', '콘드로이친'],
  [/멜라토닌|멜라레브/, '50019119', '멜라토닌'],
  [/블랙마카|마카\b|마카 /, '50019099', '마카'],
  [/커큐민/, '50018999', '커큐민'],
  [/강황/, '50018959', '건강분말>강황가루'],
  [/은행잎/, '50017180', '은행잎추출물'],
  [/포스파티딜세린|두뇌엔 PS/, '50016482', '포스파티딜세린'],
  [/테아닌/, '50017160', '테아닌'],
  [/보스웰리아/, '50007033', '보스웰리아'],
  [/MSM|엠에스엠/i, '50007036', 'MSM'],
  [/셀레늄|셀렌\b/, '50007034', '셀레늄'],
  [/크릴오일/, '50007528', '크릴오일'],
  [/밀크씨슬|밀크시슬|실리마린/, '50007031', '밀크씨슬'],
  [/햄프씨드|대마종자유/, '50019039', '대마종자유'],
  [/바나바/, '50019079', '바나바잎추출물'],
  [/매스틱/, '50019059', '매스틱검'],
  [/이노시톨/, '50019019', '이노시톨'],
  [/베르베린/, '50023359', '베르베린'],
  [/초록입홍합/, '50023379', '초록입홍합'],
  [/낙산균|유산균|프로바이오/, '50007030', '프로바이오틱스'],
  [/프리바이오/, '50007218', '프리바이오틱스'],
  [/효소/, '50017220', '효소'],
  [/맥주효모|효모/, '50017080', '효모'],
  [/알부민/, '50023299', '단백질보충제>알부민'],
  [/산양유|초유|유청|프로틴|단백질/, '50012280', '단백질보충제>단백질파우더'],
  [/가르시니아/, '50001911', '다이어트>가르시니아'],
  [/시서스/, '50012301', '다이어트>시서스'],
  [/\bCLA\b/i, '50001912', '다이어트>CLA'],
  [/알파CD|씨클로덱스트린/i, '50023339', '다이어트>알파CD'],
  [/차전자피|식이섬유/, '50001908', '다이어트>식이섬유'],
  [/콜라겐/, '50007037', '다이어트>콜라겐'],
  [/히알루론산/, '50007041', '다이어트>히알루론산'],
  [/양배추/, '50007001', '건강즙>양배추즙'],
  [/양파즙/, '50007002', '건강즙>양파즙'],
  [/석류/, '50014380', '건강즙>석류즙'],
  [/ABC ?주스/i, '50007007', '건강즙>기타'],
  [/푸룬/, '50007007', '건강즙>기타'],
  [/블루베리/, '50014480', '건강즙>블루베리즙'],
  [/흑염소/, '50017240', '건강즙>흑염소즙'],
  [/쌍화/, '50002622', '한방재료>기타'],
  [/녹용/, '50002434', '한방재료>녹용'],
  [/오미자/, '50002436', '한방재료>오미자'],
  [/헛개|숙취/, '50016742', '숙취해소제'],
  [/MBP|유단백/i, '50011861', '환자식/영양보충식'],
  [/비타민 ?C/i, '50002428', '비타민C'],
  [/비타민 ?B/i, '50002427', '비타민B'],
  [/비타민 ?E/i, '50007043', '비타민E'],
  [/비타민 ?K/i, '50018940', '비타민K'],
  [/엽산/, '50002440', '엽산'],
  [/철분|\b철\b/, '50002442', '철분'],
]
const mapCat = (name) => { for (const [re, id, label] of RULES) if (re.test(name)) return { id, label }; return null }

const { data: rows, error } = await sb.from('jimscanner_naver_listings')
  .select('origin_product_no, name, leaf_category_id').eq('leaf_category_id', '50002615')
if (error) { console.error(error.message); process.exit(1) }
let targets = rows.filter((r) => mapCat(r.name))
if (LIMIT) targets = targets.slice(0, LIMIT)
console.log(`기타건강보조식품 ${rows.length}건 중 재배정 가능 ${targets.length}건${DRY ? ' (dry)' : ''}\n`)

const byLabel = {}
let ok = 0, fail = 0
for (const row of targets) {
  const m = mapCat(row.name)
  byLabel[m.label] = (byLabel[m.label] ?? 0) + 1
  if (DRY) { console.log(`(dry) ${m.label.padEnd(18)} ← ${row.name.slice(0, 44)}`); continue }
  try {
    const g = await naverApi('GET', `/v2/products/origin-products/${row.origin_product_no}`)
    if (g.status !== 200) { fail++; console.log(`✗ ${row.origin_product_no} GET ${g.status}`); continue }
    const op = g.body.originProduct
    op.leafCategoryId = m.id
    const p = await naverApi('PUT', `/v2/products/origin-products/${row.origin_product_no}`, { originProduct: op, smartstoreChannelProduct: g.body.smartstoreChannelProduct ?? { storeKeepExclusiveProduct: false, naverShoppingRegistration: true, channelProductDisplayStatusType: 'ON' } })
    if (p.status === 200) {
      ok++
      await sb.from('jimscanner_naver_listings').update({ leaf_category_id: m.id }).eq('origin_product_no', row.origin_product_no)
      console.log(`✓ ${m.label.padEnd(18)} ← ${row.name.slice(0, 40)}`)
    } else { fail++; console.log(`✗ ${row.origin_product_no} PUT ${p.status} ${JSON.stringify(p.body).slice(0, 140)} | ${row.name.slice(0, 30)}`) }
  } catch (e) { fail++; console.log(`✗ ${row.origin_product_no} ${e.message}`) }
  await sleep(400)
}

console.log(`\n━━ 분포 ━━`)
Object.entries(byLabel).sort((a, b) => b[1] - a[1]).forEach(([l, n]) => console.log(`${String(n).padStart(3)}  ${l}`))
if (!DRY) console.log(`\n완료: 성공 ${ok} / 실패 ${fail}`)
