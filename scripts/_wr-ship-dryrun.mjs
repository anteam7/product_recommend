// 읽기 전용: 송장동기화 크론 대상 산정 + 웰루트/K홀세일 주문상세 조회만(DB·쿠팡 쓰기 없음)
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { withCafe24Session, fetchCafe24Order } from './lib/cafe24-tracking.mjs'
const env = Object.fromEntries(readFileSync('.env.local','utf8').split(/\r?\n/).filter(l=>l&&!l.startsWith('#')&&l.includes('=')).map(l=>{const i=l.indexOf('=');let v=l.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);return [l.slice(0,i).trim(),v]}))
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const { data: rows } = await sb.from('jimscanner_coupang_orders')
  .select('id, order_id, ordered_at, seller_product_id, supplier_source, supplier_goods_no, ggsan_order_no, ggsan_order_status, ggsan_last_checked_at, purchase_status, purchase_ordered_at, coupang_invoice_status, ggsan_invoice_number, shipping_status, receiver_name')
  .in('coupang_invoice_status', ['none','pending','acknowledged','failed']).in('purchase_status', ['ORDERED','SHIPPED']).not('ggsan_order_no','is',null).limit(200)
const spids = [...new Set(rows.filter(r=>!(r.supplier_source&&r.supplier_goods_no)).map(r=>r.seller_product_id))]
const { data: ls } = await sb.from('jimscanner_coupang_listings').select('seller_product_id, source').in('seller_product_id', spids)
const m = new Map(); for (const l of ls??[]) if (l.source && !m.has(l.seller_product_id)) m.set(l.seller_product_id, l.source)
const src = (r) => (r.supplier_source && r.supplier_goods_no) ? r.supplier_source : (m.get(r.seller_product_id) || 'ggsan')
const by = {}; for (const r of rows) (by[src(r)] ??= []).push(r)
console.log('크론 대상 매입처별:', Object.fromEntries(Object.entries(by).map(([k,v])=>[k,v.length])))
const conf = { wellroot: ['WELLROOT_BASE_URL','https://wellrootb2b.com','WELLROOT_USER','WELLROOT_PASS'], kwholesale: ['KWHOLESALE_BASE_URL','https://kwholesale.co.kr','KWHOLESALE_USER','KWHOLESALE_PASS'] }
for (const s of ['wellroot','kwholesale']) {
  const list = by[s] ?? []; if (!list.length) continue
  const [eb, db, eu, ep] = conf[s]
  await withCafe24Session({ base: env[eb]||db, user: env[eu], pass: env[ep], label: s }, async (page, base) => {
    for (const r of list.sort((a,b)=>a.ordered_at<b.ordered_at?-1:1)) {
      const w = await fetchCafe24Order(page, base, r.ggsan_order_no, s)
      console.log(`${s} | 쿠팡#${r.order_id} | 주문 ${r.ordered_at?.slice(5,16)} | 매입 ${r.ggsan_order_no} | DB:${r.purchase_status}/${r.coupang_invoice_status}/쿠팡${r.shipping_status} | 사이트:${w.found?w.status:'없음'} | 송장:${w.invoiceRaw??'-'} ${w.carrier??''}`)
    }
  })
}
