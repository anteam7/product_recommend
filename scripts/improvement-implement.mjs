#!/usr/bin/env node
/**
 * Improvement Implementer — 시간당 1회 proposed 아이디어 1개를
 * Claude Code CLI agentic 모드로 실제 구현하는 cron.
 * 기본 대상: product_recommend (이 레포). --project 로 변경 가능.
 *
 * 안전 장치:
 *  - main 브랜치 직접 수정 절대 금지 (항상 feature branch 에서 작업)
 *  - working tree 가 dirty 면 skip
 *  - npm run build 통과해야 푸시 + status=done
 *  - 실패 시 git reset --hard + branch 삭제 + status=rejected
 *  - 15분 timeout (Task Scheduler 가 enforce)
 *
 * 사용법:
 *   node --env-file=.env.local scripts/improvement-implement.mjs
 *
 * 환경변수:
 *   IMPLEMENT_MODEL    (기본: 전역 ~/.claude/settings.json 모델. .cmd 래퍼가 opus 로 지정)
 *   IMPLEMENT_TIMEOUT  (기본: 720000ms = 12분 — Task Scheduler 15분 보다 짧게)
 */

import { createClient } from '@supabase/supabase-js'
import { spawn, execSync } from 'node:child_process'
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'

// CLI args (모두 기본값 = product_recommend 호환)
const args = process.argv.slice(2)
function getArg(name, fallback) {
  const direct = args.find((a) => a.startsWith(`--${name}=`))
  if (direct) return direct.slice(name.length + 3)
  const idx = args.indexOf(`--${name}`)
  if (idx !== -1 && args[idx + 1]) return args[idx + 1]
  return fallback
}

const PROJECT = getArg('project', 'product_recommend')
const REPO_DIR = getArg('repo', 'C:/Web/jimscanner-personal')
const MAIN_BRANCH = getArg('main-branch', 'main')
const REMOTE = getArg('remote', 'origin')
const SOURCE_LABEL = 'improvement_implementer'
const CLAUDE_TIMEOUT_MS = Number(process.env.IMPLEMENT_TIMEOUT) || 720000 // 12분

if (!['product_recommend', 'jimscanner'].includes(PROJECT)) {
  console.error(`Invalid --project: ${PROJECT} (expected product_recommend | jimscanner)`)
  process.exit(1)
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })

function git(args, opts = {}) {
  return execSync(`git ${args}`, { cwd: REPO_DIR, encoding: 'utf8', ...opts }).trim()
}

function tryGit(args, opts = {}) {
  try {
    return { ok: true, out: git(args, opts) }
  } catch (e) {
    return { ok: false, err: e.message }
  }
}

function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 40)
}

async function fetchNextProposedIdea() {
  // priority high → medium → low, then oldest first.
  // 'priority' 는 text 라 CASE 로 정렬.
  const { data } = await sb
    .from('jimscanner_improvement_ideas')
    .select('id, title, category, priority, description, rationale, referenced_files, generated_at')
    .eq('project', PROJECT)
    .eq('status', 'proposed')
    .order('generated_at', { ascending: true })
    .limit(50)
  if (!data || data.length === 0) return null
  const rank = { high: 0, medium: 1, low: 2 }
  data.sort((a, b) => (rank[a.priority] ?? 9) - (rank[b.priority] ?? 9))
  return data[0]
}

async function lockIdea(id) {
  // optimistic lock: only succeed if status is still 'proposed'
  const { data, error } = await sb
    .from('jimscanner_improvement_ideas')
    .update({ status: 'in_progress', processing_started_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'proposed')
    .select('id')
  if (error) throw new Error(`lock failed: ${error.message}`)
  return data && data.length > 0
}

async function markIdeaDone(id, branch, commit) {
  await sb
    .from('jimscanner_improvement_ideas')
    .update({
      status: 'done',
      implementation_branch: branch,
      implementation_commit: commit,
      implementation_error: null,
    })
    .eq('id', id)
}

async function markIdeaRejected(id, error, branch = null) {
  await sb
    .from('jimscanner_improvement_ideas')
    .update({
      status: 'rejected',
      implementation_branch: branch,
      implementation_error: String(error).slice(0, 2000),
    })
    .eq('id', id)
}

async function logRun(payload) {
  try {
    await sb.from('jimscanner_trends_runs').insert({
      source: SOURCE_LABEL,
      triggered_by: `local_cli:${PROJECT}`,
      finished_at: new Date().toISOString(),
      ...payload,
    })
  } catch (e) {
    console.error(`  (log insert failed: ${e instanceof Error ? e.message : e})`)
  }
}

function buildPrompt(idea) {
  const files =
    idea.referenced_files && idea.referenced_files.length
      ? '\n- 참조 파일:\n' + idea.referenced_files.map((f) => `  - ${f}`).join('\n')
      : ''
  return `당신은 위 작업 디렉토리에서 한 가지 개선안을 실제로 **구현** 하는 시니어 엔지니어다.
사람의 검토 없이 자율적으로 코드를 작성하고 빌드를 통과시켜야 한다.

## 구현할 아이디어

**제목**: ${idea.title}
**카테고리**: ${idea.category} / 우선순위: ${idea.priority}

**구현 방향**:
${idea.description}

${idea.rationale ? `**근거**:\n${idea.rationale}\n` : ''}${files}

## 작업 지시 (반드시 따를 것)

1. cwd 의 코드를 Read/Grep/Glob 으로 충분히 둘러보고 시작하라
2. 작업은 **이미 새로 생성된 feature branch** 에서 진행 중이다 (main 아님). 안심하고 변경하라
3. 필요한 파일을 Edit/Write 로 수정·생성하라
4. SQL 마이그레이션이 필요하면 supabase/ 에 .sql 파일을 생성하라 (실제 DB 에 적용은 사람이 한다 — 코드는 마이그레이션 후 상태를 가정해도 됨. 단 \`as any\` 캐스팅 필요)
5. **반드시 \`npm run build\` 가 통과해야 한다**. Bash 로 직접 실행해서 확인하라
6. 변경 후 커밋: 자신이 수정·생성한 파일만 **명시적으로** \`git add <path1> <path2> ...\` 로 추가한 뒤 \`git commit -m "<설명>"\` 하라. **\`git add -A\` / \`git add .\` 절대 금지** — 이 레포는 .gitignore 안 된 untracked 분석 md/sql 가 100+개 있어서 같이 커밋되면 안 된다
7. 새 종속성 추가는 가능하면 피해라. 꼭 필요하면 \`npm install\` 후 package.json + package-lock.json 만 명시적으로 add
8. **금지**: \`git push\`, \`git reset --hard\`, \`git checkout main\`, \`git rebase\`, \`git merge\` — 외부 영향 있는 git 명령. 푸시는 호출 측에서 한다
9. **금지**: 어드민 페이지의 인증 우회 / RLS 우회 / .env.local 노출 변경
10. 완료 시 빈 텍스트 한 줄로 끝내라 (마지막 메시지로 "구현 완료. 커밋: <sha>" 정도)

## 시간

총 12분 안에 끝내야 한다. 못 하면 부분 구현이라도 빌드 통과시키고 커밋하라.

이제 시작.`
}

function callClaudeAgenticImplement(prompt, cwd) {
  const model = process.env.IMPLEMENT_MODEL || ''
  const childEnv = { ...process.env }
  delete childEnv.ANTHROPIC_API_KEY
  delete childEnv.ANTHROPIC_AUTH_TOKEN
  delete childEnv.ANTHROPIC_BASE_URL

  const tmpDir = joinPath(tmpdir(), 'jimscanner-implement')
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true })
  const tmpFile = joinPath(
    tmpDir,
    `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`,
  )
  writeFileSync(tmpFile, prompt, 'utf8')

  return new Promise((resolve, reject) => {
    const modelFlag = model ? `--model ${model}` : ''
    // chcp 65001: spawn 자식 cmd.exe 가 CP949 로 돌아가서 한국어 경로의 claude.exe 를
    // 못 찾는 문제 회피. 같은 cmd.exe 안에서 codepage 전환 후 claude 실행.
    const prefix = process.platform === 'win32' ? 'chcp 65001 >nul && ' : ''
    const cmd = `${prefix}claude -p --output-format json ${modelFlag} --permission-mode bypassPermissions --allowed-tools Read Write Edit Grep Glob Bash < "${tmpFile.replace(/\\/g, '/')}"`
    const child = spawn(cmd, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
      cwd,
      env: childEnv,
    })
    let stdout = ''
    let stderr = ''
    let killed = false
    const killTimer = setTimeout(() => {
      killed = true
      try {
        child.kill('SIGKILL')
      } catch {}
    }, CLAUDE_TIMEOUT_MS)
    child.stdout.on('data', (d) => {
      stdout += d.toString()
    })
    child.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    child.on('error', (err) => {
      clearTimeout(killTimer)
      try {
        unlinkSync(tmpFile)
      } catch {}
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(killTimer)
      try {
        unlinkSync(tmpFile)
      } catch {}
      if (killed) {
        return reject(new Error(`claude killed after ${CLAUDE_TIMEOUT_MS}ms timeout`))
      }
      if (code !== 0) {
        return reject(
          new Error(`claude exit=${code}: ${stderr.slice(0, 600) || stdout.slice(0, 600)}`),
        )
      }
      let parsed
      try {
        parsed = JSON.parse(stdout)
      } catch {
        return reject(new Error(`claude stdout not JSON: ${stdout.slice(0, 400)}`))
      }
      if (parsed.is_error) {
        return reject(
          new Error(`claude is_error: ${(parsed.result || '').slice(0, 400)}`),
        )
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

async function main() {
  const t0 = Date.now()
  console.log(`[${new Date().toISOString()}] improvement-implement start`)

  // ────────────────────────────────────────────────────────────
  // 1. 안전 체크: working tree 깨끗한가? + main 브랜치인가?
  // (untracked 파일은 무시 — 이 프로젝트는 .gitignore 안 된 분석 md, supabase sql 다수.
  //  tracked 파일 modification 만 진짜 위험)
  // ────────────────────────────────────────────────────────────
  const status = tryGit('status --porcelain --untracked-files=no')
  if (!status.ok) {
    await logRun({ status: 'error', error_message: `git status failed: ${status.err}`, duration_ms: Date.now() - t0 })
    console.error('  git status failed:', status.err)
    process.exit(1)
  }
  if (status.out) {
    await logRun({ status: 'ok', error_message: 'skip: tracked files modified', duration_ms: Date.now() - t0 })
    console.log('  skip: tracked files modified (user is working)')
    console.log(status.out.slice(0, 500))
    return
  }

  const currentBranch = tryGit('rev-parse --abbrev-ref HEAD')
  if (!currentBranch.ok || currentBranch.out !== MAIN_BRANCH) {
    await logRun({
      status: 'ok',
      error_message: `skip: not on ${MAIN_BRANCH} (current: ${currentBranch.out})`,
      duration_ms: Date.now() - t0,
    })
    console.log(`  skip: not on ${MAIN_BRANCH} (current: ${currentBranch.out})`)
    return
  }

  // main 을 최신 상태로 (origin pull 실패해도 진행 — 네트워크 불안정 케이스)
  const pull = tryGit(`pull --ff-only ${REMOTE} ${MAIN_BRANCH}`)
  if (!pull.ok) {
    console.log(`  warn: pull failed (continuing): ${pull.err.slice(0, 200)}`)
  }

  // ────────────────────────────────────────────────────────────
  // 2. 아이디어 선택 + 락
  // ────────────────────────────────────────────────────────────
  const idea = await fetchNextProposedIdea()
  if (!idea) {
    await logRun({ status: 'ok', error_message: 'no proposed idea', duration_ms: Date.now() - t0 })
    console.log('  no proposed idea — nothing to do')
    return
  }
  console.log(`  candidate: [${idea.category}/${idea.priority}] ${idea.title}`)
  console.log(`    id=${idea.id}, generated_at=${idea.generated_at}`)

  const locked = await lockIdea(idea.id)
  if (!locked) {
    await logRun({ status: 'ok', error_message: 'lock contention (status changed)', duration_ms: Date.now() - t0 })
    console.log('  lock contention — another process or status changed; skip')
    return
  }

  // ────────────────────────────────────────────────────────────
  // 3. 새 feature branch 생성
  // ────────────────────────────────────────────────────────────
  const idShort = idea.id.split('-')[0]
  const slug = slugify(idea.title) || 'improvement'
  const branch = `auto/improvement-${idShort}-${slug}`
  const createBranch = tryGit(`checkout -b ${branch}`)
  if (!createBranch.ok) {
    await markIdeaRejected(idea.id, `branch create failed: ${createBranch.err}`)
    await logRun({ status: 'error', error_message: createBranch.err, duration_ms: Date.now() - t0 })
    console.error('  branch create failed:', createBranch.err)
    process.exit(1)
  }
  console.log(`  branch: ${branch}`)

  // ────────────────────────────────────────────────────────────
  // 4. Claude 호출 (full tools)
  // ────────────────────────────────────────────────────────────
  let claudeMeta = null
  let lastError = null
  try {
    const prompt = buildPrompt(idea)
    console.log(`  prompt: ${prompt.length} chars; spawning claude (full tools)...`)
    claudeMeta = await callClaudeAgenticImplement(prompt, REPO_DIR)
    console.log(
      `  claude: ${claudeMeta.numTurns} turns, ${claudeMeta.inputTokens}/${claudeMeta.outputTokens} tok, $${claudeMeta.costUsd.toFixed(4)}, ${claudeMeta.durationMs}ms`,
    )
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e)
    console.error('  claude failed:', lastError)
  }

  // ────────────────────────────────────────────────────────────
  // 5. 검증: 새 커밋이 생겼나? + npm run build 통과?
  // ────────────────────────────────────────────────────────────
  let buildOk = false
  let newCommit = null

  if (!lastError) {
    // 새 커밋 SHA 확인 (main 과 다른가)
    const mainSha = tryGit(`rev-parse ${MAIN_BRANCH}`).out
    const headSha = tryGit('rev-parse HEAD').out
    if (mainSha === headSha) {
      lastError = 'no commits made by claude'
    } else {
      newCommit = headSha
      console.log(`  new commits exist, head=${headSha.slice(0, 8)}`)

      // 빌드 검증
      console.log('  running npm run build...')
      try {
        execSync('npm run build', {
          cwd: REPO_DIR,
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 240000,
        })
        buildOk = true
        console.log('  ✓ build passed')
      } catch (e) {
        const stderr = e.stderr?.toString?.() ?? ''
        const stdout = e.stdout?.toString?.() ?? ''
        lastError = `npm run build failed: ${(stderr || stdout).slice(-800)}`
        console.error('  ✗ build failed')
      }
    }
  }

  // ────────────────────────────────────────────────────────────
  // 6a. 성공: push + status=done
  // ────────────────────────────────────────────────────────────
  if (buildOk && !lastError) {
    const push = tryGit(`push -u ${REMOTE} ${branch}`)
    if (push.ok) {
      console.log(`  ✓ pushed ${branch}`)
      await markIdeaDone(idea.id, branch, newCommit)
      tryGit(`checkout ${MAIN_BRANCH}`)
      const duration = Date.now() - t0
      await logRun({
        status: 'ok',
        fetched_count: claudeMeta?.numTurns ?? 0,
        inserted_count: 1,
        duration_ms: duration,
      })
      console.log(
        `[${new Date().toISOString()}] done — implemented "${idea.title}" in ${duration}ms`,
      )
      return
    } else {
      lastError = `push failed: ${push.err}`
      console.error('  push failed:', push.err)
    }
  }

  // ────────────────────────────────────────────────────────────
  // 6b. 실패: 롤백 + status=rejected
  // ────────────────────────────────────────────────────────────
  console.log(`  rolling back due to: ${lastError}`)
  tryGit(`checkout ${MAIN_BRANCH}`)
  tryGit(`branch -D ${branch}`)
  await markIdeaRejected(idea.id, lastError, branch)
  await logRun({
    status: 'error',
    fetched_count: claudeMeta?.numTurns ?? 0,
    inserted_count: 0,
    duration_ms: Date.now() - t0,
    error_message: lastError,
  })
  console.log(`[${new Date().toISOString()}] rejected "${idea.title}"`)
  process.exit(1)
}

main().catch(async (e) => {
  const msg = e instanceof Error ? e.message : String(e)
  console.error('[fatal]', msg)
  await logRun({ status: 'error', error_message: msg, duration_ms: 0 })
  process.exit(1)
})
