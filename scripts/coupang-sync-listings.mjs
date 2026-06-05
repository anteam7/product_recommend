/**
 * 4번 + 5번: 쿠팡 ↔ DB listings 양방향 sync
 *
 * 1. 쿠팡 Open API에서 전체 셀러 상품 조회
 * 2. 각 SKU의 풀 페이로드 GET (수동 등록건의 원본 정보 수집)
 * 3. DB upsert:
 *    - DB에 seller_product_id 없음 → source='manual'로 insert
 *    - DB에 있고 statusName 불일치 → status 업데이트
 *    - statusName → status 매핑:
 *      승인완료 → APPROVED
 *      임시저장 → TEMPORARY_SAVE
 *      승인반려 → FAILED
 *      승인대기중 → PENDING_APPROVAL
 */
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(
  readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      let v = l.slice(i + 1).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      return [l.slice(0, i).trim(), v]
    }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const VENDOR_ID = env.COUPANG_VENDOR_ID
const ACCESS_KEY = env.COUPANG_ACCESS_KEY
const SECRET_KEY = env.COUPANG_SECRET_KEY
const HOST = env.COUPANG_API_HOST

function sign(m, p, q = '') {
  const dt = new Date().toISOString().substring(2, 19).replace(/[-:]/g, '') + 'Z'
  return { dt, sig: crypto.createHmac('sha256', SECRET_KEY).update(dt + m + p + q).digest('hex') }
}
async function api(m, p, q = '') {
  const { dt, sig } = sign(m, p, q)
  const r = await fetch(`${HOST}${p}${q ? '?' + q : ''}`, {
    headers: { Authorization: `CEA algorithm=HmacSHA256, access-key=${ACCESS_KEY}, signed-date=${dt}, signature=${sig}`, 'Content-Type': 'application/json;charset=UTF-8' },
  })
  return { status: r.status, body: await r.json() }
}

function statusNameToCode(name) {
  if (name === '승인완료') return 'APPROVED'
  if (name === '부분승인완료') return 'APPROVED'
  if (name === '임시저장') return 'TEMPORARY_SAVE'
  if (name === '승인반려') return 'FAILED'
  if (name === '승인대기중') return 'PENDING_APPROVAL'
  if (name === '심사중') return 'PENDING_APPROVAL'   // 심사중도 승인대기 계열 — raw 한글이 들어가면 admin 페이지 STATUS_LABELS 룩업 실패로 크래시
  if (name === '판매중지') return 'STOPPED'
  return 'PENDING_APPROVAL'   // 미지의 쿠팡 statusName도 안전한 기존 코드로 폴백(raw 한글 status 저장 방지). 원문은 approval_status_name에 별도 보존됨.
}

console.log('[1] 쿠팡 전체 셀러 상품 페이징…')
const products = []
let nextToken = ''
while (true) {
  const q = `vendorId=${VENDOR_ID}&maxPerPage=100${nextToken ? `&nextToken=${nextToken}` : ''}`
  const r = await api('GET', '/v2/providers/seller_api/apis/api/v1/marketplace/seller-products', q)
  if (r.status !== 200) break
  products.push(...(r.body?.data ?? []))
  nextToken = r.body?.nextToken
  if (!nextToken) break
  await new Promise((s) => setTimeout(s, 200))
}
console.log(`    쿠팡 ${products.length}건`)

const { data: db } = await sb.from('jimscanner_coupang_listings').select('id, seller_product_id, source, status, source_goods_no')
const dbMap = new Map(db.map((r) => [r.seller_product_id?.toString(), r]))
console.log(`    DB ${db.length}건\n`)

console.log('[2] sync 처리…')
let manualAdded = 0, statusUpdated = 0, noChange = 0

for (const p of products) {
  const id = p.sellerProductId.toString()
  const dbRow = dbMap.get(id)
  const cpStatus = statusNameToCode(p.statusName)

  if (!dbRow) {
    // 4번: 수동 등록 — DB에 추가
    const detail = await api('GET', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${p.sellerProductId}`)
    const d = detail.body?.data
    const salePrice = d?.items?.[0]?.salePrice ?? 0
    const insertRow = {
      seller_product_id: p.sellerProductId,
      vendor_id: VENDOR_ID,
      source: 'manual',
      source_goods_no: null,
      registered_title: p.sellerProductName,
      display_category_code: p.displayCategoryCode ?? d?.displayCategoryCode,
      display_category_name: null,
      brand: p.brand ?? d?.brand,
      list_price_krw: salePrice,
      dome_price_krw: 0,
      msp_price_krw: 0,
      status: cpStatus,
      displayable: cpStatus === 'APPROVED',
      approval_status_name: p.statusName,
      registered_at: p.createdAt ?? new Date().toISOString(),
      last_synced_at: new Date().toISOString(),
    }
    const { error } = await sb.from('jimscanner_coupang_listings').insert(insertRow)
    if (error) {
      console.log(`  [${id}] manual insert ERR: ${error.message}`)
    } else {
      manualAdded++
      console.log(`  ★ manual 추가 [${id}] ${p.sellerProductName.slice(0, 50)}`)
    }
    await new Promise((s) => setTimeout(s, 200))
    continue
  }

  // 5번: 상태 sync
  if (dbRow.status !== cpStatus) {
    await sb.from('jimscanner_coupang_listings').update({
      status: cpStatus,
      approval_status_name: p.statusName,
      displayable: cpStatus === 'APPROVED',
      last_synced_at: new Date().toISOString(),
    }).eq('id', dbRow.id)
    statusUpdated++
    console.log(`  ↻ [${id}] ${dbRow.status} → ${cpStatus} | ${p.sellerProductName?.slice(0, 40)}`)
  } else {
    noChange++
  }
}

console.log(`\n=== 결과 ===`)
console.log(`수동 등록 추가: ${manualAdded}건`)
console.log(`상태 동기화: ${statusUpdated}건`)
console.log(`변경 없음: ${noChange}건`)
