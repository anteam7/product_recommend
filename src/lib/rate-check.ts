import { createAdminClient } from '@/lib/auth/admin-supabase'

const MODEL = 'gemini-2.5-flash'
const CONCURRENCY = 4
const PAGE_TEXT_LIMIT = 40000
const FETCH_TIMEOUT_MS = 20000

type Forwarder = {
  id: string
  slug: string
  name: string
  rate_page_url: string | null
  website: string | null
}

export type ExtractedRate = {
  country: 'US' | 'JP' | 'CN' | string
  center_name: string | null
  grade_level: number
  member_grade: string | null
  weight_min: number
  weight_max: number
  price_krw: number | null
  price_usd: number | null
  price_jpy: number | null
  shipping_type: string | null
}

export type CheckStatus = 'extracted' | 'no_rates_found' | 'error' | 'skipped'

type SingleCheckResult = {
  forwarder_id: string
  forwarder_slug: string
  forwarder_name: string
  status: CheckStatus
  extracted_rates: ExtractedRate[] | null
  extracted_count: number
  ai_summary: string | null
  ai_raw_response: string | null
  page_url: string | null
  page_size_bytes: number | null
  error_message: string | null
}

/**
 * 테이블 구조 보존형 HTML 스트리퍼. 요금표는 공간적 구조가 중요하므로
 * <tr>/<td>/<th>/<br>/블록 요소 경계에 줄바꿈·구분자를 남김.
 */
function stripHtmlPreservingTables(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(tr|p|div|li|h[1-6])>/gi, '\n')
    .replace(/<\/(td|th)>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function fetchOneUrl(url: string): Promise<{ text: string; bytes: number }> {
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (compatible; jimscanner-bot/1.0; +https://jimscanner.co.kr/about)',
      Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const buf = await res.arrayBuffer()
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf)
  const broken = (utf8.match(/\uFFFD/g) ?? []).length
  const html = broken > 50 ? Buffer.from(buf).toString('latin1') : utf8
  return {
    text: stripHtmlPreservingTables(html),
    bytes: buf.byteLength,
  }
}

function splitRatePageUrls(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((u) => u.trim())
    .filter((u) => u.length > 0)
}

/**
 * 여러 URL(쉼표/개행 구분) 지원. 각 URL을 fetch 해서 텍스트를 하나로 합침.
 * 국가별로 페이지가 나뉘어 있는 배대지 대응.
 */
async function fetchPageText(rawUrls: string): Promise<{ text: string; bytes: number }> {
  const urls = splitRatePageUrls(rawUrls)
  if (urls.length === 0) throw new Error('요금 페이지 URL이 비어있음')

  if (urls.length === 1) {
    const { text, bytes } = await fetchOneUrl(urls[0])
    return { text: text.slice(0, PAGE_TEXT_LIMIT), bytes }
  }

  const sections: string[] = []
  let totalBytes = 0
  const errors: string[] = []
  // 동일 페이지 여러 장이라 직렬 fetch (서버 부담 최소화)
  for (const url of urls) {
    try {
      const { text, bytes } = await fetchOneUrl(url)
      totalBytes += bytes
      sections.push(`=== 페이지: ${url} ===\n${text}`)
    } catch (err) {
      errors.push(`${url}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (sections.length === 0) {
    throw new Error(`모든 URL fetch 실패: ${errors.join(' | ')}`)
  }

  // 페이지당 할당량 균등 분배
  const perPageLimit = Math.floor(PAGE_TEXT_LIMIT / sections.length)
  const truncated = sections.map((s) => s.slice(0, perPageLimit))
  const joined = truncated.join('\n\n')
  return { text: joined.slice(0, PAGE_TEXT_LIMIT), bytes: totalBytes }
}

const SYSTEM_PROMPT = `당신은 한국 배대지(해외배송 대행) 사이트의 요금표 페이지에서 배송 요금 데이터를 추출하는 도우미입니다.
주어진 페이지 텍스트를 읽고, 국가·센터·회원등급·무게구간 별 요금을 구조화 JSON 으로 추출하세요.

필드 정의:
- country: "US" (미국), "JP" (일본), "CN" (중국) 세 값 중 하나만 허용. 다른 국가는 제외.
- center_name: 센터 이름이 명시되면 그대로 (예: "오리건", "뉴저지", "도쿄", "상해"). 단일 센터·기본값이면 null.
- grade_level: 회원등급 숫자 (1=일반/기본, 2=실버, 3=골드, 4=VIP, 5=VVIP). 등급 구분 없으면 1.
- member_grade: 등급 명칭이 명시되면 (예: "일반", "VIP", "GOLD"). 없으면 "일반".
- weight_min, weight_max: kg 단위 숫자. "1kg ~ 1.5kg" 구간이면 1.0 과 1.5. "0.5kg 단위" 테이블이면 각 구간으로 분리.
- price_krw: 원화 가격(정수). 원화 표기가 없으면 null.
- price_usd: 달러 가격(소수 가능). 달러 표기가 없으면 null.
- price_jpy: 엔화 가격(정수). 엔화 표기가 없으면 null.
- shipping_type: "air" (항공) / "sea" (해운) / null. 구분 없으면 null.

추출 원칙:
- 반드시 페이지 텍스트에 명시된 숫자만 사용. 추측·보간 금지.
- 단일 "무게 → 가격" 만 있으면 weight_min = weight_max = 그 값.
- 가격이 "원", "₩", "KRW" 와 함께 표기되면 price_krw. "USD", "$" 와 함께면 price_usd.
- 같은 구간에 여러 국가 또는 여러 등급이 한 표에 섞여 있으면 각각 분리해서 별도 행으로 추출.
- "부가세", "택배비", "관세", "수수료" 등은 제외. 순수 "배송비" 만.
- 무게가 아닌 "부피" 기반 요금(DIM), 가격이 "문의" 또는 "별도" 로 표시된 경우 해당 행은 추출하지 않음.

출력 JSON:
{
  "rates": [ { country, center_name, grade_level, member_grade, weight_min, weight_max, price_krw, price_usd, price_jpy, shipping_type }, ... ],
  "note": "페이지 파싱 상 주의사항 1~2문장 (한국어)"
}

rates 배열은 최대한 많이. 단 중복 제거. 페이지에 요금 정보가 전혀 없으면 rates 를 빈 배열로 반환하고 note 에 사유 명시.`

async function callGemini(
  apiKey: string,
  forwarderName: string,
  pageUrl: string,
  pageText: string,
): Promise<{ rates: ExtractedRate[]; note: string; rawResponse: string }> {
  const userPrompt = `배대지 이름: ${forwarderName}
요금 페이지 URL: ${pageUrl}

--- 페이지에서 추출한 텍스트 (테이블 구조 보존) ---
${pageText}
--- 끝 ---

위 텍스트에서 국가·센터·회원등급·무게 별 배송 요금을 추출해 지정된 JSON 으로 반환.`

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.1,
          maxOutputTokens: 32768,
        },
      }),
    },
  )
  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Gemini ${res.status}: ${errText.slice(0, 300)}`)
  }
  const json = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[]
  }
  const finishReason = json.candidates?.[0]?.finishReason
  const raw = json.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
  let parsed: { rates?: unknown; note?: unknown } | null = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    const m = raw.match(/\{[\s\S]*\}/)
    if (m) {
      try {
        parsed = JSON.parse(m[0])
      } catch {
        // fall through
      }
    }
  }
  if (!parsed) {
    throw new Error(
      `Gemini JSON 파싱 실패 (finish=${finishReason}, len=${raw.length}): ${raw.slice(0, 200)}`,
    )
  }

  const rawRates = Array.isArray(parsed.rates) ? (parsed.rates as unknown[]) : []
  const rates: ExtractedRate[] = []
  for (const row of rawRates) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const country = typeof r.country === 'string' ? r.country : null
    if (country !== 'US' && country !== 'JP' && country !== 'CN') continue
    const weight_min = typeof r.weight_min === 'number' ? r.weight_min : null
    const weight_max = typeof r.weight_max === 'number' ? r.weight_max : weight_min
    if (weight_min == null || weight_max == null || weight_min < 0 || weight_max < weight_min) continue
    const hasPrice =
      typeof r.price_krw === 'number' ||
      typeof r.price_usd === 'number' ||
      typeof r.price_jpy === 'number'
    if (!hasPrice) continue
    rates.push({
      country,
      center_name: typeof r.center_name === 'string' && r.center_name.trim() !== '' ? r.center_name.trim() : null,
      grade_level:
        typeof r.grade_level === 'number' && r.grade_level >= 1 && r.grade_level <= 5
          ? Math.floor(r.grade_level)
          : 1,
      member_grade:
        typeof r.member_grade === 'string' && r.member_grade.trim() !== '' ? r.member_grade.trim() : '일반',
      weight_min,
      weight_max,
      price_krw:
        typeof r.price_krw === 'number' && r.price_krw > 0 ? Math.round(r.price_krw) : null,
      price_usd: typeof r.price_usd === 'number' && r.price_usd > 0 ? r.price_usd : null,
      price_jpy:
        typeof r.price_jpy === 'number' && r.price_jpy > 0 ? Math.round(r.price_jpy) : null,
      shipping_type:
        r.shipping_type === 'air' || r.shipping_type === 'sea' ? r.shipping_type : null,
    })
  }

  const note = typeof parsed.note === 'string' ? parsed.note.slice(0, 500) : ''
  return { rates, note, rawResponse: raw.slice(0, 30000) }
}

async function checkOneForwarder(
  forwarder: Forwarder,
  apiKey: string,
): Promise<SingleCheckResult> {
  const base = {
    forwarder_id: forwarder.id,
    forwarder_slug: forwarder.slug,
    forwarder_name: forwarder.name,
    page_url: forwarder.rate_page_url,
  }

  if (!forwarder.rate_page_url) {
    return {
      ...base,
      status: 'skipped',
      extracted_rates: null,
      extracted_count: 0,
      ai_summary: null,
      ai_raw_response: null,
      page_size_bytes: null,
      error_message: 'rate_page_url 미등록',
    }
  }

  try {
    const { text, bytes } = await fetchPageText(forwarder.rate_page_url)
    const { rates, note, rawResponse } = await callGemini(
      apiKey,
      forwarder.name,
      forwarder.rate_page_url,
      text,
    )

    const status: CheckStatus = rates.length === 0 ? 'no_rates_found' : 'extracted'

    return {
      ...base,
      status,
      extracted_rates: rates,
      extracted_count: rates.length,
      ai_summary: note,
      ai_raw_response: rawResponse,
      page_size_bytes: bytes,
      error_message: rates.length === 0 ? (note || '페이지에서 요금 정보를 찾지 못함') : null,
    }
  } catch (err) {
    return {
      ...base,
      status: 'error',
      extracted_rates: null,
      extracted_count: 0,
      ai_summary: null,
      ai_raw_response: null,
      page_size_bytes: null,
      error_message: err instanceof Error ? err.message : String(err),
    }
  }
}

async function runInBatches<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += size) {
    const chunk = items.slice(i, i + size)
    const results = await Promise.all(chunk.map(fn))
    out.push(...results)
  }
  return out
}

export type StartRunResult = {
  run_id: string
  forwarder_ids: string[]
}

export type ChunkResult = {
  run_id: string
  processed: Array<{
    forwarder_id: string
    forwarder_name: string
    status: CheckStatus
    extracted_count: number
  }>
}

export type FinishRunResult = {
  run_id: string
  total: number
  extracted: number
  no_rates_found: number
  error: number
  skipped: number
  total_rates_extracted: number
}

/**
 * Run 시작: 활성 배대지 전체 id 목록 + 새 run_id 반환. 실제 작업은 start 에서 하지 않음.
 * 클라이언트가 받은 forwarder_ids 를 청크로 쪼개 processRateCheckChunk 를 반복 호출.
 */
export async function startRateCheckRun(triggeredBy: string): Promise<StartRunResult> {
  const admin = createAdminClient()

  const fwdRes = await admin
    .from('forwarders')
    .select('id')
    .eq('is_active', true)
    .order('name')
  if (fwdRes.error) throw new Error(`forwarders 조회 실패: ${fwdRes.error.message}`)
  const ids = (fwdRes.data ?? []).map((f) => f.id as string)

  const { data: runInsert, error: runInsertErr } = await admin
    .from('jimscanner_rate_check_runs')
    .insert({
      triggered_by: triggeredBy,
      total_forwarders: ids.length,
    })
    .select('id')
    .single()
  if (runInsertErr || !runInsert) {
    throw new Error(`run 생성 실패: ${runInsertErr?.message ?? 'unknown'}`)
  }
  return { run_id: runInsert.id as string, forwarder_ids: ids }
}

/**
 * 청크 처리: 지정된 forwarder_ids 만 추출·저장. 동시성 제한으로 타임아웃 방지.
 * 호출당 3~5개 권장 (각 forwarder 당 Gemini 호출 1회 ≤ 60초 가정).
 */
export async function processRateCheckChunk(
  runId: string,
  forwarderIds: string[],
): Promise<ChunkResult> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY 환경 변수가 설정되지 않았습니다.')

  const admin = createAdminClient()

  const fwdRes = await admin
    .from('forwarders')
    .select('id, slug, name, website, rate_page_url')
    .in('id', forwarderIds)
  if (fwdRes.error) throw new Error(`forwarders 조회 실패: ${fwdRes.error.message}`)
  const forwarders = (fwdRes.data ?? []) as Forwarder[]

  const results = await runInBatches(forwarders, CONCURRENCY, (f) => checkOneForwarder(f, apiKey))

  const resultRows = results.map((r) => ({ ...r, run_id: runId }))
  const { error: insertErr } = await admin.from('jimscanner_rate_check_results').insert(resultRows)
  if (insertErr) throw new Error(`results insert 실패: ${insertErr.message}`)

  return {
    run_id: runId,
    processed: results.map((r) => ({
      forwarder_id: r.forwarder_id,
      forwarder_name: r.forwarder_name,
      status: r.status,
      extracted_count: r.extracted_count,
    })),
  }
}

/**
 * 기존 run 안에서 단일 forwarder 만 재스캔. 기존 result 행을 삭제 후 새 행 insert.
 * run 의 집계값은 재계산을 위해 호출자가 finishRateCheckRun 을 다시 돌려야 함.
 */
export async function rescanForwarderInRun(
  runId: string,
  forwarderId: string,
): Promise<{ forwarder_id: string; status: CheckStatus; extracted_count: number }> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY 환경 변수가 설정되지 않았습니다.')

  const admin = createAdminClient()

  const fwdRes = await admin
    .from('forwarders')
    .select('id, slug, name, website, rate_page_url')
    .eq('id', forwarderId)
    .single()
  if (fwdRes.error || !fwdRes.data) throw new Error(`forwarder 조회 실패: ${fwdRes.error?.message ?? 'not found'}`)

  const result = await checkOneForwarder(fwdRes.data as Forwarder, apiKey)

  // 기존 해당 (run, forwarder) result 삭제 후 새 row insert
  await admin
    .from('jimscanner_rate_check_results')
    .delete()
    .eq('run_id', runId)
    .eq('forwarder_id', forwarderId)

  const { error: insertErr } = await admin
    .from('jimscanner_rate_check_results')
    .insert({ ...result, run_id: runId })
  if (insertErr) throw new Error(`result insert 실패: ${insertErr.message}`)

  return {
    forwarder_id: result.forwarder_id,
    status: result.status,
    extracted_count: result.extracted_count,
  }
}

/**
 * Run 완료 마무리: 해당 run 의 results 를 집계해 runs 테이블에 합계·completed_at 업데이트.
 */
export async function finishRateCheckRun(runId: string): Promise<FinishRunResult> {
  const admin = createAdminClient()

  const { data: results, error } = await admin
    .from('jimscanner_rate_check_results')
    .select('status, extracted_count')
    .eq('run_id', runId)
  if (error) throw new Error(`results 조회 실패: ${error.message}`)

  const counts = {
    extracted: 0,
    no_rates_found: 0,
    error: 0,
    skipped: 0,
  }
  let total_rates_extracted = 0
  for (const r of results ?? []) {
    if (r.status === 'extracted') counts.extracted++
    else if (r.status === 'no_rates_found') counts.no_rates_found++
    else if (r.status === 'error') counts.error++
    else if (r.status === 'skipped') counts.skipped++
    total_rates_extracted += r.extracted_count ?? 0
  }

  await admin
    .from('jimscanner_rate_check_runs')
    .update({
      completed_at: new Date().toISOString(),
      changed_count: counts.extracted,
      no_change_count: counts.no_rates_found,
      error_count: counts.error,
      skipped_count: counts.skipped,
    })
    .eq('id', runId)

  return {
    run_id: runId,
    total: results?.length ?? 0,
    total_rates_extracted,
    ...counts,
  }
}

/**
 * 특정 check result 의 extracted_rates 를 해당 forwarder 의 shipping_rates 에 반영.
 * 동작: 해당 forwarder_id 의 기존 shipping_rates 전체 DELETE → extracted_rates INSERT.
 * 기존 데이터를 통째로 교체하므로 적용 전 반드시 운영자가 diff 를 확인해야 함.
 */
export async function applyRateCheckResult(
  resultId: string,
  appliedBy: string,
): Promise<{ deleted: number; inserted: number }> {
  const admin = createAdminClient()

  const { data: result, error: resultErr } = await admin
    .from('jimscanner_rate_check_results')
    .select('id, forwarder_id, forwarder_name, status, extracted_rates, applied_at')
    .eq('id', resultId)
    .single()

  if (resultErr || !result) throw new Error(`result 조회 실패: ${resultErr?.message ?? 'not found'}`)
  if (result.applied_at) throw new Error('이미 적용된 결과입니다.')
  if (result.status !== 'extracted') throw new Error(`status='${result.status}' 상태는 적용할 수 없습니다.`)

  const rates = (result.extracted_rates ?? []) as ExtractedRate[]
  if (!Array.isArray(rates) || rates.length === 0) {
    throw new Error('추출된 요금이 없습니다.')
  }

  const rows = rates.map((r) => ({
    forwarder_id: result.forwarder_id,
    country: r.country,
    center_name: r.center_name,
    weight_min: r.weight_min,
    weight_max: r.weight_max,
    price_krw: r.price_krw,
    price_usd: r.price_usd,
    price_jpy: r.price_jpy,
    shipping_type: r.shipping_type ?? 'air',
    member_grade: r.member_grade ?? '일반',
    grade_level: r.grade_level,
  }))

  const { count: deleted } = await admin
    .from('shipping_rates')
    .delete({ count: 'exact' })
    .eq('forwarder_id', result.forwarder_id)

  const { error: insertErr, count: inserted } = await admin
    .from('shipping_rates')
    .insert(rows, { count: 'exact' })
  if (insertErr) throw new Error(`insert 실패: ${insertErr.message}`)

  await admin
    .from('jimscanner_rate_check_results')
    .update({ applied_at: new Date().toISOString(), applied_by: appliedBy })
    .eq('id', resultId)

  return { deleted: deleted ?? 0, inserted: inserted ?? rows.length }
}
