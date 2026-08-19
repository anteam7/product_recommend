#!/usr/bin/env node
/**
 * 쿠팡 주문 1건의 매입처를 "이 주문에 한해서" 변경(오버라이드) — 리스팅 매칭은 건드리지 않는다.
 * (예: 리스팅은 유픽 매칭인데 유픽 품절 → 이 주문만 건강산에서 매입)
 *
 * 사용:
 *   node scripts/coupang-order-set-supplier.mjs <order_id> <ggsan|upickb2b> <goods_no>
 *   node scripts/coupang-order-set-supplier.mjs <order_id> --clear      # 오버라이드 해제(리스팅 매칭으로 복귀)
 *
 * 전제: jimscanner_coupang_orders.supplier_source / supplier_goods_no 컬럼 (supabase/coupang_orders_supplier_override.sql)
 * 반영: 어드민 /admin/coupang-orders 매입 링크·결제진행 버튼, scripts/order-server.mjs resolveOrder(재시작 필요)
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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

const [orderIdArg, sourceArg, goodsNoArg] = process.argv.slice(2)
const SOURCES = new Set(['ggsan', 'upickb2b'])
if (!orderIdArg || (sourceArg !== '--clear' && (!SOURCES.has(sourceArg) || !goodsNoArg))) {
  console.error('사용: node scripts/coupang-order-set-supplier.mjs <order_id> <ggsan|upickb2b> <goods_no>  |  <order_id> --clear')
  process.exit(1)
}
const orderId = Number(orderIdArg)

const { data: o, error: e1 } = await sb.from('jimscanner_coupang_orders')
  .select('order_id, product_name, receiver_name, purchase_status, seller_product_id, supplier_source, supplier_goods_no')
  .eq('order_id', orderId).maybeSingle()
if (e1) { console.error('조회 실패:', e1.message, '(컬럼이 없으면 supabase/coupang_orders_supplier_override.sql 먼저 적용)'); process.exit(1) }
if (!o) { console.error(`주문 ${orderId} 없음`); process.exit(1) }
if (o.purchase_status && o.purchase_status !== 'PENDING') console.warn(`⚠ 이미 매입 진행 상태(${o.purchase_status}) — 오버라이드는 기록되지만 발주는 이미 나갔을 수 있음`)

const { data: L } = await sb.from('jimscanner_coupang_listings').select('source, source_goods_no').eq('seller_product_id', o.seller_product_id).limit(1)
const before = o.supplier_source && o.supplier_goods_no ? `${o.supplier_source} ${o.supplier_goods_no} (오버라이드)` : `${L?.[0]?.source ?? '?'} ${L?.[0]?.source_goods_no ?? '?'} (리스팅)`

const patch = sourceArg === '--clear'
  ? { supplier_source: null, supplier_goods_no: null, updated_at: new Date().toISOString() }
  : { supplier_source: sourceArg, supplier_goods_no: String(goodsNoArg), updated_at: new Date().toISOString() }
const { error: e2 } = await sb.from('jimscanner_coupang_orders').update(patch).eq('order_id', orderId)
if (e2) { console.error('업데이트 실패:', e2.message); process.exit(1) }

const after = sourceArg === '--clear' ? `${L?.[0]?.source ?? '?'} ${L?.[0]?.source_goods_no ?? '?'} (리스팅 복귀)` : `${sourceArg} ${goodsNoArg} (오버라이드)`
console.log(`✓ 주문 ${orderId} [${o.receiver_name}] ${(o.product_name || '').slice(0, 40)}`)
console.log(`  매입처: ${before}  →  ${after}`)
console.log('  ※ order-server(127.0.0.1:39201)가 떠 있으면 재시작해야 결제진행에 반영됩니다')
