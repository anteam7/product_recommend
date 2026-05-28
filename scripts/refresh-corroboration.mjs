#!/usr/bin/env node
/**
 * Corroboration materialized view 리프레시 — 15분 주기.
 *
 * 호출:
 *   node --env-file=.env.local scripts/refresh-corroboration.mjs
 *
 * Windows Task Scheduler 등록 예 (PowerShell, 15분마다):
 *   $action = New-ScheduledTaskAction -Execute "node.exe" `
 *     -Argument "--env-file=.env.local scripts/refresh-corroboration.mjs" `
 *     -WorkingDirectory "C:\Web\jimscanner-personal"
 *   $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
 *     -RepetitionInterval (New-TimeSpan -Minutes 15)
 *   Register-ScheduledTask -TaskName "jimscanner-corroboration-refresh" `
 *     -Action $action -Trigger $trigger -RunLevel Limited
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
})

const started = Date.now()

try {
  // RPC 호출 — refresh_trend_corroboration() 가 CONCURRENTLY 로 갱신.
  const { error } = await sb.rpc('refresh_trend_corroboration')
  if (error) {
    console.error('[corroboration] refresh failed:', error.message)
    process.exit(1)
  }
  const ms = Date.now() - started
  console.log(`[corroboration] refreshed in ${ms}ms`)
} catch (e) {
  console.error('[corroboration] unexpected error:', e?.message ?? e)
  process.exit(1)
}
