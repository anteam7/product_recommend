/**
 * 승인반려(이미지 규격) 수정 — 500px 미만 이미지를 500x500으로 패딩(흰 배경) → Supabase Storage 업로드
 * → 상품 payload의 vendorPath 교체 → 전체 PUT → 재승인.
 *   node scripts/coupang-fix-images.mjs --goods=1000004508,... [--apply]
 * (반려 사유 '최소 500x500' 대응. 큰 이미지는 그대로 둠.)
 */
import sharp from 'sharp'
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const env = Object.fromEntries(readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }))
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const { COUPANG_ACCESS_KEY: ACCESS_KEY, COUPANG_SECRET_KEY: SECRET_KEY, COUPANG_API_HOST: HOST } = env
const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.split('=').slice(1).join('=') : null }
const GOODS = (arg('goods') || '').split(',').map((s) => s.trim()).filter(Boolean)
// --source=<매입처>(기본 ggsan) · --spid=<sellerProductId,…> 로 직접 지정도 가능(2026-10-15 캠핑문 옛 잡화 6건 "최소 500*500" 반려)
const SRC = arg('source') || 'ggsan'
const SPIDS = [...new Set((arg('spid') || '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0))]
const APPLY = process.argv.includes('--apply')
const BUCKET = 'site-assets', MIN = 500
function sign(m, p) { const dt = new Date().toISOString().substring(2, 19).replace(/[-:]/g, '') + 'Z'; return { dt, sig: crypto.createHmac('sha256', SECRET_KEY).update(dt + m + p).digest('hex') } }
async function api(m, p, body) { const { dt, sig } = sign(m, p); const r = await fetch(`${HOST}${p}`, { method: m, headers: { Authorization: `CEA algorithm=HmacSHA256, access-key=${ACCESS_KEY}, signed-date=${dt}, signature=${sig}`, 'Content-Type': 'application/json;charset=UTF-8' }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); try { return { status: r.status, body: JSON.parse(t) } } catch { return { status: r.status, body: t } } }

const targets = []
if (SPIDS.length) {
  const { data, error } = await sb.from('jimscanner_coupang_listings').select('seller_product_id, source_goods_no, request_payload').in('seller_product_id', SPIDS).not('request_payload', 'is', null)
  if (error) { console.error(`리스팅 조회 실패: ${error.message}`); process.exit(1) }
  for (const r of data ?? []) if (!targets.some((t) => t.spid === r.seller_product_id)) targets.push({ goods: r.source_goods_no || String(r.seller_product_id), spid: r.seller_product_id, rp: r.request_payload })
  for (const s of SPIDS) if (!targets.some((t) => t.spid === s)) console.log(`✗ ${s} 리스팅 없음(또는 request_payload 없음)`)
} else for (const goods of GOODS) {
  const { data: L } = await sb.from('jimscanner_coupang_listings').select('seller_product_id, request_payload').eq('source_goods_no', goods).eq('source', SRC).not('request_payload', 'is', null).order('id', { ascending: true }).limit(1)
  if (!L?.[0]?.seller_product_id) { console.log(`✗ ${goods} 리스팅 없음`); continue }
  targets.push({ goods, spid: L[0].seller_product_id, rp: L[0].request_payload })
}
for (const { goods, spid, rp } of targets) {
 try { // 상품 단위 격리 — 한 건의 네트워크/이미지 예외가 나머지 처리를 막지 않게
  const d = (await api('GET', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${spid}`)).body?.data
  if (!d) { console.log(`✗ ${goods} GET 실패`); continue }
  let fixed = 0
  for (let i = 0; i < (d.items || []).length; i++) {
    const dimgs = d.items[i].images || [], rimgs = rp?.items?.[i]?.images || []
    for (let j = 0; j < dimgs.length; j++) {
      const img = dimgs[j]
      // 원본 바이트는 request_payload의 godomall 전체 URL에서 (GET의 cdnPath는 조각이라 fetch 불가)
      const src = rimgs[j]?.vendorPath || rimgs[j]?.cdnPath
      if (!src || !/^https?:\/\//.test(src)) continue
      const fr = await fetch(src, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20_000) })
      if (!fr.ok) { console.log(`     ✗ 원본 다운로드 실패 ${fr.status} ${src}`); continue }
      const buf = Buffer.from(await fr.arrayBuffer())
      let meta
      try { meta = await sharp(buf).metadata() } catch { console.log(`     ✗ 이미지 해석 실패 ${src}`); continue }
      if (meta.width >= MIN && meta.height >= MIN) continue   // 규격 OK → 유지
      const padded = await sharp(buf).resize(MIN, MIN, { fit: 'contain', background: { r: 255, g: 255, b: 255 } }).jpeg({ quality: 92 }).toBuffer()
      console.log(`   ${goods} ${img.imageType} ${meta.width}x${meta.height} → 500x500 (${(padded.length / 1024).toFixed(0)}KB)${APPLY ? '' : ' [dry]'}`)
      if (!APPLY) { fixed++; continue }
      const key = `coupang-fix/${goods}/${img.imageType}_${i}_${j}.jpg`
      const up = await sb.storage.from(BUCKET).upload(key, padded, { contentType: 'image/jpeg', upsert: true })
      if (up.error) { console.log(`     ✗ 업로드 실패 ${up.error.message}`); continue }
      img.vendorPath = sb.storage.from(BUCKET).getPublicUrl(key).data.publicUrl
      delete img.cdnPath   // Coupang 재처리 유도
      fixed++
    }
  }
  if (!fixed) { console.log(`= ${goods} 수정할 이미지 없음`); continue }
  if (!APPLY) { console.log(`  [dry] ${goods} ${fixed}개 수정 예정`); continue }
  const put = await api('PUT', '/v2/providers/seller_api/apis/api/v1/marketplace/seller-products', d)
  if (!(put.status === 200 && (put.body?.code === 'SUCCESS' || put.body?.code === 200))) { console.log(`  ✗ ${goods} PUT 실패 ${JSON.stringify(put.body).slice(0, 140)}`); continue }
  // Coupang이 새 이미지(Supabase) 처리할 시간 필요 — 너무 빨리 승인요청하면 ERROR
  await new Promise((s) => setTimeout(s, 8000))
  let ap = await api('PUT', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${spid}/approvals`, {})
  if (ap.body?.code !== 'SUCCESS') { await new Promise((s) => setTimeout(s, 6000)); ap = await api('PUT', `/v2/providers/seller_api/apis/api/v1/marketplace/seller-products/${spid}/approvals`, {}) }
  console.log(`  ✓ ${goods} 이미지 ${fixed}개 교체 + 승인요청 (${ap.body?.code || ap.status})`)
  // followup 은 TEMPORARY_SAVE/PENDING_APPROVAL/APPROVED 만 다시 보므로 REJECTED 였던 행을 승인대기로 되돌려 둔다(2026-10-15)
  if (ap.body?.code === 'SUCCESS') { const { error: ue } = await sb.from('jimscanner_coupang_listings').update({ status: 'PENDING_APPROVAL', rejection_reason: `이미지 ${fixed}개 500x500 패딩 교체 후 재승인요청`, last_synced_at: new Date().toISOString() }).eq('seller_product_id', spid); if (ue) console.log(`     ⚠ DB 상태 갱신 실패: ${ue.message}`) }
  await new Promise((s) => setTimeout(s, 800))
 } catch (e) { console.log(`  ✗ ${goods} 예외: ${String(e.message).slice(0, 160)}`) }
}
console.log(`\n=== ${APPLY ? '완료' : 'DRY-RUN — --apply 로 반영'} ===`)
