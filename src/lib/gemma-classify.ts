/**
 * 위탁 판매 후보 product LLM 분류 호출 (셀러 도구 PR-4.5)
 *
 * 기본 모델: `gemini-2.5-flash-lite` (무료 티어, thinking 끔으로 안정적 JSON 응답)
 *   - Gemma 4 26B A4B 도 같은 endpoint 호출 가능하지만 free-form 분석 응답 경향이 강해 1차 시도 실패
 *   - Flash-Lite 가 분류·정제 작업엔 가장 빠르고 안정적 (일 1,000 req 무료)
 * 호출 방식: Gemini API endpoint (`generativelanguage.googleapis.com`)
 * 사용처: /api/cron/classify-trends-llm
 *
 * 정책: OpenRouter / Hermes 사용 금지 (memory: llm_provider_policy.md).
 *       모든 LLM 호출은 GEMINI_API_KEY + Google AI Studio.
 */

const DEFAULT_MODEL = 'gemini-2.5-flash-lite'

export interface ClassifyInput {
  id: string
  name: string                       // canonical_name (현재)
  category_top: string               // 'health' | 'living' | 'digital' | 'unknown'
  alias_count: number
  sample_aliases: string[]           // 최근 alias 1~3개
  sample_sources: string[]           // 등장 source 목록 (예: ['naver_shopping_hot', 'aliex_best'])
}

export interface ClassifyResult {
  id: string
  canonical_name: string             // 정제된 표준명 (브랜드·옵션·수식어 제거 후 핵심)
  brand: string | null               // 추출된 브랜드 (없으면 null)
  category_top: 'health' | 'living' | 'digital' | 'other'
  category_mid: string               // 중분류 (자유 텍스트, 예: '오메가3', '주방수납', '스마트홈조명')
  intent_label: string               // 사용자 의도 라벨 (예: '예방건강', '문제해결', '선물', '소모품', '취미')
  description: string                // 1문장 요약
}

const SYSTEM_PROMPT = `한국 위탁 판매 상품 분류기. 입력 리스트를 JSON 배열로 변환.

❗ 절대 규칙:
- 응답 첫 글자는 '[', 마지막 글자는 ']'
- 분석 과정·설명·코드펜스(\`\`\`)·markdown 출력 금지
- 입력 id 그대로 유지

각 항목 필드:
- canonical_name: 브랜드·용량·수식어 제거 후 상품 본질 (한국어, 예: "닥터린 초임계 알티지 오메가3 60캡슐" → "오메가3")
- brand: 명확한 브랜드만, 없으면 null
- category_top: health | living | digital | other
  · health: 건강기능식품·영양제·식품 (ggsan 도매몰 상품군)
  · living: 생활·주방·청소·뷰티·패션·차량
  · digital: 디지털·가전·액세서리·조명
  · other: 위 3종 외
- category_mid: 5-10자 한국어 (예: "오메가3", "수납용품", "휴대선풍기", "스마트조명")
- intent_label: 5-7자 (예: "예방건강", "문제해결", "판촉선물", "소모품", "취미생활", "계절상품")
- description: 15자 이내 1문장 (위탁 판매 의사결정 단서)

예시:
입력: - id="abc" name="닥터린 초임계 알티지 오메가3 60캡슐" cur_top=health aliases=2 samples=[종근당 오메가3 | 일양 오메가3] sources=[naver_shopping_hot,musinsa_best]
출력: [{"id":"abc","canonical_name":"오메가3","brand":"닥터린","category_top":"health","category_mid":"오메가3","intent_label":"예방건강","description":"혈행건강 영양제"}]`

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] }
    finishReason?: string
  }[]
  promptFeedback?: { blockReason?: string }
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
  }
  error?: { message?: string; status?: string }
}

function buildUserPrompt(items: ClassifyInput[]): string {
  const lines = items.map((it) => {
    return `- id="${it.id}" name="${it.name}" cur_top=${it.category_top} aliases=${it.alias_count} samples=[${it.sample_aliases.slice(0, 3).join(' | ')}] sources=[${it.sample_sources.join(',')}]`
  })
  return `다음 ${items.length}개 상품 후보를 분류·정제해서 JSON 배열로 응답:\n\n${lines.join('\n')}`
}

function tryParseJsonArray(text: string): unknown[] | null {
  // 1) 직접 JSON 파싱
  try {
    const v = JSON.parse(text)
    if (Array.isArray(v)) return v
  } catch {}
  // 2) ```json ... ``` 코드펜스 제거
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) {
    try {
      const v = JSON.parse(fence[1])
      if (Array.isArray(v)) return v
    } catch {}
  }
  // 3) 첫 [ ~ 마지막 ] 추출
  const a = text.indexOf('[')
  const b = text.lastIndexOf(']')
  if (a !== -1 && b !== -1 && b > a) {
    try {
      const v = JSON.parse(text.slice(a, b + 1))
      if (Array.isArray(v)) return v
    } catch {}
  }
  return null
}

function normalizeResult(o: any, fallbackId: string): ClassifyResult | null {
  if (!o || typeof o !== 'object') return null
  const id = String(o.id ?? fallbackId).trim()
  if (!id) return null
  const cn = typeof o.canonical_name === 'string' ? o.canonical_name.trim() : ''
  if (!cn) return null
  const top = ['health', 'living', 'digital', 'other'].includes(o.category_top) ? o.category_top : 'other'
  return {
    id,
    canonical_name: cn,
    brand: typeof o.brand === 'string' && o.brand.trim() ? o.brand.trim() : null,
    category_top: top,
    category_mid: typeof o.category_mid === 'string' ? o.category_mid.trim().slice(0, 30) : '',
    intent_label: typeof o.intent_label === 'string' ? o.intent_label.trim().slice(0, 20) : '',
    description: typeof o.description === 'string' ? o.description.trim().slice(0, 80) : '',
  }
}

export interface ClassifyBatchOutcome {
  results: ClassifyResult[]
  rawText: string
  promptTokens: number
  outputTokens: number
  model: string
}

export async function classifyBatch(
  items: ClassifyInput[],
  opts: { model?: string; apiKey?: string; signal?: AbortSignal } = {},
): Promise<ClassifyBatchOutcome> {
  const apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY
  if (!apiKey) throw new Error('GEMINI_API_KEY not set')
  if (items.length === 0) {
    return { results: [], rawText: '', promptTokens: 0, outputTokens: 0, model: opts.model ?? DEFAULT_MODEL }
  }

  const model = opts.model ?? DEFAULT_MODEL
  const userPrompt = buildUserPrompt(items)
  const fullPrompt = `${SYSTEM_PROMPT}\n\n---\n\n${userPrompt}`

  const generationConfig: Record<string, unknown> = {
    temperature: 0.2,
    maxOutputTokens: 2048,
    responseMimeType: 'application/json',
  }
  // gemini-2.5 계열은 thinking 끔 — 응답 길이/형식 안정화 + 무료 티어 절약
  if (model.startsWith('gemini-2.5')) {
    generationConfig.thinkingConfig = { thinkingBudget: 0 }
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
      generationConfig,
    }),
    signal: opts.signal,
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`Gemma ${model} ${res.status}: ${errText.slice(0, 300)}`)
  }
  const j = (await res.json()) as GeminiResponse
  if (j.error) throw new Error(`Gemma error: ${j.error.message ?? 'unknown'}`)
  if (j.promptFeedback?.blockReason) throw new Error(`blocked: ${j.promptFeedback.blockReason}`)

  const rawText = (j.candidates?.[0]?.content?.parts ?? []).map((p) => p?.text ?? '').join('')
  const arr = tryParseJsonArray(rawText) ?? []

  const byId = new Map<string, ClassifyResult>()
  for (let i = 0; i < arr.length; i++) {
    const r = normalizeResult(arr[i], items[i]?.id ?? '')
    if (r) byId.set(r.id, r)
  }

  // 입력 순서 유지, 누락된 id 는 결과에서 빠짐 (caller 가 처리)
  const results = items.map((it) => byId.get(it.id)).filter((x): x is ClassifyResult => !!x)

  return {
    results,
    rawText,
    promptTokens: j.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: j.usageMetadata?.candidatesTokenCount ?? 0,
    model,
  }
}
