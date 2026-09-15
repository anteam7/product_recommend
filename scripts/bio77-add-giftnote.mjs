/**
 * 77bio 소싱 상품 중 정제/캡슐(알약) 형태 확정분에 "알약케이스 사은품증정" 문구를 상품명 끝에 추가하고
 * 사은품(알약케이스, goodsNo=1000000215) 상세이미지를 상세설명 끝에 덧붙인다.
 *   node --env-file=.env.local scripts/bio77-add-giftnote.mjs [--dry]
 *
 * 대상: jimscanner_coupang_listings source='bio77' AND status in (APPROVED, PENDING_APPROVAL)
 *   AND jimscanner_bio77_products.is_pill_form = true (썸네일 육안판정 — title 키워드 추측 금지.
 *   실측: "신바이오틱스3000골드"/"아르기닌6000M"는 title에 분말/스틱 표기가 없는데도 실제로는 파우치형)
 *   (SKIPPED/REJECTED는 실제 쿠팡에 라이브가 아니라 제외 — 신규 등록분은 bio77-register.mjs가 처리)
 *
 * partial API는 sellerProductName 미지원 → coupang-update-name-full.mjs와 동일하게 GET(현재 전체 페이로드)
 * → sellerProductName/displayProductName/generalProductName + items[].contents만 수정 → PUT 풀 수정.
 * 판매중 상품의 full PUT은 쿠팡이 임시저장으로 강등시키므로(editing_live_product_reverts_to_draft),
 * PUT 직후 승인요청까지 재실행(bio77-register.mjs와 동일한 "임시저장 상태 상품만" 재시도 로직).
 * 재고(vendor-items quantity)는 이 페이로드에 없는 별도 엔드포인트라 PUT으로 영향받지 않는다 — 재설정 불요.
 */
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/).filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }))
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const ACCESS_KEY = env.COUPANG_ACCESS_KEY, SECRET_KEY = env.COUPANG_SECRET_KEY, HOST = env.COUPANG_API_HOST
const sleep = ms => new Promise(r => setTimeout(r, ms))
const DRY = process.argv.includes('--dry')

const GIFT_NOTE = '알약케이스 사은품증정'
const GIFT_DETAIL_IMG_URL = 'https://appletreea1.speedgabia.com/000000_77bio_total/1000000215/Detail_1000000215.jpg'
const MAX_TITLE_LEN = 100 // 쿠팡 sellerProductName 상한(여유있게 보수적으로 가드)

function sign(m, p) { const dt = new Date().toISOString().substring(2, 19).replace(/[-:]/g, '') + 'Z'; return { dt, sig: crypto.createHmac('sha256', SECRET_KEY).update(dt + m + p).digest('hex') } }
async function api(m, p, body = null) {
  const { dt, sig } = sign(m, p)
  const r = await fetch(`${HOST}${p}`, {
    method: m,
    headers: { Authorization: `CEA algorithm=HmacSHA256, access-key=${ACCESS_KEY}, signed-date=${dt}, signature=${sig}`, 'Content-Type': 'application/json;charset=UTF-8' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const t = await r.text()
  try { return { status: r.status, body: JSON.parse(t) } } catch { return { status: r.status, body: t } }
}

// jimscanner_coupang_listings.source_goods_no ↔ jimscanner_bio77_products.goods_no 는 FK가 없어(범용 매입처
// 공용 컬럼) PostgREST embed(!inner)를 못 쓴다 — 두 번 조회 후 클라이언트에서 교집합.
const { data: pillProducts, error: pillErr } = await sb.from('jimscanner_bio77_products').select('goods_no').eq('is_pill_form', true)
if (pillErr) { console.error('is_pill_form 조회 실패:', pillErr.message); process.exit(1) }
const pillGoodsNoSet = new Set((pillProducts ?? []).map(p => p.goods_no))

const { data: allListings, error } = await sb
  .from('jimscanner_coupang_listings')
  .select('id, seller_product_id, registered_title, source_goods_no')
  .eq('source', 'bio77')
  .in('status', ['APPROVED', 'PENDING_APPROVAL'])
  .not('seller_product_id', 'is', null)
if (error) { console.error('select 실패:', error.message); process.exit(1) }
const rows = (allListings ?? []).filter(r => pillGoodsNoSet.has(r.source_goods_no))

console.log(`=== 77bio 상품명 사은품 문구+이미지 추가 ${DRY ? '[DRY]' : ''} === 대상 ${rows?.length ?? 0}건(is_pill_form=true만)\n`)

let ok = 0, skip = 0, fail = 0
for (const row of rows ?? []) {
 let putSucceededTitle = null // PUT 성공 후(승인요청 재시도 중 등) 예외가 나도 DB를 TEMPORARY_SAVE로라도 동기화하기 위한 플래그
 try {
  const getResp = await api('GET', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${row.seller_product_id}`)
  const current = getResp?.body?.data
  if (!current) { fail++; console.log(`✗ ${row.seller_product_id} GET 실패: ${JSON.stringify(getResp?.body).slice(0, 150)}`); await sleep(300); continue }

  const baseTitle = (current.sellerProductName || row.registered_title || '').replace(` ${GIFT_NOTE}`, '')
  const items = Array.isArray(current.items) ? current.items : []
  const hasGiftImgAll = items.length > 0 && items.every(it =>
    (it.contents ?? []).some(c => (c.contentDetails ?? []).some(d => d.content === GIFT_DETAIL_IMG_URL)))
  const titleHasGift = (current.sellerProductName || '').includes(GIFT_NOTE)

  if (titleHasGift && hasGiftImgAll) {
    skip++
    if (!DRY) await sb.from('jimscanner_coupang_listings').update({ registered_title: current.sellerProductName, last_synced_at: new Date().toISOString() }).eq('id', row.id)
    console.log(`⏭ ${row.seller_product_id} 이미 완료(문구+이미지) — ${current.sellerProductName}`)
    continue
  }

  let newTitle = titleHasGift ? current.sellerProductName : `${baseTitle} ${GIFT_NOTE}`
  if (!titleHasGift && newTitle.length > MAX_TITLE_LEN) {
    fail++
    console.log(`✗ ${row.seller_product_id} 문구 추가 시 길이초과(${newTitle.length}>${MAX_TITLE_LEN}) — 수동 확인 필요: ${baseTitle}`)
    await sleep(300); continue
  }

  if (DRY) {
    console.log(`(dry) ${row.seller_product_id} ${baseTitle} → ${newTitle} | 이미지추가필요=${!hasGiftImgAll}`)
    continue
  }

  current.sellerProductName = newTitle
  current.displayProductName = newTitle
  current.generalProductName = newTitle
  current.sellerProductId = row.seller_product_id
  if (!hasGiftImgAll) {
    for (const it of items) {
      const already = (it.contents ?? []).some(c => (c.contentDetails ?? []).some(d => d.content === GIFT_DETAIL_IMG_URL))
      if (already) continue
      it.contents = [...(it.contents ?? []), { contentsType: 'IMAGE_NO_SPACE', contentDetails: [{ content: GIFT_DETAIL_IMG_URL, detailType: 'IMAGE' }] }]
    }
  }

  const putResp = await api('PUT', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products`, current)
  const putOk = putResp.status === 200 && (putResp.body?.code === 'SUCCESS' || putResp.body?.code === 200)
  if (!putOk) {
    fail++
    console.log(`✗ ${row.seller_product_id} PUT 실패: ${JSON.stringify(putResp.body).slice(0, 200)}`)
    await sleep(400); continue
  }
  putSucceededTitle = newTitle // PUT은 성공 — 이후 예외 발생 시 catch에서 최소 TEMPORARY_SAVE로 DB 동기화

  // 판매중이던 상품은 이 PUT으로 임시저장 강등 → 즉시 재승인요청(전파 지연 대비 3회 재시도).
  let appr
  for (let attempt = 0; attempt < 3; attempt++) {
    await sleep(1500)
    appr = await api('PUT', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${row.seller_product_id}/approvals`)
    if (appr.status === 200 && (appr.body?.code === 'SUCCESS' || appr.body?.code === 200)) break
    if (!/임시저장.*상태.*상품만/.test(appr.body?.message ?? '')) break
  }
  const apprOk = appr.status === 200 && (appr.body?.code === 'SUCCESS' || appr.body?.code === 200)
  await sb.from('jimscanner_coupang_listings').update({
    registered_title: newTitle,
    status: apprOk ? 'PENDING_APPROVAL' : 'TEMPORARY_SAVE',
    rejection_reason: apprOk ? null : `사은품문구/이미지 PUT 후 재승인요청 실패: ${JSON.stringify(appr?.body).slice(0, 300)}`,
    last_synced_at: new Date().toISOString(),
  }).eq('id', row.id)

  if (apprOk) { ok++; console.log(`✓ ${row.seller_product_id} ${newTitle} (재승인요청 완료)`) }
  else { fail++; console.log(`⚠ ${row.seller_product_id} 수정은 됐으나 재승인요청 실패 — 임시저장 상태로 남음: ${newTitle}`) }
  await sleep(500)
 } catch (e) {
  fail++
  const msg = e instanceof Error ? e.message : String(e)
  console.log(`✗ ${row.seller_product_id} 처리 중 예외: ${msg}`)
  if (putSucceededTitle) {
    // PUT(상품수정)까지는 성공했으므로 쿠팡 실제 상태는 최소 임시저장 — DB를 방치하면 다음 판정 로직이 어긋난다.
    const { error: syncErr } = await sb.from('jimscanner_coupang_listings').update({
      registered_title: putSucceededTitle,
      status: 'TEMPORARY_SAVE',
      rejection_reason: `사은품문구/이미지 PUT 후 예외로 재승인요청 미완료: ${msg}`,
      last_synced_at: new Date().toISOString(),
    }).eq('id', row.id)
    if (syncErr) console.log(`  ⚠ ${row.seller_product_id} DB 동기화도 실패 — 수동 확인 필요: ${syncErr.message}`)
  }
  await sleep(300)
 }
}

console.log(`\n=== 완료 ===  성공: ${ok}, 이미완료: ${skip}, 실패: ${fail}`)
