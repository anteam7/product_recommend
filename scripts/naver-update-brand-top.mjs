/**
 * 스마트스토어 기존 등록상품의 상세 상단 브랜드 이미지 교체 (소급 적용).
 *   - store-assets/brand-intro.jpg 를 네이버에 업로드 → 각 상품 detailContent 의
 *     기존 브랜드 블록(<p><img ... alt="몸에조은가게 브랜드 소개"></p>)을 새 이미지로 교체,
 *     없으면 최상단에 삽입. GET → detailContent 수정 → PUT (전체 payload 왕복).
 *
 *   node --env-file=.env.local scripts/naver-update-brand-top.mjs --no=<originProductNo>   # 단건
 *   node --env-file=.env.local scripts/naver-update-brand-top.mjs [--limit=N] [--dry]      # 배치
 */
import { naverApi, naverUpload } from './lib/naver-api.mjs'
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }))
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : d }
const NO = arg('no'); const LIMIT = parseInt(arg('limit') || '0') || 0; const DRY = process.argv.includes('--dry')
const sleep = (ms) => new Promise((s) => setTimeout(s, ms))

const ALT = '몸에조은가게 브랜드 소개'
// 기존 블록: <p><img src="..." alt="몸에조은가게 브랜드 소개"></p> (속성 순서/따옴표 변형 허용)
const BRAND_RE = /<p>\s*<img[^>]*alt="몸에조은가게 브랜드 소개"[^>]*>\s*<\/p>\s*/

// 1) 새 배너 업로드
const buf = readFileSync(path.join(__dirname, '..', 'store-assets', 'brand-intro.jpg'))
const fd = new FormData(); fd.append('imageFiles', new Blob([buf], { type: 'image/jpeg' }), 'brand.jpg')
const up = await naverUpload('/v1/product-images/upload', fd)
const BRAND_URL = up.status === 200 ? (up.body?.images?.[0]?.url ?? null) : null
if (!BRAND_URL) { console.error('배너 업로드 실패:', up.status, JSON.stringify(up.body).slice(0, 200)); process.exit(1) }
console.log('새 배너 URL:', BRAND_URL, '\n')
const NEW_BLOCK = `<p><img src="${BRAND_URL}" alt="${ALT}"></p>\n`

// 2) 대상 목록
let q = sb.from('jimscanner_naver_listings').select('origin_product_no, name').order('registered_at', { ascending: true })
if (NO) q = q.eq('origin_product_no', NO)
if (LIMIT) q = q.limit(LIMIT)
const { data: rows, error } = await q
if (error) { console.error('select:', error.message); process.exit(1) }
console.log(`대상 ${rows.length}건${DRY ? ' (dry)' : ''}\n`)

let ok = 0, skip = 0, fail = 0
for (const [i, row] of rows.entries()) {
  const no = row.origin_product_no
  try {
    const g = await naverApi('GET', `/v2/products/origin-products/${no}`)
    if (g.status !== 200 || !g.body?.originProduct) { fail++; console.log(`✗ ${no} GET ${g.status} ${JSON.stringify(g.body).slice(0, 120)}`); continue }
    const op = g.body.originProduct
    const html = op.detailContent || ''
    let next
    if (BRAND_RE.test(html)) next = html.replace(BRAND_RE, NEW_BLOCK)
    else if (html.startsWith('<div>')) next = '<div>' + NEW_BLOCK + html.slice(5)
    else next = NEW_BLOCK + html
    if (next === html) { skip++; console.log(`- ${no} 변경 없음`); continue }
    if (DRY) { ok++; console.log(`(dry) ${no} ${BRAND_RE.test(html) ? '교체' : '삽입'} — ${(row.name || '').slice(0, 30)}`); continue }
    op.detailContent = next
    const payload = { originProduct: op, smartstoreChannelProduct: g.body.smartstoreChannelProduct ?? { storeKeepExclusiveProduct: false, naverShoppingRegistration: true, channelProductDisplayStatusType: 'ON' } }
    const p = await naverApi('PUT', `/v2/products/origin-products/${no}`, payload)
    if (p.status === 200) { ok++; console.log(`✓ ${no} (${i + 1}/${rows.length}) ${(row.name || '').slice(0, 30)}`) }
    else { fail++; console.log(`✗ ${no} PUT ${p.status} ${JSON.stringify(p.body).slice(0, 200)}`) }
  } catch (e) { fail++; console.log(`✗ ${no} ${e.message}`) }
  await sleep(400)
}
console.log(`\n완료: 성공 ${ok} / 스킵 ${skip} / 실패 ${fail}`)
