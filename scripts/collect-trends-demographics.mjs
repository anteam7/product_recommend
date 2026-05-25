#!/usr/bin/env node
/**
 * 로컬 실행기 — Naver DataLab 인구·디바이스 페르소나 매트릭스 수집.
 *
 * 사용법:
 *   node --env-file=.env.local scripts/collect-trends-demographics.mjs
 *
 * Vercel cron 으로도 동작하지만(`/api/cron/collect-naver-trend-demographics`),
 * 호출 수가 24 cell × ~5 batch = 120 fetch 라 60초 한도가 빠듯하다.
 * 로컬에서 한 번 더 돌리는 백업 경로로 둠.
 */

import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const clientId = process.env.NAVER_DEVELOPERS_CLIENT_ID
const clientSecret = process.env.NAVER_DEVELOPERS_CLIENT_SECRET
if (!url || !key) {
  console.error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 .env.local 에 필요합니다.')
  process.exit(1)
}
if (!clientId || !clientSecret) {
  console.error('NAVER_DEVELOPERS_CLIENT_ID / NAVER_DEVELOPERS_CLIENT_SECRET 가 .env.local 에 필요합니다.')
  process.exit(1)
}

const baseUrl = process.env.CRON_RUNNER_BASE_URL ?? 'http://localhost:3000'
const secret = process.env.CRON_SECRET
if (!secret) {
  console.error('CRON_SECRET 가 .env.local 에 필요합니다.')
  process.exit(1)
}

const target = `${baseUrl}/api/cron/collect-naver-trend-demographics`
console.log(`[demographics] calling ${target}`)
const t0 = Date.now()
const res = await fetch(target, { headers: { Authorization: `Bearer ${secret}` } })
const elapsed = Date.now() - t0
const text = await res.text()
console.log(`[demographics] ${res.status} (${elapsed}ms) → ${text.slice(0, 500)}`)
process.exit(res.ok ? 0 : 1)

// supabase 자체 import 는 사용 안 하지만 esm 평가를 위해 참조 보존
void createClient
