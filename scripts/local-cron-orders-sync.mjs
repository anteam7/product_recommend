/**
 * 로컬 cron — 쿠팡 주문 수집
 * Windows 작업 스케줄러 / WSL cron 으로 시간당 실행
 *
 * 실행 로직은 scripts/lib/coupang-orders-sync.mjs 공유(order-server.mjs [지금 수집] 버튼과 동일 로직).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { createCoupangOrdersSyncOps } from './lib/coupang-orders-sync.mjs'

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
const ops = createCoupangOrdersSyncOps({ sb, env, log: console.log })

await ops.syncRecentOrders({ triggeredBy: 'local-cron' })
process.exit(0)
