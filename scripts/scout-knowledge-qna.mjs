#!/usr/bin/env node
/**
 * Knowledge Q&A Scout — 네이버 지식인 미답변 쇼핑 Q&A 수집기.
 *
 * Vercel cron(`/api/cron/collect-naver-kin`) 의 로컬 우회 트리거.
 * Hobby 한도(12) 를 넘긴 cron 을 PC 에서 1일 1회 hit 한다.
 *
 * 사용법:
 *   node --env-file=.env.local scripts/scout-knowledge-qna.mjs
 *
 * 환경변수:
 *   CRON_SECRET                 — 필수
 *   CRON_RUNNER_BASE_URL        — default: https://www.jimscanner.co.kr
 */

const BASE_URL = process.env.CRON_RUNNER_BASE_URL ?? 'https://www.jimscanner.co.kr'
const SECRET = process.env.CRON_SECRET

if (!SECRET) {
  console.error('CRON_SECRET missing. Did you run with --env-file=.env.local ?')
  process.exit(1)
}

const url = `${BASE_URL}/api/cron/collect-naver-kin`
console.log(`[scout-knowledge-qna] GET ${url}`)

const started = Date.now()
const res = await fetch(url, {
  headers: { Authorization: `Bearer ${SECRET}` },
})
const elapsed = Date.now() - started
const body = await res.text()

if (!res.ok) {
  console.error(`[scout-knowledge-qna] FAIL ${res.status} in ${elapsed}ms`)
  console.error(body)
  process.exit(1)
}

try {
  const json = JSON.parse(body)
  console.log(`[scout-knowledge-qna] OK in ${elapsed}ms`)
  console.log(
    `  queries=${json.queries} fetched=${json.fetched} inserted=${json.inserted} queued=${json.queued_for_extraction}`,
  )
  if (json.errors?.length) {
    console.warn(`  ${json.errors.length} errors:`)
    for (const e of json.errors.slice(0, 5)) {
      console.warn(`    - ${e.query}: ${e.reason}`)
    }
  }
} catch {
  console.log(body)
}
