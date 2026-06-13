/**
 * 네이버 스마트스토어 등록 상품의 sellerTags를 10개로 보강.
 * naver-register.mjs 등록 시 seoInfo.sellerTags가 payload에 누락돼 모든 상품이 태그 없는 상태.
 * GET으로 현재 상품 전체 조회 → tags만 교체 → PUT.
 *
 * 사용법:
 *   node --env-file=.env.local scripts/naver-update-tags.mjs [--limit=N] [--dry]
 *   node --env-file=.env.local scripts/naver-update-tags.mjs --live [--limit=N]
 *
 * 기본은 --dry (미리보기만). --live 플래그가 있어야 실제 PUT 실행.
 * 처음엔 --limit=5 로 테스트 권장.
 */
import { naverApi } from './lib/naver-api.mjs'
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
let env
try {
  env = Object.fromEntries(
    readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8')
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => {
        const i = l.indexOf('=')
        let v = l.slice(i + 1).trim()
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
        return [l.slice(0, i).trim(), v]
      })
  )
} catch (e) {
  console.error('.env.local 읽기 실패:', e.message)
  process.exit(1)
}
if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('.env.local에 NEXT_PUBLIC_SUPABASE_URL 또는 SUPABASE_SERVICE_ROLE_KEY 없음')
  process.exit(1)
}
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d }
const LIMIT = parseInt(arg('limit') || '0') || 0
const LIVE = process.argv.includes('--live')
const DRY = !LIVE

// ---------------------------------------------------------------------------
// seoTags: 10개 생성
// 브랜드명·금지어 방지: 제목에서 단어를 직접 추출하지 않고
// 성분/효능 키워드만 ENRICHMENTS 매핑으로 생성한다.
// ---------------------------------------------------------------------------
function seoTags(title) {
  const tags = new Set()

  // 성분별 → 허용된 일반 건강/효능 키워드만 매핑
  const ENRICHMENTS = [
    [/밀크씨슬|실리마린/, ['밀크씨슬', '간건강', '간기능개선']],
    [/홍삼|인삼/, ['홍삼', '면역력', '항산화']],
    [/비타민\s*c/i, ['비타민C', '항산화', '면역력향상']],
    [/비타민\s*d/i, ['비타민D', '뼈건강', '칼슘흡수']],
    [/비타민\s*b12/i, ['비타민B12', '에너지대사', '신경건강']],
    [/비타민\s*b/i, ['비타민B', '에너지대사']],
    [/나이아신/, ['나이아신', '에너지대사', '피부건강']],
    [/엽산/, ['엽산', '임신준비', '태아건강']],
    [/철분|훼럼|헤모/, ['철분', '빈혈예방', '혈액건강']],
    [/칼슘/, ['칼슘', '뼈건강', '골밀도']],
    [/마그네슘/, ['마그네슘', '근육이완', '스트레스완화']],
    [/아연/, ['아연', '면역력', '피부건강']],
    [/셀레늄/, ['셀레늄', '항산화', '갑상선건강']],
    [/오메가\s*3|알티지|EPA|DHA/i, ['오메가3', '혈행개선', '심혈관건강']],
    [/루테인|지아잔틴/, ['루테인', '눈건강', '시력보호']],
    [/유산균|프로바이오|락토/, ['유산균', '장건강', '장내환경개선']],
    [/효소/, ['효소', '소화건강', '장건강']],
    [/콜라겐/, ['콜라겐', '피부건강', '피부탄력']],
    [/글루코사민|콘드로이친|보스웰리아/i, ['관절건강', '연골건강', '관절유연성']],
    [/MSM/i, ['관절건강', '항염증']],
    [/관절/, ['관절건강', '연골건강']],
    [/글루타치온/, ['글루타치온', '항산화', '피부미백']],
    [/멜라토닌/, ['멜라토닌', '수면개선', '숙면']],
    [/코큐텐|큐텐|코엔자임/, ['코큐텐', '항산화', '심장건강']],
    [/NMN/i, ['항노화', '세포건강', '에너지대사']],
    [/스퍼미딘|spermidine/i, ['세포건강', '항노화', '세포재생']],
    [/프로폴리스/, ['프로폴리스', '항균', '면역강화']],
    [/쏘팔메토/, ['쏘팔메토', '전립선건강']],
    [/포스파티딜세린|phosphatidyl/i, ['두뇌건강', '기억력개선', '집중력향상']],
    [/흑염소|장어|진액|즙|환$/, ['건강즙', '건강식품', '전통건강식']],
    [/홍경천|아슈와간다|마카/, ['피로회복', '활력증진']],
    [/갱년기/, ['갱년기', '여성건강', '호르몬균형']],
    [/단백질|프로틴/i, ['단백질보충', '근육건강']],
    [/식물성/, ['식물성영양제']],
    [/크릴|폴리코사놀/, ['혈행개선', '혈관건강']],
  ]

  const t = title ?? ''
  for (const [re, addTags] of ENRICHMENTS) {
    if (re.test(t)) for (const tag of addTags) { if (tags.size < 10) tags.add(tag) }
  }

  // 부족하면 기본 태그 보충
  if (tags.size < 5) tags.add('건강영양제')
  if (tags.size < 6) tags.add('건강기능식품')
  if (tags.size < 7) tags.add('영양제')

  return [...tags].filter(Boolean).slice(0, 10).map((t) => ({ text: t.slice(0, 25) }))
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

// 400 Restricted.sellerTags 응답에서 금지어 추출
function extractBanned(putRes) {
  const raw = putRes.body?.invalidInputs
  const inv = Array.isArray(raw) ? raw : []
  const banned = []
  for (const item of inv) {
    if (item?.type === 'Restricted.sellerTags') {
      const m = item.message?.match(/등록불가인 단어\(([^)]+)\)/)
      if (m) banned.push(...m[1].split(',').map((w) => w.trim()).filter(Boolean))
    }
  }
  return banned
}

// PUT 실행 + Restricted 금지어 자동 필터 후 1회 재시도
async function putWithRetry(no, prod, tags, globalBanned) {
  // 누적 금지어 선제 필터
  let filtered = tags.filter((t) => !globalBanned.has(t.text))
  prod.originProduct.detailAttribute.seoInfo.sellerTags = filtered

  let res = await naverApi('PUT', `/v2/products/origin-products/${no}`, prod)
  if (!res) return { res: null, appliedTags: filtered }

  if (res.status === 400) {
    const newBanned = extractBanned(res)
    if (newBanned.length) {
      newBanned.forEach((w) => globalBanned.add(w))
      filtered = filtered.filter((t) => !newBanned.includes(t.text))
      prod.originProduct.detailAttribute.seoInfo.sellerTags = filtered
      res = await naverApi('PUT', `/v2/products/origin-products/${no}`, prod)
      if (!res) return { res: null, appliedTags: filtered }
      await sleep(200)
    }
  }
  return { res, appliedTags: filtered }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
const { data: rows, error: dbErr } = await sb
  .from('jimscanner_naver_listings')
  .select('origin_product_no, name, status_type')
  .order('registered_at', { ascending: true })

if (dbErr) { console.error('DB 조회 실패:', dbErr.message); process.exit(1) }

let targets = rows || []
if (LIMIT > 0) targets = targets.slice(0, LIMIT)

console.log(`=== 네이버 태그 보강 ${DRY ? '[DRY — 미리보기]' : '[LIVE]'} | 대상 ${targets.length}건 ===`)
if (DRY) console.log('(실제 PUT 없음. --live 플래그를 추가해야 실행됩니다.)')
if (LIMIT === 0 && targets.length > 20) console.log('TIP: 처음엔 --limit=5 로 테스트 권장.\n')

let updated = 0, skipped = 0, failed = 0
// 실행 중 발견된 금지어 누적 — 이후 상품에서 선제 필터
const globalBanned = new Set()

for (let i = 0; i < targets.length; i++) {
  const row = targets[i]
  const no = row.origin_product_no
  const label = `[${i + 1}/${targets.length}] ${no}`

  try {
    // GET 현재 상품 전체
    const getRes = await naverApi('GET', `/v2/products/origin-products/${no}`)
    if (!getRes || getRes.status !== 200) {
      console.log(`${label} ✗ GET ${getRes?.status ?? 'undefined'} — ${JSON.stringify(getRes?.body ?? null).slice(0, 200)}`)
      failed++
      await sleep(400)
      continue
    }

    const prod = getRes.body
    if (!prod?.originProduct) {
      console.log(`${label} ✗ GET 응답에 originProduct 없음 — ${JSON.stringify(prod).slice(0, 200)}`)
      failed++
      await sleep(400)
      continue
    }

    // currentTags: 배열 보장 (API가 비배열 반환할 경우 대비)
    const rawTags = prod.originProduct.detailAttribute?.seoInfo?.sellerTags
    const currentTags = Array.isArray(rawTags) ? rawTags : []
    if (!row.name) {
      console.log(`${label} — SKIP (name 없음)`)
      skipped++
      await sleep(400)
      continue
    }
    const newTags = seoTags(row.name)

    // 태그 텍스트 비교
    const currentTexts = currentTags.map((t) => t?.text ?? '').sort().join(',')
    const newTexts = newTags.map((t) => t.text).sort().join(',')
    if (currentTexts === newTexts) {
      console.log(`${label} — SKIP (태그 동일: ${currentTags.length}개)`)
      skipped++
      await sleep(400)
      continue
    }

    if (DRY) {
      const before = currentTags.map((t) => t?.text ?? '').join(', ') || '(없음)'
      const after = newTags.map((t) => t.text).join(', ')
      console.log(`${label} ${(row.name || '').slice(0, 35)}`)
      console.log(`  before(${currentTags.length}): ${before}`)
      console.log(`  after (${newTags.length}): ${after}`)
      updated++
      await sleep(400)
      continue
    }

    // LIVE: tags 교체 후 PUT (금지어 자동 필터 + 1회 재시도)
    if (!prod.originProduct.detailAttribute) prod.originProduct.detailAttribute = {}
    if (!prod.originProduct.detailAttribute.seoInfo) prod.originProduct.detailAttribute.seoInfo = {}

    const { res: putRes, appliedTags } = await putWithRetry(no, prod, newTags, globalBanned)

    if (!putRes || putRes.status !== 200) {
      console.log(`${label} ✗ PUT ${putRes?.status ?? 'null'} — ${JSON.stringify(putRes?.body ?? null).slice(0, 300)}`)
      failed++
      await sleep(400)
      continue
    }

    // 상태 변경 감지
    const resStatus = putRes.body?.originProduct?.statusType ?? putRes.body?.statusType
    if (resStatus === 'TEMPORARY_SAVE') {
      console.warn(`${label} WARN: PUT 후 검토 대기(TEMPORARY_SAVE)로 변경됨 — Wing에서 승인요청 필요`)
    }

    // Supabase seller_tags 업데이트 (추적용 — 실패해도 Naver API PUT은 이미 성공)
    const { error: sbErr } = await sb
      .from('jimscanner_naver_listings')
      .update({ seller_tags: appliedTags })
      .eq('origin_product_no', no)
    if (sbErr) {
      // 비치명적: Naver 상에서는 이미 태그가 반영됨. DB만 stale.
      console.warn(`${label} WARN: Supabase seller_tags 업데이트 실패 — ${sbErr.message}`)
    }

    console.log(`${label} ✓ ${(row.name || '').slice(0, 35)} | tags=${newTags.length}개${sbErr ? ' (DB stale)' : ''}`)
    updated++
  } catch (e) {
    console.error(`${label} ✗ ERROR ${e.message}`)
    console.error(e.stack)
    failed++
  }

  await sleep(400)
}

console.log(`\n=== 완료: ${DRY ? '보강 예정' : '업데이트'} ${updated} / 스킵 ${skipped} / 실패 ${failed} ===`)
if (DRY && updated > 0) console.log('실제 적용하려면 --live 플래그 추가 후 재실행하세요.')
