#!/usr/bin/env node
/**
 * 채널 메트릭 주1회 갱신 — supabase/channel_metrics.sql 의
 * jimscanner_channel_metrics.serp_share 컬럼을 jimscanner_market_raw 의
 * host 도메인 분포로 재계산한다.
 *
 * 사용법:
 *   node --env-file=.env.local scripts/refresh-channel-metrics.mjs
 *
 * cron 등록 (Windows Task Scheduler, 매주 일요일 04:00):
 *   $action = New-ScheduledTaskAction -Execute "node.exe" `
 *     -Argument "--env-file=.env.local scripts/refresh-channel-metrics.mjs" `
 *     -WorkingDirectory "C:\Web\jimscanner-personal"
 *   $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 4:00am
 *   Register-ScheduledTask -TaskName "jimscanner-refresh-channel-metrics" `
 *     -Action $action -Trigger $trigger -RunLevel Limited
 */

import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('missing env: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const sb = createClient(url, key, { auth: { persistSession: false } })

// host 도메인 → 채널 매핑
const HOST_TO_CHANNEL = {
  'coupang.com': 'coupang',
  'smartstore.naver.com': 'naver_smartstore',
  'brand.naver.com': 'naver_smartstore',
  'shopping.naver.com': 'naver_smartstore',
  '11st.co.kr': '11st',
  'gmarket.co.kr': 'gmarket',
  'auction.co.kr': 'auction',
}

function pickChannel(urlStr) {
  if (!urlStr) return null
  try {
    const u = new URL(urlStr)
    const host = u.host.replace(/^www\./, '').toLowerCase()
    for (const [needle, ch] of Object.entries(HOST_TO_CHANNEL)) {
      if (host.endsWith(needle)) return ch
    }
  } catch {
    return null
  }
  return null
}

console.log('[refresh-channel-metrics] start')

// 최근 30일 market_raw 에서 source_url 집계
const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString()
const { data: raw, error: rawErr } = await sb
  .from('jimscanner_market_raw')
  .select('source_url, captured_at')
  .gte('captured_at', since)
  .not('source_url', 'is', null)
  .limit(50000)

if (rawErr) {
  console.error('market_raw fetch failed:', rawErr.message)
  process.exit(1)
}

const counts = new Map()
let totalMatched = 0
for (const row of raw ?? []) {
  const ch = pickChannel(row.source_url)
  if (!ch) continue
  counts.set(ch, (counts.get(ch) ?? 0) + 1)
  totalMatched++
}

console.log(`[refresh-channel-metrics] sampled ${raw?.length ?? 0} rows, matched ${totalMatched} to channels`)
for (const [ch, n] of counts) {
  const share = totalMatched > 0 ? n / totalMatched : 0
  console.log(`  ${ch.padEnd(20)} ${n.toString().padStart(5)}  share=${share.toFixed(3)}`)
}

// 'default' 카테고리 row 만 갱신 (카테고리별 점유는 별도 분석 필요)
let updated = 0
for (const [ch, n] of counts) {
  const share = totalMatched > 0 ? n / totalMatched : 0
  const { error } = await sb
    .from('jimscanner_channel_metrics')
    .update({ serp_share: share, refreshed_at: new Date().toISOString() })
    .eq('channel', ch)
    .eq('category', 'default')
  if (error) {
    console.error(`  update ${ch}: ${error.message}`)
  } else {
    updated++
  }
}

console.log(`[refresh-channel-metrics] done — updated ${updated} channel rows`)
