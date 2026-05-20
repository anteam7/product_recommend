/**
 * 리스팅 제목 옵티마이저 — Naver/쿠팡 50자 SEO 제목 후보 4~6개 생성.
 *
 * 입력:
 *   - jimscanner_trends_products.canonical_name + aliases
 *   - jimscanner_trends_keywords (최근 30일, classified_intent='transactional' 우선)
 *   - jimscanner_listing_blocked_terms
 *
 * 출력: jimscanner_listing_title_candidates 에 batch insert.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const MODEL = 'gemini-2.5-flash'
const MAX_TITLE_LEN = 50

type AliasRow = { alias: string; alias_type: string; confidence: number }
type KeywordRow = {
  keyword: string
  volume_relative: number | null
  rank: number | null
  classified_intent: string | null
  source: string
}

type RawCandidate = {
  title?: unknown
  score?: unknown
  covered_keywords?: unknown
  notes?: unknown
}

const SYSTEM_PROMPT = `# 역할
당신은 네이버 스마트스토어/쿠팡 위탁판매 셀러를 위한 SEO 제목 카피라이터입니다.
주어진 상품(canonical_name + alias 풀 + 검색 트렌드)을 바탕으로 검색 노출이 잘 되는 50자 이내 제목 후보를 4~6개 만듭니다.

# 제목 작성 원칙
1. **50자 이내(공백 포함)**. 한국 검색 플랫폼의 인덱싱 한도.
2. **검색량 높은 키워드를 자연스럽게 포함**. 단순 나열이 아니라 사람이 읽을 만한 어순으로.
3. **금지어 절대 사용 금지** — 별도로 전달되는 blocked_terms 목록. 같은 의미의 우회 표현도 금지(예: 최고→인기, 최저가→가성비).
4. **alias 풀에서 동의어/표기 변형을 활용**. 같은 어휘만 반복하지 말고 핵심 변형 1~2개 끼워넣기.
5. **카테고리/용도/대상 명시** — "차량용", "휴대용", "여성용" 처럼 검색자 의도가 드러나는 수식어 권장.
6. **숫자/수량/규격 포함 권장** — "1L", "10개입", "USB-C" 등 구매 의사결정 키워드.
7. 후보들은 **서로 다른 키워드 조합**으로 차별화. 거의 같은 제목 X.

# 출력 형식 (JSON only — 앞뒤 설명·코드펜스 금지)
{
  "candidates": [
    {
      "title": "50자 이내 한국어 제목",
      "score": 0~100 (예상 노출 점수, 사용된 키워드 총 volume 기반 자체 추정),
      "covered_keywords": ["포함한 검색 키워드", "..."],
      "notes": "이 제목의 노림수 한 줄"
    }
  ]
}

후보는 정확히 4~6개. 각 title 의 글자 수가 50자를 넘으면 자동 탈락 처리되니 반드시 50자 이내.`

function extractJson(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1] : text
  const firstBrace = candidate.indexOf('{')
  const lastBrace = candidate.lastIndexOf('}')
  if (firstBrace === -1 || lastBrace === -1) return null
  try {
    return JSON.parse(candidate.slice(firstBrace, lastBrace + 1))
  } catch {
    return null
  }
}

function detectBlockedTerms(title: string, blocked: string[]): string[] {
  const lower = title.toLowerCase()
  return blocked.filter((t) => t && lower.includes(t.toLowerCase()))
}

export async function POST(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params

  // ── 인증
  const sb = await createClient()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user || !isAdminEmail(user.email)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'GEMINI_API_KEY 미설정' }, { status: 500 })
  }

  const admin = createAdminClient()

  // ── 1) product
  const { data: product, error: prodErr } = await admin
    .from('jimscanner_trends_products')
    .select('id, canonical_name, brand, category_top, category_mid, description, intent_label')
    .eq('id', id)
    .single()
  if (prodErr || !product) {
    return NextResponse.json(
      { error: prodErr?.message ?? 'product not found' },
      { status: 404 },
    )
  }

  // ── 2) aliases
  const { data: aliasData } = await admin
    .from('jimscanner_trends_aliases')
    .select('alias, alias_type, confidence')
    .eq('product_id', id)
    .order('confidence', { ascending: false })
    .limit(40)
  const aliases = (aliasData ?? []) as AliasRow[]

  // ── 3) 최근 30일 검색 트렌드 (alias 와 매칭)
  //    alias 풀 + canonical_name 을 키워드 후보로 잡고 jimscanner_trends_keywords 에서 조회.
  const aliasPool = [
    product.canonical_name,
    ...aliases.map((a) => a.alias),
  ]
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .slice(0, 50)

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const { data: kwData } = await admin
    .from('jimscanner_trends_keywords')
    .select('keyword, volume_relative, rank, classified_intent, source')
    .gte('collected_at', since)
    .in('keyword', aliasPool)
    .limit(300)
  const keywords = (kwData ?? []) as KeywordRow[]

  // keyword 단위 집계 — 최대 volume / transactional 여부
  const kwAgg = new Map<
    string,
    { volume: number; intent: string | null; sources: Set<string> }
  >()
  for (const k of keywords) {
    const cur = kwAgg.get(k.keyword) ?? {
      volume: 0,
      intent: null,
      sources: new Set<string>(),
    }
    const v = typeof k.volume_relative === 'number' ? k.volume_relative : 0
    if (v > cur.volume) cur.volume = v
    if (k.classified_intent === 'transactional') cur.intent = 'transactional'
    else if (!cur.intent && k.classified_intent) cur.intent = k.classified_intent
    if (k.source) cur.sources.add(k.source)
    kwAgg.set(k.keyword, cur)
  }
  const rankedKeywords = Array.from(kwAgg.entries())
    .map(([keyword, v]) => ({
      keyword,
      volume: v.volume,
      intent: v.intent,
      sources: Array.from(v.sources),
    }))
    .sort((a, b) => {
      const aT = a.intent === 'transactional' ? 1 : 0
      const bT = b.intent === 'transactional' ? 1 : 0
      if (aT !== bT) return bT - aT
      return b.volume - a.volume
    })
    .slice(0, 20)

  // ── 4) 금지어
  // 새 테이블이라 types/supabase.ts 에 아직 없음 — admin 클라이언트를 any 캐스팅.
  const { data: blockedData } = await (admin as any)
    .from('jimscanner_listing_blocked_terms')
    .select('term, reason')
  const blockedTerms: string[] = (blockedData ?? [])
    .map((r: { term: string }) => r.term)
    .filter((t: unknown): t is string => typeof t === 'string')

  // ── 5) LLM 호출
  const aliasLines = aliases
    .slice(0, 25)
    .map((a) => `- ${a.alias} (${a.alias_type}, conf ${a.confidence?.toFixed(2)})`)
    .join('\n')

  const keywordLines = rankedKeywords
    .map(
      (k) =>
        `- ${k.keyword} — volume ${k.volume.toFixed(1)}, intent ${k.intent ?? '-'}, source ${k.sources.join('|')}`,
    )
    .join('\n')

  const userPrompt = `# 상품
- canonical_name: ${product.canonical_name}
- 브랜드: ${product.brand ?? '(없음)'}
- 카테고리: ${product.category_top}${product.category_mid ? ' / ' + product.category_mid : ''}
- 분류 intent: ${product.intent_label ?? '(미분류)'}
- 설명: ${product.description ?? '(없음)'}

# Alias 풀 (총 ${aliases.length}건, 상위 25개 표시)
${aliasLines || '(없음)'}

# 최근 30일 검색 트렌드 (transactional 우선, 상위 ${rankedKeywords.length}개)
${keywordLines || '(데이터 없음 — alias 풀과 카테고리 상식으로 보강할 것)'}

# 금지어 (절대 사용 금지)
${blockedTerms.length > 0 ? blockedTerms.join(', ') : '(없음)'}

# 과제
위 입력을 바탕으로 네이버 스마트스토어/쿠팡 위탁판매용 50자 이내 SEO 제목 후보 4~6개를 JSON 으로 출력하세요.`

  const llmRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 2048,
          responseMimeType: 'application/json',
        },
      }),
    },
  )

  if (!llmRes.ok) {
    const errText = await llmRes.text()
    return NextResponse.json(
      { error: `Gemini API ${llmRes.status}: ${errText.slice(0, 500)}` },
      { status: 502 },
    )
  }

  const llmJson = (await llmRes.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[]
    promptFeedback?: { blockReason?: string }
  }
  const rawText = (llmJson.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p?.text ?? '')
    .join('')
  const parsed = extractJson(rawText)
  const rawCandidates = Array.isArray((parsed as any)?.candidates)
    ? ((parsed as any).candidates as RawCandidate[])
    : []

  if (rawCandidates.length === 0) {
    return NextResponse.json(
      {
        error: 'AI 응답 파싱 실패',
        finishReason: llmJson.candidates?.[0]?.finishReason,
        blockReason: llmJson.promptFeedback?.blockReason,
        raw: rawText.slice(0, 600),
      },
      { status: 502 },
    )
  }

  // ── 6) 후보 정규화 + 검증
  const batchId = crypto.randomUUID()
  type CandidateRow = {
    id: string
    product_id: string
    batch_id: string
    title: string
    score: number
    covered_keywords: string[]
    covered_volume: number
    char_len: number
    blocked_terms: string[]
    notes: string | null
    llm_model: string
  }

  const candidateRows: CandidateRow[] = []
  for (const c of rawCandidates.slice(0, 8)) {
    const title = typeof c.title === 'string' ? c.title.trim() : ''
    if (!title) continue
    const charLen = [...title].length
    if (charLen === 0) continue
    const covered = Array.isArray(c.covered_keywords)
      ? (c.covered_keywords as unknown[])
          .filter((k): k is string => typeof k === 'string')
          .slice(0, 10)
      : []
    const coveredVolume = covered.reduce((sum, kw) => {
      const v = kwAgg.get(kw)?.volume ?? 0
      return sum + v
    }, 0)
    const score =
      typeof c.score === 'number' && Number.isFinite(c.score)
        ? Math.max(0, Math.min(100, c.score))
        : Math.min(100, Math.round(coveredVolume))
    const blocked = detectBlockedTerms(title, blockedTerms)
    candidateRows.push({
      id: crypto.randomUUID(),
      product_id: id,
      batch_id: batchId,
      title: title.slice(0, 200),
      score,
      covered_keywords: covered,
      covered_volume: coveredVolume,
      char_len: charLen,
      blocked_terms: blocked,
      notes: typeof c.notes === 'string' ? c.notes.slice(0, 500) : null,
      llm_model: MODEL,
    })
  }

  if (candidateRows.length === 0) {
    return NextResponse.json({ error: '유효한 후보 없음', raw: rawText.slice(0, 600) }, { status: 502 })
  }

  // ── 7) insert (새 테이블 → as any)
  const { error: insErr } = await (admin as any)
    .from('jimscanner_listing_title_candidates')
    .insert(candidateRows)
  if (insErr) {
    return NextResponse.json({ error: insErr.message }, { status: 500 })
  }

  return NextResponse.json({
    ok: true,
    batchId,
    model: MODEL,
    count: candidateRows.length,
    overLimit: candidateRows.filter((c) => c.char_len > MAX_TITLE_LEN).length,
    candidates: candidateRows,
  })
}
