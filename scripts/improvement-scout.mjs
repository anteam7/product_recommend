#!/usr/bin/env node
/**
 * Improvement Scout — 시간당 1회 Claude Code CLI 를 agentic read-only 모드로 띄워
 * 프로젝트 admin 영역을 둘러보면서 새로운 기능 개선안을 1개 제안한다.
 *
 * 개선 방향:
 *  - 효과적인 데이터 분석
 *  - 수집된 데이터의 시각화
 *  - 분석된 데이터로 경쟁력있는 상품 발굴
 *
 * 두 프로젝트가 같은 Supabase 를 공유하므로 `--project` 로 출처를 구분한다.
 * 각 프로젝트는 자기 cwd 에서 이 스크립트를 실행하면 그 디렉토리를 둘러본다.
 *
 * 사용법:
 *   # jimscanner-personal 에서
 *   node --env-file=.env.local scripts/improvement-scout.mjs --project=personal
 *
 *   # jimpass-agent-platform 에서
 *   node --env-file=.env.local scripts/improvement-scout.mjs --project=jimpass
 *
 * 요구 사항:
 *   - claude CLI 가 PATH 에 있고 인증 완료
 *   - NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from '@supabase/supabase-js'
import { spawn } from 'node:child_process'
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'

const args = process.argv.slice(2)
function getArg(name, fallback) {
  const direct = args.find((a) => a.startsWith(`--${name}=`))
  if (direct) return direct.slice(name.length + 3)
  const idx = args.indexOf(`--${name}`)
  if (idx !== -1 && args[idx + 1]) return args[idx + 1]
  return fallback
}

const PROJECT = getArg('project', 'personal')
const CWD = getArg('cwd', process.cwd())

if (!['personal', 'jimpass'].includes(PROJECT)) {
  console.error(`Invalid --project: ${PROJECT} (expected personal | jimpass)`)
  process.exit(1)
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
})

const SOURCE = 'improvement_scout'
const MAX_PAST_IDEAS = 60

async function fetchPastIdeas() {
  const { data } = await sb
    .from('jimscanner_improvement_ideas')
    .select('title, category, priority, status, dedup_signature, generated_at')
    .eq('project', PROJECT)
    .order('generated_at', { ascending: false })
    .limit(MAX_PAST_IDEAS)
  return data ?? []
}

async function fetchDataSnapshot() {
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  const [{ data: runs }, { count: classified }, { count: unclassified }, { data: raw24 }] =
    await Promise.all([
      sb
        .from('jimscanner_trends_runs')
        .select('source, status, fetched_count, inserted_count, started_at')
        .gte('started_at', since7d)
        .order('started_at', { ascending: false })
        .limit(300),
      sb
        .from('jimscanner_trends_products')
        .select('id', { count: 'exact', head: true })
        .not('llm_classified_at', 'is', null),
      sb
        .from('jimscanner_trends_products')
        .select('id', { count: 'exact', head: true })
        .is('llm_classified_at', null),
      sb
        .from('jimscanner_market_raw')
        .select('source, captured_at')
        .gte('captured_at', since24h)
        .limit(3000),
    ])

  const runsBySource = {}
  for (const r of runs ?? []) {
    if (!runsBySource[r.source]) {
      runsBySource[r.source] = { ok: 0, partial: 0, error: 0, fetched: 0, inserted: 0, lastAt: '' }
    }
    const s = runsBySource[r.source]
    s[r.status] = (s[r.status] ?? 0) + 1
    s.fetched += r.fetched_count ?? 0
    s.inserted += r.inserted_count ?? 0
    if (!s.lastAt || r.started_at > s.lastAt) s.lastAt = r.started_at
  }

  const raw24BySource = {}
  for (const r of raw24 ?? []) {
    raw24BySource[r.source] = (raw24BySource[r.source] ?? 0) + 1
  }

  return {
    runsBySource,
    raw24BySource,
    classified: classified ?? 0,
    unclassified: unclassified ?? 0,
  }
}

function buildPrompt(pastIdeas, snapshot) {
  const pastList =
    pastIdeas.length === 0
      ? '(이전 아이디어 없음)'
      : pastIdeas
          .map(
            (p, i) =>
              `${i + 1}. [${p.category}/${p.priority}/${p.status}] ${p.title}${p.dedup_signature ? ` (sig: ${p.dedup_signature})` : ''}`,
          )
          .join('\n')

  const runsSummary =
    Object.entries(snapshot.runsBySource)
      .map(
        ([src, s]) =>
          `  - ${src}: ok=${s.ok ?? 0} partial=${s.partial ?? 0} error=${s.error ?? 0}, total inserted=${s.inserted}, last=${(s.lastAt || '').slice(0, 16)}`,
      )
      .join('\n') || '  (없음)'

  const raw24Summary =
    Object.entries(snapshot.raw24BySource)
      .map(([src, c]) => `  - ${src}: ${c}건`)
      .join('\n') || '  (없음)'

  return `당신은 "${PROJECT}" 프로젝트의 시니어 개선 제안자다. 한 번에 정확히 **하나의 새로운** 기능 개선안을 제안하라.

## 프로젝트 컨텍스트
- 도메인: 한국 위탁 판매 플랫폼 / 트렌드 레이더 / 배대지 비교
- 작업 디렉토리: 현재 cwd (Read/Grep/Glob 으로 둘러봐도 됨)
- 핵심 영역: src/app/admin/ 하위, supabase/*.sql

## 개선 방향 (이 세 축만 고려)
1. **데이터 분석 효과성** — 수집된 raw 시그널을 의미 있는 인사이트로 만드는 방법
2. **시각화** — 수집/분석된 데이터를 어드민에서 더 직관적으로 보이게 만드는 방법
3. **경쟁력있는 상품 발굴** — 분석된 데이터로 위탁 가능한 경쟁력 상품을 찾는 방법

## 지난 7일 Supabase 데이터 스냅샷
- jimscanner_trends_products: 분류 ${snapshot.classified}개 / 미분류 ${snapshot.unclassified}개
- jimscanner_trends_runs (소스별):
${runsSummary}
- 지난 24h jimscanner_market_raw:
${raw24Summary}

## 이전 ${pastIdeas.length}개 아이디어 (반드시 중복 회피 — 표현이 달라도 본질이 같으면 중복)
${pastList}

## 작업 방식
1. 위 컨텍스트와 cwd 의 실제 코드를 Read/Grep/Glob 으로 둘러보아라
2. 특히 src/app/admin/ 하위 페이지 구조, supabase/ DDL, scripts/ 의 cron 흐름을 살펴라
3. 새로운, 구체적이고 액션 가능한 개선안 1개를 찾아라
4. 위 이전 목록과 본질적으로 다른 아이디어여야 한다

## 출력 형식
탐색을 마치면 **최종 응답은 다음 JSON 한 객체만** 출력하라. 다른 텍스트·코드펜스·markdown 금지.

{
  "title": "한 줄 제목 (50자 이내)",
  "category": "data_analysis | visualization | product_discovery | infra | other 중 하나",
  "priority": "high | medium | low 중 하나",
  "description": "구체적 구현 방향 (200-500자, 어떤 파일/테이블/UI 변경이 필요한지)",
  "rationale": "왜 지금 필요한가, 어떤 데이터/현상이 근거인가 (100-300자)",
  "referenced_files": ["관련 파일 경로 0~5개"],
  "dedup_signature": "이 아이디어의 핵심을 5-10자로 요약 (한국어, 중복 비교용)"
}`
}

function callClaudeCli(prompt, cwd) {
  // 모델은 CLI 기본값 사용 (Opus 4.7 1M context — 가장 똑똑).
  // 다른 모델 강제하려면 SCOUT_MODEL env 로 override.
  const model = process.env.SCOUT_MODEL || ''

  // Windows shell:true + Node child stdin pipe 조합이 안정적이지 않아서
  // 프롬프트를 임시 파일에 쓰고 shell redirection 으로 주입.
  const tmpDir = joinPath(tmpdir(), 'jimscanner-scout')
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true })
  const tmpFile = joinPath(
    tmpDir,
    `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`,
  )
  writeFileSync(tmpFile, prompt, 'utf8')

  // claude CLI 가 ANTHROPIC_API_KEY 를 보면 구독(Max) 대신 API 키로 인증.
  // 자식 env 에서 API 키류를 제거해서 claude.ai 구독으로 동작하게 한다.
  const childEnv = { ...process.env }
  delete childEnv.ANTHROPIC_API_KEY
  delete childEnv.ANTHROPIC_AUTH_TOKEN
  delete childEnv.ANTHROPIC_BASE_URL

  return new Promise((resolve, reject) => {
    const modelFlag = model ? `--model ${model}` : ''
    // chcp 65001: spawn 자식 cmd.exe 가 CP949 로 돌아가서 한국어 경로의 claude.exe 를
    // 못 찾는 문제 회피. 같은 cmd.exe 안에서 codepage 전환 후 claude 실행.
    const prefix = process.platform === 'win32' ? 'chcp 65001 >nul && ' : ''
    const cmd = `${prefix}claude -p --output-format json ${modelFlag} --permission-mode bypassPermissions --allowed-tools Read Grep Glob < "${tmpFile.replace(/\\/g, '/')}"`
    const child = spawn(cmd, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
      cwd,
      env: childEnv,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => {
      stdout += d.toString()
    })
    child.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    child.on('error', (err) => {
      try {
        unlinkSync(tmpFile)
      } catch {}
      reject(err)
    })
    child.on('close', (code) => {
      try {
        unlinkSync(tmpFile)
      } catch {}
      if (code !== 0) {
        return reject(new Error(`claude exit=${code}: ${stderr.slice(0, 600) || stdout.slice(0, 600)}`))
      }
      let parsed
      try {
        parsed = JSON.parse(stdout)
      } catch {
        return reject(new Error(`claude stdout not JSON: ${stdout.slice(0, 400)}`))
      }
      if (parsed.is_error) {
        return reject(new Error(`claude is_error: ${(parsed.result || '').slice(0, 400)}`))
      }
      resolve({
        text: typeof parsed.result === 'string' ? parsed.result : '',
        inputTokens: parsed.usage?.input_tokens ?? 0,
        outputTokens: parsed.usage?.output_tokens ?? 0,
        costUsd: parsed.total_cost_usd ?? 0,
        numTurns: parsed.num_turns ?? 0,
        durationMs: parsed.duration_ms ?? 0,
      })
    })
  })
}

function extractFinalJson(text) {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {}
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) {
    try {
      return JSON.parse(fence[1])
    } catch {}
  }
  // last balanced object
  const a = text.lastIndexOf('{')
  const b = text.lastIndexOf('}')
  if (a !== -1 && b > a) {
    try {
      return JSON.parse(text.slice(a, b + 1))
    } catch {}
  }
  return null
}

function normalize(o) {
  if (!o || typeof o !== 'object') return null
  const cats = ['data_analysis', 'visualization', 'product_discovery', 'infra', 'other']
  const prio = ['high', 'medium', 'low']
  const title = String(o.title ?? '').trim().slice(0, 200)
  if (!title) return null
  return {
    title,
    category: cats.includes(o.category) ? o.category : 'other',
    priority: prio.includes(o.priority) ? o.priority : 'medium',
    description: String(o.description ?? '').trim().slice(0, 3000),
    rationale: o.rationale ? String(o.rationale).trim().slice(0, 2000) : null,
    referenced_files: Array.isArray(o.referenced_files)
      ? o.referenced_files.slice(0, 10).map((s) => String(s).slice(0, 300))
      : [],
    dedup_signature: o.dedup_signature ? String(o.dedup_signature).trim().slice(0, 50) : null,
  }
}

function isDuplicate(idea, pastIdeas) {
  const tNew = idea.title.trim().toLowerCase()
  const sNew = (idea.dedup_signature ?? '').trim()
  for (const p of pastIdeas) {
    const tOld = (p.title ?? '').trim().toLowerCase()
    const sOld = (p.dedup_signature ?? '').trim()
    if (tOld && tOld === tNew) return p
    if (sNew && sOld && sNew === sOld) return p
  }
  return null
}

async function logRun(payload) {
  try {
    await sb.from('jimscanner_trends_runs').insert({
      source: SOURCE,
      triggered_by: `local_cli:${PROJECT}`,
      finished_at: new Date().toISOString(),
      ...payload,
    })
  } catch (e) {
    console.error(`  (log insert failed: ${e instanceof Error ? e.message : e})`)
  }
}

async function main() {
  const t0 = Date.now()
  console.log(
    `[${new Date().toISOString()}] improvement-scout start (project=${PROJECT}, cwd=${CWD})`,
  )

  let lastError = null
  let insertedRow = false
  let claudeMeta = null

  try {
    const [pastIdeas, snapshot] = await Promise.all([fetchPastIdeas(), fetchDataSnapshot()])
    console.log(
      `  past ideas: ${pastIdeas.length}, runs sources: ${Object.keys(snapshot.runsBySource).length}, classified=${snapshot.classified}/${snapshot.unclassified}`,
    )

    const prompt = buildPrompt(pastIdeas, snapshot)
    console.log(`  prompt: ${prompt.length} chars; spawning claude with Read/Grep/Glob...`)
    if (process.env.SCOUT_DEBUG_DUMP) {
      const fs = await import('node:fs')
      fs.writeFileSync('logs/scout-prompt-debug.txt', prompt, 'utf8')
      console.log('  prompt dumped to logs/scout-prompt-debug.txt')
    }

    claudeMeta = await callClaudeCli(prompt, CWD)
    console.log(
      `  claude: ${claudeMeta.numTurns} turns, ${claudeMeta.inputTokens}/${claudeMeta.outputTokens} tok, $${claudeMeta.costUsd.toFixed(4)}, ${claudeMeta.durationMs}ms`,
    )

    const idea = normalize(extractFinalJson(claudeMeta.text))
    if (!idea) {
      lastError = `Claude output not parseable. Excerpt: ${claudeMeta.text.slice(0, 300)}`
      console.error(`  ${lastError}`)
    } else {
      const dup = isDuplicate(idea, pastIdeas)
      const status = dup ? 'duplicate' : 'proposed'

      const { error } = await sb.from('jimscanner_improvement_ideas').insert({
        project: PROJECT,
        title: idea.title,
        category: idea.category,
        priority: idea.priority,
        description: idea.description,
        rationale: idea.rationale,
        referenced_files: idea.referenced_files,
        dedup_signature: idea.dedup_signature,
        status,
        cost_usd: claudeMeta.costUsd,
        input_tokens: claudeMeta.inputTokens,
        output_tokens: claudeMeta.outputTokens,
        num_turns: claudeMeta.numTurns,
      })
      if (error) {
        lastError = `Insert failed: ${error.message}`
        console.error(`  ${lastError}`)
      } else {
        insertedRow = true
        console.log(
          `  ✓ inserted: [${idea.category}/${idea.priority}/${status}] ${idea.title}`,
        )
        if (dup) console.log(`    (marked duplicate vs past idea "${dup.title}")`)
      }
    }
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e)
    console.error(`  fatal: ${lastError}`)
  }

  await logRun({
    status: lastError ? (insertedRow ? 'partial' : 'error') : 'ok',
    fetched_count: claudeMeta?.numTurns ?? 0,
    inserted_count: insertedRow ? 1 : 0,
    duration_ms: Date.now() - t0,
    error_message: lastError,
  })

  console.log(`[${new Date().toISOString()}] done in ${Date.now() - t0}ms`)
  if (lastError && !insertedRow) process.exit(1)
}

main()
