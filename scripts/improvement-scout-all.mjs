#!/usr/bin/env node
/**
 * Wrapper — improvement-scout 를 두 프로젝트(product_recommend + jimscanner)에 순차 실행.
 * Windows Task Scheduler 가 시간당 1회 이걸 부르면 양쪽 admin 모두 스카우트된다.
 *
 * 사용법:
 *   node --env-file=.env.local scripts/improvement-scout-all.mjs
 *
 * 환경변수:
 *   SCOUT_JIMSCANNER_PATH (기본 'C:/Web/jimscanner/jimpass-agent-platform')
 *     - 호환: 구 SCOUT_JIMPASS_PATH 도 fallback 으로 인식
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCOUT = resolvePath(__dirname, 'improvement-scout.mjs')

const TARGETS = [
  { project: 'product_recommend', cwd: resolvePath(__dirname, '..') },
  {
    project: 'jimscanner',
    cwd:
      process.env.SCOUT_JIMSCANNER_PATH ??
      process.env.SCOUT_JIMPASS_PATH ??
      'C:/Web/jimscanner/jimpass-agent-platform',
  },
]

function runOne(target) {
  return new Promise((resolve) => {
    console.log(
      `\n[${new Date().toISOString()}] === scout ${target.project} (cwd=${target.cwd}) ===`,
    )
    const child = spawn(
      process.execPath,
      [SCOUT, `--project=${target.project}`, `--cwd=${target.cwd}`],
      { stdio: 'inherit', env: process.env },
    )
    child.on('exit', (code) => resolve(code ?? 0))
    child.on('error', (err) => {
      console.error(`  spawn error: ${err.message}`)
      resolve(1)
    })
  })
}

const t0 = Date.now()
let failCount = 0
for (const target of TARGETS) {
  const code = await runOne(target)
  if (code !== 0) failCount++
}

console.log(
  `\n[${new Date().toISOString()}] all done — ${TARGETS.length - failCount}/${TARGETS.length} ok in ${Date.now() - t0}ms`,
)
process.exit(failCount > 0 ? 1 : 0)
