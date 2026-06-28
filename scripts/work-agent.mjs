/**
 * 원격 작업 지시 실행기 (로컬 상주) — 어드민 콘솔의 자유형 지시를 Claude로 자율 실행.
 *
 * 흐름: jimscanner_work_instructions 큐 폴링 → claude -p(자율, bypassPermissions)로 실행
 *       → 진행을 events 스레드에 게시 → 위험·결정 시 에이전트가 [[ESCALATE]] → 정지(escalated)
 *       → 사장님이 콘솔에서 답변(reply, status=resuming) → claude --resume 로 재개 → [[DONE]] 결과.
 *
 * 실행(PC 상주): node --env-file=.env.local scripts/work-agent.mjs
 * 보안: 구독 사용 위해 ANTHROPIC_API_KEY 제거. cwd=레포 루트. bypassPermissions 라 에스컬레이션 규칙이 안전장치.
 */
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(__dirname, '..')
const env = Object.fromEntries(
  readFileSync(path.join(REPO, '.env.local'), 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const POLL_MS = Number(env.WORK_AGENT_POLL_MS || 5000)
const TURN_TIMEOUT_MS = Number(env.WORK_AGENT_TIMEOUT_MS || 30 * 60 * 1000) // 한 턴 최대 30분

// 자율 + 위험·결정만 에스컬레이션. claude --append-system-prompt 로 매 호출에 적용.
const RULES = [
  '당신은 오픈마켓 셀러 자동화 레포(cwd=레포 루트)에서 사장님의 작업 지시를 자율 실행하는 에이전트다. 한국어로 보고한다.',
  '- 읽기·검색·분석·스크립트 실행·파일 수정은 자율로 진행한다.',
  '- 아래는 실행하지 말고 반드시 멈추고 에스컬레이션한다(사장님 결정 필요):',
  '  ① 되돌리기 어려운 행동: git commit/push, 쿠팡·네이버 등 마켓 등록/수정/가격변경, 외부 주문·발송, 결제, DB 파괴적 변경, 비용 발생.',
  '  ② 가격·상품명·소싱 채택 등 사업 판단. ③ 지시가 모호하거나 해석이 갈릴 때.',
  '- 진행 중 무엇을 왜 하는지 간결히 설명한다.',
  '- 매 턴의 맨 마지막 줄에 반드시 정확히 하나의 마커를 단다:',
  '  [[DONE]] 한줄요약   — 지시 완료',
  '  [[ESCALATE]] 질문    — 결정/확인 필요(여기서 멈춤, 실행 보류)',
  '  [[FAILED]] 이유      — 진행 불가',
  '  한 턴에 안 끝나면 [[ESCALATE]]로 중간보고하라. 마커가 없으면 미완으로 간주한다.',
].join('\n')

async function evt(instruction_id, role, type, content) {
  if (!content || !String(content).trim()) return
  await sb.from('jimscanner_work_instruction_events').insert({ instruction_id, role, type, content: String(content).slice(0, 8000) })
}
async function setStatus(id, patch) { await sb.from('jimscanner_work_instructions').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id) }

// 다음 작업 1건 점유(queued=신규 / resuming=답변 후 재개)
async function claimNext() {
  const { data } = await sb.from('jimscanner_work_instructions').select('*').in('status', ['queued', 'resuming']).order('priority', { ascending: false }).order('created_at', { ascending: true }).limit(1)
  const job = data?.[0]
  if (!job) return null
  const { data: upd } = await sb.from('jimscanner_work_instructions').update({ status: 'running', started_at: job.started_at || new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', job.id).eq('status', job.status).select()
  return upd?.[0] ? { ...upd[0], prevStatus: job.status } : null // 경합 시 null
}

// claude 한 턴 실행(프롬프트는 stdin 전달) → {sessionId, finalText, code, stderr}
function runClaude(prompt, resumeSession, onProgress) {
  return new Promise((resolve) => {
    const childEnv = { ...process.env }
    delete childEnv.ANTHROPIC_API_KEY; delete childEnv.ANTHROPIC_AUTH_TOKEN; delete childEnv.ANTHROPIC_BASE_URL
    // RULES는 stdin 프롬프트에 포함(멀티라인 인자를 win32 shell에 넘기면 깨짐). args는 단순 플래그만.
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions']
    if (resumeSession) args.unshift('--resume', resumeSession)
    const child = spawn('claude', args, { cwd: REPO, env: childEnv, shell: process.platform === 'win32' })
    let sessionId = resumeSession || null, finalText = '', lastText = '', stderr = ''
    const rl = readline.createInterface({ input: child.stdout })
    rl.on('line', (line) => {
      let m; try { m = JSON.parse(line) } catch { return }
      if (m.session_id) sessionId = m.session_id
      if (m.type === 'assistant' && m.message?.content) {
        for (const b of m.message.content) {
          if (b.type === 'text' && b.text?.trim()) { lastText = b.text; onProgress?.(b.text) }
          else if (b.type === 'tool_use') onProgress?.(`🔧 ${b.name}: ${JSON.stringify(b.input || {}).slice(0, 140)}`)
        }
      } else if (m.type === 'result') { finalText = (m.result || lastText || '').trim() }
    })
    child.stderr.on('data', (d) => { stderr += d.toString() })
    const killer = setTimeout(() => { try { child.kill() } catch { /* noop */ } }, TURN_TIMEOUT_MS)
    child.on('close', (code) => { clearTimeout(killer); resolve({ sessionId, finalText: finalText || lastText, code, stderr }) })
    child.on('error', (e) => { clearTimeout(killer); resolve({ sessionId, finalText: '', code: -1, stderr: String(e) }) })
    try { child.stdin.write(prompt || ''); child.stdin.end() } catch { /* noop */ } // 프롬프트 stdin 전달
  })
}

function parseMarker(text) {
  const m = [...(text || '').matchAll(/\[\[(DONE|ESCALATE|FAILED)\]\]\s*(.*)$/gm)].pop()
  return m ? { kind: m[1], msg: (m[2] || '').trim() } : null
}
const stripMarker = (t) => (t || '').replace(/\[\[(DONE|ESCALATE|FAILED)\]\].*$/m, '').trim()

async function runJob(job) {
  const id = job.id
  let prompt, resumeSession = null
  if (job.prevStatus === 'resuming' && job.session_id) {
    resumeSession = job.session_id
    const { data: ev } = await sb.from('jimscanner_work_instruction_events').select('content').eq('instruction_id', id).eq('type', 'reply').order('created_at', { ascending: false }).limit(1)
    prompt = ev?.[0]?.content || '계속 진행해.'
    await evt(id, 'system', 'status', '↻ 답변 받고 재개합니다…')
  } else {
    prompt = `${RULES}\n\n=== 작업 지시 ===\n${job.instruction || ''}`
    await evt(id, 'system', 'status', '▶ 실행 시작…')
  }

  const res = await runClaude(prompt, resumeSession, (text) => { evt(id, 'agent', 'progress', text).catch(() => {}) })

  const marker = parseMarker(res.finalText)
  const body = stripMarker(res.finalText)
  if (body) await evt(id, 'agent', marker?.kind === 'ESCALATE' ? 'escalation' : 'result', body)

  if (!marker && res.code !== 0) { await evt(id, 'system', 'status', `✗ 실행 오류(code ${res.code}) ${res.stderr.slice(0, 300)}`); await setStatus(id, { status: 'failed', ended_at: new Date().toISOString(), error: res.stderr.slice(0, 1000), session_id: res.sessionId }) ; return }

  if (marker?.kind === 'ESCALATE') { await evt(id, 'agent', 'escalation', marker.msg); await setStatus(id, { status: 'escalated', session_id: res.sessionId }) }
  else if (marker?.kind === 'FAILED') { await setStatus(id, { status: 'failed', ended_at: new Date().toISOString(), error: marker.msg, session_id: res.sessionId }) }
  else { await setStatus(id, { status: 'done', ended_at: new Date().toISOString(), result: marker?.msg || body || '완료', session_id: res.sessionId }) }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
console.log(`work-agent 가동: 큐 폴링 ${POLL_MS}ms · cwd=${REPO}`)
for (;;) {
  try { const job = await claimNext(); if (job) { console.log(`[${new Date().toISOString()}] 작업 ${job.id} (${job.prevStatus})`); await runJob(job) } else await sleep(POLL_MS) }
  catch (e) { console.error('루프 오류:', e instanceof Error ? e.message : e); await sleep(POLL_MS) }
}
