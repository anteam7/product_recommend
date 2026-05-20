#!/usr/bin/env node
// Daily refresh for jimscanner_content_gap_v MV.
// Run via local cron runner (scripts/run-crons.mjs) — Vercel Hobby cron 한도 우회.
//
// Usage:
//   node --env-file=.env.local scripts/refresh-content-gap.mjs

import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}
const sb = createClient(url, key, { auth: { persistSession: false } })

const start = Date.now()
const { error } = await sb.rpc('jimscanner_refresh_content_gap')
const ms = Date.now() - start

if (error) {
  console.error(`[refresh-content-gap] FAILED in ${ms}ms`, error)
  process.exit(1)
}
console.log(`[refresh-content-gap] OK in ${ms}ms`)
