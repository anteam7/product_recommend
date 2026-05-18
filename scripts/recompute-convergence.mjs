#!/usr/bin/env node
// 매 정시 cron: jimscanner_trends_convergence MV 재계산.
// 사용:
//   node scripts/recompute-convergence.mjs
// 환경변수:
//   NEXT_PUBLIC_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('[convergence] missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const sb = createClient(url, key, { auth: { persistSession: false } })

const startedAt = Date.now()
const { data, error } = await sb.rpc('jimscanner_trends_recompute_convergence')

if (error) {
  console.error('[convergence] RPC failed:', error.message)
  process.exit(2)
}

const elapsed = Date.now() - startedAt
console.log(`[convergence] ok · rows=${data?.rows ?? '?'} · ${elapsed}ms · note=${data?.note ?? '—'}`)
