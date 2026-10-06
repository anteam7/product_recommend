// "쿠팡 등록응답 형식 미확인" 플래그 건을 쿠팡 단건조회로 검증 → 송장이 실제 등록됐으면 플래그 해제(--apply)
import crypto from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(readFileSync('.env.local','utf8').split(/\r?\n/).filter(l=>l&&!l.startsWith('#')&&l.includes('=')).map(l=>{const i=l.indexOf('=');let v=l.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);return [l.slice(0,i).trim(),v]}))
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const APPLY = process.argv.includes('--apply')
const HOST = env.COUPANG_API_HOST || 'https://api-gateway.coupang.com', V = env.COUPANG_VENDOR_ID
async function api(method, p) {
  const dt = new Date().toISOString().substring(2, 19).replace(/[-:]/g, '') + 'Z'
  const sig = crypto.createHmac('sha256', env.COUPANG_SECRET_KEY).update(dt + method + p).digest('hex')
  const r = await fetch(HOST + p, { method, headers: { Authorization: `CEA algorithm=HmacSHA256, access-key=${env.COUPANG_ACCESS_KEY}, signed-date=${dt}, signature=${sig}`, 'Content-Type': 'application/json;charset=UTF-8' } })
  const text = await r.text(); let json = null; try { json = JSON.parse(text) } catch {}
  return { status: r.status, json, text }
}
const { data: rows } = await sb.from('jimscanner_coupang_orders').select('id, order_id, shipment_box_id, invoice_number, coupang_invoice_status').eq('needs_attention', true).like('attention_reason', '쿠팡 등록응답 형식 미확인%')
let ok = 0, bad = 0
for (const o of rows ?? []) {
  const s = await api('GET', `/v2/providers/openapi/apis/api/v4/vendors/${V}/ordersheets/${o.shipment_box_id}`)
  const d = Array.isArray(s.json?.data) ? s.json.data[0] : s.json?.data
  const status = d?.status ?? null, inv = d?.invoiceNumber ?? null
  const match = s.status === 200 && ['DEPARTURE', 'DELIVERING', 'FINAL_DELIVERY'].includes(status) && String(inv ?? '').replace(/\D/g, '') === String(o.invoice_number ?? '').replace(/\D/g, '')
  console.log(`#${o.order_id} DB송장=${o.invoice_number} | 쿠팡 ${s.status} status=${status} 송장=${inv} → ${match ? 'OK' : '불일치'}`)
  if (match) { ok++; if (APPLY) await sb.from('jimscanner_coupang_orders').update({ needs_attention: false, attention_reason: null, shipping_status: status }).eq('id', o.id) } else bad++
  await new Promise(r => setTimeout(r, 300))
}
console.log(`대상 ${rows?.length ?? 0} · 확인 ${ok} · 불일치 ${bad}${APPLY ? ' · 확인건 플래그 해제 완료' : ' (dry — --apply 로 해제)'}`)
