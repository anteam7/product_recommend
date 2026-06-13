import { readFileSync, writeFileSync } from 'node:fs'

let data
try {
  data = JSON.parse(readFileSync('.tmp/naver-name-proposals.json', 'utf8'))
} catch (e) {
  console.error('.tmp/naver-name-proposals.json 읽기 실패:', e.message)
  process.exit(1)
}
if (!Array.isArray(data)) { console.error('proposals가 배열이 아님'); process.exit(1) }

const BAD_KW = new Set([
  'PS', '칠드런', '라이프', '오일', '위드', '다이어트', '울트라',
  '좋은', '스트레스에는', '라이트', '제로', '추출분말', 'K2', '주스',
  '진액', '원데이', '패밀리', '젤리', '슬림', '건강해질', '옥타',
  '아연과', 'Ca', '레이디', '사인', '컴플렉스', '진한', '맥스',
  '프로', '스프레이', '프로틴', '캐나다', '봄날', '스틱', '클린',
  '케어', '분말', '건강', '간에', '포뮬러', '국내산', '비타민E',
  '단백질', '올리고', '오메가', '일진헬스케어 로얄',
])

function hasNote(name) {
  return /미준수|판매가\s*준수|출고\s*불가|노출가/.test(name ?? '')
}

function isWeird(p) {
  if (!p.proposed || !p.topKw) return false
  let re
  try {
    re = new RegExp(p.topKw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
  } catch { return false }
  return (p.proposed.match(re) ?? []).length >= 2
}

let filtered = 0
const out = data.map(p => {
  if (!p || typeof p !== 'object') return p
  if (!p.improvement) return p
  if (BAD_KW.has(p.topKw) || hasNote(p.name) || isWeird(p)) {
    filtered++
    return { ...p, improvement: false }
  }
  return p
})

try {
  writeFileSync('.tmp/naver-name-proposals.json', JSON.stringify(out, null, 2))
} catch (e) {
  console.error('저장 실패:', e.message)
  process.exit(1)
}

const good = out.filter(p => p && p.improvement)
console.log(`필터 완료: 적용=${good.length}건 / 제외=${filtered}건\n`)
console.log('적용 목록:')
good.forEach(p => console.log(`  [${p.topKw}] ${p.name.slice(0, 45)}`))
