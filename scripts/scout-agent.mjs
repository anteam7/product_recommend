/**
 * 쿠팡 소싱 스카우트 두뇌 (로컬 상주) — 확장 채팅의 자연어를 Claude 로 해석해 JSON 명령으로 지휘.
 * work-agent.mjs 포크. 프로토콜: docs/scout-protocol.md
 *
 * 흐름: jimscanner_scout_messages(user, 미처리) 폴링 → claude -p(--resume 세션 연속) →
 *       응답의 ```json {"commands":[...]}``` 블록 → jimscanner_scout_commands insert(queued) →
 *       확장이 실행·결과 적재 → done/failed 명령을 다시 Claude 에 보고(파일 저장 후) → 채팅 응답.
 *
 * 실행(PC 상주): node scripts/scout-agent.mjs
 * 보안: 구독 사용 위해 ANTHROPIC_API_KEY 제거. cwd=레포 루트(bypassPermissions — Claude 가 scout-analyze 직접 실행).
 */
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.join(__dirname, '..')
const env = Object.fromEntries(
  readFileSync(path.join(REPO, '.env.local'), 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); let v = l.slice(i + 1).trim(); if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1); return [l.slice(0, i).trim(), v] }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
const POLL_MS = Number(env.SCOUT_AGENT_POLL_MS || 5000)
const TURN_TIMEOUT_MS = Number(env.SCOUT_AGENT_TIMEOUT_MS || 15 * 60 * 1000)
const CLI_MODEL = /^[\w.-]+$/.test(env.SCOUT_AGENT_MODEL || '') ? env.SCOUT_AGENT_MODEL : 'opus' // shell:true 인자 가드
const DATA_DIR = path.join(REPO, 'data', 'scout')

const VALID_TYPES = new Set(['ping', 'navigate', 'tab', 'search', 'category', 'filter', 'scroll', 'click', 'input',
  'collect_list', 'collect_detail', 'collect_reviews', 'extract_images', 'job_pause', 'job_resume', 'job_stop', 'get_state'])

const RULES = `당신은 "쿠팡 소싱 스카우트"의 두뇌다. 사용자가 크롬 확장 채팅으로 자연어 지시를 보내면, 구조화된 JSON 명령으로 확장(손)에 지시해 쿠팡 수집을 지휘하고, 결과를 분석해 채팅으로 보고한다. 한국어로 간결히 답한다.

[명령 내리는 법]
응답 본문 마지막에 json 코드블록 하나를 붙이면 브리지가 확장에 전달한다:
\`\`\`json
{"commands": [{"type": "collect_list", "payload": {"keyword": "캠핑 의자", "maxPages": 5}}]}
\`\`\`
명령이 필요 없으면(질문 답변 등) json 블록 없이 텍스트만.

[명령 카탈로그] type → payload
- ping {} : 확장 상태 확인
- navigate {url} : 쿠팡 페이지 열기 (검색 딥링크 /np/search 금지 — Akamai 차단)
- search {keyword} : 사람처럼 검색 (검색은 반드시 이걸로)
- category {url} : 카테고리 페이지 이동
- collect_list {keyword? | categoryUrl?, maxPages(≤20, 기본5), maxItems(≤2000), applyFilter?: {minPrice, maxPrice, minReviews, minRating, rocketOnly, excludeRocket}} : 목록 수집(페이지네이션·지연 자동)
- collect_detail {productUrl | productUrls[≤100], include?: ["options","seller","images","delivery","qna"]} : 상세 수집(판매자·옵션·제조사·원산지·이미지)
- collect_reviews {productUrl | productUrls[≤30], maxPages(≤30, 기본5)} : 리뷰 수집(작성일=수요 최근성 분석용)
- extract_images {productUrl | productUrls[]} : 이미지 URL만 추출
- scroll {to: "end"|"top"|px} / click {selector, nth?} / input {selector, text} / tab {action: open|close|activate|list}
- job_pause {} / job_resume {} / job_stop {} : 실행 제어
- get_state {} : 확장 체크포인트 상태

[규칙]
- collect_* 는 고수준 명령: 페이지네이션·지연·재시도·차단복구는 확장이 자율 수행한다. 페이지 단위로 쪼개 지시하지 마라.
- **2026 쿠팡 검색결과는 페이지네이션 없는 단일 뷰(~85건)일 수 있다**: collect_list 결과 summary에 single_view=true와 relatedKeywords[]가 오면, 표본이 더 필요할 때 그 연관 키워드들로 추가 collect_list를 지시해 합산하라(같은 상품은 product_id로 자연 병합). 사용자에게도 "이 키워드는 단일 뷰라 N건이 전부"임을 알려라.
- 확장은 사람처럼 행동한다(페이지 간 8~12초). 수집은 시간이 걸린다 — 명령을 내릴 때 예상 소요를 사용자에게 알려라.
- 수집 완료 보고를 받으면 핵심(건수·가격대·리뷰 분포·주목 상품)을 요약해 사용자에게 알려라. 데이터 파일 경로도 알려라.
- 분석: Bash 로 \`node scripts/scout-analyze.mjs --command <명령id>\` 또는 \`--session <세션id>\` 를 직접 실행해 리포트를 만들고 상위 후보를 보고하라. 원본은 Supabase jimscanner_scout_products / jimscanner_scout_reviews.
- "판매자 적고 수요 있는 상품" 가설 검증 흐름: collect_list → 상위 후보 collect_detail(판매자 확인) + collect_reviews(최근성) → scout-analyze.
- 마켓 등록·구매·발주 등 수집 밖 행동은 하지 말고 사용자에게 안내만 하라.`

// ── claude 실행 (work-agent.mjs 동일 패턴) ──
function runClaude(prompt, resumeSession, onProgress) {
  return new Promise((resolve) => {
    const childEnv = { ...process.env }
    delete childEnv.ANTHROPIC_API_KEY; delete childEnv.ANTHROPIC_AUTH_TOKEN; delete childEnv.ANTHROPIC_BASE_URL
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions', '--model', CLI_MODEL]
    // win32 shell:true — DB 유래 세션id는 형식 검증 후에만 인자로 사용(셸 인젝션 방어)
    if (resumeSession && /^[0-9a-f-]{8,64}$/i.test(resumeSession)) args.unshift('--resume', resumeSession)
    const child = spawn('claude', args, { cwd: REPO, env: childEnv, shell: process.platform === 'win32' })
    let sessionId = resumeSession || null, finalText = '', lastText = '', stderr = ''
    const rl = readline.createInterface({ input: child.stdout })
    rl.on('line', (line) => {
      let m; try { m = JSON.parse(line) } catch { return }
      if (m.session_id) sessionId = m.session_id
      if (m.type === 'assistant' && m.message?.content) {
        for (const b of m.message.content) {
          if (b.type === 'text' && b.text?.trim()) { lastText = b.text; onProgress?.(b.text) }
        }
      } else if (m.type === 'result') { finalText = (m.result || lastText || '').trim() }
    })
    child.stderr.on('data', (d) => { stderr += d.toString() })
    const killer = setTimeout(() => { try { child.kill() } catch { /* noop */ } }, TURN_TIMEOUT_MS)
    child.on('close', (code) => { clearTimeout(killer); resolve({ sessionId, finalText: finalText || lastText, code, stderr }) })
    child.on('error', (e) => { clearTimeout(killer); resolve({ sessionId, finalText: '', code: -1, stderr: String(e) }) })
    try { child.stdin.write(prompt || ''); child.stdin.end() } catch { /* noop */ }
  })
}

// ── 응답 파싱: 마지막 ```json {"commands": [...]}``` 블록 ──
function parseCommands(text) {
  const blocks = [...(text || '').matchAll(/```json\s*([\s\S]*?)```/g)]
  if (!blocks.length) return { body: (text || '').trim(), commands: [], parseError: null }
  const last = blocks[blocks.length - 1]
  let commands = []
  let parseError = null
  try {
    const obj = JSON.parse(last[1])
    const arr = Array.isArray(obj?.commands) ? obj.commands : []
    commands = arr.slice(0, 10).filter((c) => c && VALID_TYPES.has(c.type) && (c.payload === undefined || (typeof c.payload === 'object' && !Array.isArray(c.payload))))
    if (arr.length && !commands.length) parseError = '유효한 명령 없음(type/payload 검증 실패)'
  } catch (e) { parseError = `JSON 파싱 실패: ${String(e.message).slice(0, 120)}` }
  const body = (text || '').replace(last[0], '').trim()
  return { body, commands, parseError }
}

async function postMsg(session_id, role, type, content) {
  if (!content || !String(content).trim()) return
  await sb.from('jimscanner_scout_messages').insert({ session_id, role, type, content: String(content).slice(0, 8000) })
}

// ── 파일 저장 (명령 done 시 — JSON/CSV(BOM)/XLSX) ──
// 수식 인젝션 방어: =,+,-,@ 시작 셀은 ' 접두(외부 수집 데이터가 Excel 수식으로 실행되는 것 방지)
const csvCell = (v) => {
  let s = v == null ? '' : String(v)
  if (/^[=+\-@]/.test(s)) s = `'${s}`
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
function writeCsv(file, rows, cols) {
  const head = cols.join(',')
  const body = rows.map((r) => cols.map((c) => csvCell(typeof r[c] === 'object' && r[c] !== null ? JSON.stringify(r[c]) : r[c])).join(',')).join('\n')
  writeFileSync(file, '﻿' + head + '\n' + body, 'utf8') // BOM — 엑셀 한글 호환
}
async function fetchAll(table, commandId) {
  const out = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from(table).select('*').eq('command_id', commandId).range(from, from + 999)
    if (error) throw new Error(`${table}: ${error.message}`)
    out.push(...(data ?? []))
    if (!data || data.length < 1000) break
  }
  return out
}
async function saveFiles(cmd) {
  if (!['collect_list', 'collect_detail', 'collect_reviews', 'extract_images'].includes(cmd.command_type)) return null
  const products = await fetchAll('jimscanner_scout_products', cmd.id)
  const reviews = cmd.command_type === 'collect_reviews' ? await fetchAll('jimscanner_scout_reviews', cmd.id) : []
  if (!products.length && !reviews.length) return null
  const slug = String(cmd.payload?.keyword || cmd.command_type).replace(/[^\w가-힣]+/g, '-').slice(0, 30)
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)
  const dir = path.join(DATA_DIR, String(cmd.session_id).slice(0, 8), `${ts}-${slug}`)
  mkdirSync(dir, { recursive: true })
  const XLSX = require('xlsx')
  const saved = []
  if (products.length) {
    const cols = ['product_id', 'name', 'price', 'original_price', 'discount_rate', 'rating', 'review_count', 'seller', 'delivery_badge', 'keyword', 'page_no', 'rank_in_page', 'manufacturer', 'origin', 'category_path', 'url', 'image_url']
    writeFileSync(path.join(dir, 'products.json'), JSON.stringify(products, null, 1), 'utf8')
    writeCsv(path.join(dir, 'products.csv'), products, cols)
    const ws = XLSX.utils.json_to_sheet(products.map((p) => Object.fromEntries(cols.map((c) => [c, typeof p[c] === 'object' && p[c] !== null ? JSON.stringify(p[c]) : p[c]]))))
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'products')
    XLSX.writeFile(wb, path.join(dir, 'products.xlsx'))
    saved.push(`products x${products.length}`)
  }
  if (reviews.length) {
    const cols = ['product_id', 'review_date', 'rating', 'content', 'option_text', 'helpful_count']
    writeFileSync(path.join(dir, 'reviews.json'), JSON.stringify(reviews, null, 1), 'utf8')
    writeCsv(path.join(dir, 'reviews.csv'), reviews, cols)
    const ws = XLSX.utils.json_to_sheet(reviews.map((p) => Object.fromEntries(cols.map((c) => [c, p[c]]))))
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'reviews')
    XLSX.writeFile(wb, path.join(dir, 'reviews.xlsx'))
    saved.push(`reviews x${reviews.length}`)
  }
  return { dir: path.relative(REPO, dir), saved, productCount: products.length, reviewCount: reviews.length }
}

// ── 결과 보고문 구성 (Claude 에게 줄 요약) ──
async function describeFinished(cmd) {
  let desc = `[명령 결과] id=${cmd.id} type=${cmd.command_type} status=${cmd.status}`
  if (cmd.error) desc += `\n오류: ${cmd.error}`
  if (cmd.result_summary) desc += `\n요약: ${JSON.stringify(cmd.result_summary).slice(0, 800)}`
  let files = null
  if (cmd.status === 'done') {
    try { files = await saveFiles(cmd) } catch (e) { desc += `\n(파일 저장 실패: ${String(e.message).slice(0, 200)})` }
    if (files) desc += `\n저장: ${files.dir} (${files.saved.join(', ')})`
    if (cmd.command_type === 'collect_list') {
      const { data: top, error: tErr } = await sb.from('jimscanner_scout_products')
        .select('product_id, name, price, review_count, rating, delivery_badge, url')
        .eq('command_id', cmd.id).order('review_count', { ascending: false, nullsFirst: false }).limit(5)
      if (tErr) desc += `\n(상위 상품 조회 실패: ${tErr.message.slice(0, 120)})`
      if (top?.length) desc += `\n리뷰수 상위 5:\n${top.map((t) => `- ${t.name?.slice(0, 40)} | ${t.price?.toLocaleString()}원 | 리뷰 ${t.review_count ?? '-'} | ${t.delivery_badge} | ${t.url}`).join('\n')}`
    }
  }
  return desc
}

// ── 한 세션 턴 실행 ──
async function runTurn(session, userMsgs, finishedCmds) {
  const sid = session.id
  const parts = []
  if (finishedCmds.length) {
    for (const c of finishedCmds) parts.push(await describeFinished(c))
  }
  if (userMsgs.length) parts.push(`[사용자 메시지]\n${userMsgs.map((m) => m.content).join('\n---\n')}`)
  if (!parts.length) return
  const isNew = !session.claude_session_id
  const prompt = isNew ? `${RULES}\n\n[세션 id] ${sid}\n\n${parts.join('\n\n')}` : parts.join('\n\n')

  console.log(`[${new Date().toISOString()}] 세션 ${sid.slice(0, 8)} 턴 (user ${userMsgs.length} · 결과 ${finishedCmds.length}${isNew ? ' · 신규' : ''})`)
  let res = await runClaude(prompt, session.claude_session_id || null, null)
  if (res.code !== 0 && !res.finalText) {
    await postMsg(sid, 'system', 'status', `✗ 두뇌 실행 오류(code ${res.code}) ${res.stderr.slice(0, 200)}`)
    return finalizeTurn(sid, res.sessionId, userMsgs, finishedCmds)
  }
  let { body, commands, parseError } = parseCommands(res.finalText)
  if (parseError) {
    // 형식 오류 → 1회 재요청, 그래도 실패하면 사용자에게 통보(명령 조용한 소실 방지)
    const retry = await runClaude(`명령 json 블록 형식 오류(${parseError}). {"commands":[{"type":"...","payload":{...}}]} 형식의 json 코드블록으로 다시 출력하라.`, res.sessionId, null)
    if (retry.finalText) { res = retry; ({ body, commands, parseError } = parseCommands(retry.finalText)) }
    if (parseError) await postMsg(sid, 'system', 'status', `⚠ 두뇌 명령 형식 오류로 이번 지시가 실행되지 않았습니다(${parseError}) — 다시 말해주세요`)
  }
  if (body) await postMsg(sid, 'brain', 'chat', body)
  if (commands.length) {
    const rows = commands.map((c) => ({ session_id: sid, command_type: c.type, payload: c.payload ?? {} }))
    const { error } = await sb.from('jimscanner_scout_commands').insert(rows)
    if (error) await postMsg(sid, 'system', 'status', `✗ 명령 등록 실패: ${error.message}`)
    else await postMsg(sid, 'system', 'status', `→ 확장에 명령 ${commands.length}건 전달 (${commands.map((c) => c.type).join(', ')})`)
  }
  await finalizeTurn(sid, res.sessionId, userMsgs, finishedCmds)
}

async function finalizeTurn(sid, claudeSessionId, userMsgs, finishedCmds) {
  const now = new Date().toISOString()
  if (claudeSessionId) await sb.from('jimscanner_scout_sessions').update({ claude_session_id: claudeSessionId, updated_at: now }).eq('id', sid)
  if (userMsgs.length) await sb.from('jimscanner_scout_messages').update({ brain_seen_at: now }).in('id', userMsgs.map((m) => m.id))
  if (finishedCmds.length) await sb.from('jimscanner_scout_commands').update({ brain_notified_at: now }).in('id', finishedCmds.map((c) => c.id))
}

// ── 메인 루프 ──
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
console.log(`scout-agent 가동: 폴링 ${POLL_MS}ms · model=${CLI_MODEL} · cwd=${REPO}`)
for (;;) {
  try {
    // 처리할 세션 찾기: 미처리 user 메시지 또는 미보고 완료 명령 (DB 오류는 조용히 넘기지 않는다)
    const { data: unseen, error: uErr } = await sb.from('jimscanner_scout_messages')
      .select('id, session_id, content, created_at').eq('role', 'user').is('brain_seen_at', null)
      .order('created_at', { ascending: true }).limit(20)
    if (uErr) throw new Error(`messages 폴링: ${uErr.message}`)
    const { data: finished, error: fErr } = await sb.from('jimscanner_scout_commands')
      .select('id, session_id, command_type, payload, status, error, result_summary')
      .in('status', ['done', 'failed', 'cancelled']).is('brain_notified_at', null)
      .order('ended_at', { ascending: true }).limit(10)
    if (fErr) throw new Error(`commands 폴링: ${fErr.message}`)

    const sessionIds = [...new Set([...(unseen ?? []).map((m) => m.session_id), ...(finished ?? []).map((c) => c.session_id)])]
    if (!sessionIds.length) { await sleep(POLL_MS); continue }

    const sid = sessionIds[0] // 세션 단위 직렬 처리
    const { data: session, error: sErr } = await sb.from('jimscanner_scout_sessions').select('*').eq('id', sid).single()
    if (sErr && sErr.code !== 'PGRST116') throw new Error(`session 조회: ${sErr.message}`) // 일시 오류 — 커서 보존
    if (!session) {
      // 진짜 고아 데이터(세션 삭제됨) — 커서만 밀어 무한루프 방지
      await finalizeTurn(sid, null, (unseen ?? []).filter((m) => m.session_id === sid), (finished ?? []).filter((c) => c.session_id === sid))
      continue
    }
    await runTurn(session, (unseen ?? []).filter((m) => m.session_id === sid), (finished ?? []).filter((c) => c.session_id === sid))
  } catch (e) {
    console.error('루프 오류:', e instanceof Error ? e.message : e)
    await sleep(POLL_MS)
  }
}
