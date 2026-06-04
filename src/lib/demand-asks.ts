// 커뮤니티 '추천 좀' 요청 마이닝 헬퍼
// - looksLikeAsk: 제목/본문이 명시적 구매탐색(추천요청) 글인지 정규식 판별 (수집 크론에서 사용)
// - extractAskRecommendations: 본문+댓글에서 Gemini 로 (정규화된 요청, 추천상품 리더보드) 추출

import type { Json } from '@/lib/supabase'

// ── 1) 정규식 1차 분류 ───────────────────────────────────────
// '지금 사고 싶은데 뭘 살지 모르는' 가장 순수한 능동 구매수요 패턴.
const ASK_PATTERNS: RegExp[] = [
  /추천\s*(좀|해|부탁|please|플리즈)/i, // "추천 좀", "추천해주세요", "추천 부탁"
  /추천\s*(해\s*주|해\s*줘|해주실|받고)/, // "추천해주세요", "추천해줘", "추천받고싶"
  /뭐(가|를)?\s*(좋|괜찮|살까|사야|쓰)/, // "뭐가 좋아요", "뭐 사야", "뭐 쓰세요"
  /어떤\s*(거|걸|제품|상품|브랜드|모델).{0,6}(좋|괜찮|추천|살까)/, // "어떤 거 좋아요"
  /(공구|공동구매)\s*(어디|어떻게|있나|정보|링크)/, // "공구 어디서"
  /어디(서|에서)?\s*(사|살|구매|파)/, // "어디서 사요", "어디서 파나요"
  /(살만한|쓸만한|입문용|가성비)\s*\S*\s*(추천|뭐|있)/, // "가성비 추천"
  /고민\s*(이|중|돼|되|입니다|이에요)/, // "A vs B 고민중"
  /비교\s*(좀|해|부탁|추천)/, // "비교 좀"
]

// 추천요청처럼 보여도 제외할 노이즈 (이미 후기/정보 공유글)
const ASK_NEGATIVE: RegExp[] = [
  /후기|리뷰|내돈내산|언박싱|개봉기|정리해/,
  /추천\s*(드림|드립니다|합니다)\s*$/, // "추천드립니다" (정보 제공글)
]

export function looksLikeAsk(text: string | null | undefined): boolean {
  if (!text) return false
  const t = text.trim()
  if (t.length < 4) return false
  if (ASK_NEGATIVE.some((re) => re.test(t))) return false
  return ASK_PATTERNS.some((re) => re.test(t))
}

// ── 2) Gemini 추출 ───────────────────────────────────────────
const MODEL = 'gemini-2.5-flash'

export type AskExtraction = {
  is_ask: boolean
  ask_text: string // 정규화된 요청 의도 (canonical, 한국어 명사구)
  category: string | null // '건강식품' | '생활/리빙' | '디지털/가전' | '뷰티' | '식품' | '패션' | '기타'
  recommendations: {
    recommended_name: string
    mention_count: number
    sentiment: 'positive' | 'neutral' | 'mixed' | 'negative'
  }[]
}

const SYSTEM_PROMPT = `당신은 한국 커뮤니티(클리앙·뽐뿌·82cook·네이트판·디시) 글을 분석하는 커머스 수요 분석가입니다.
주어진 글(제목·본문·댓글)이 "명시적 구매탐색(추천요청)" 글인지 판별하고, 그렇다면:
1) 요청 의도를 검색 가능한 짧은 명사구로 정규화(ask_text). 예: "차량용 무선 청소기 추천", "수면 영양제 추천", "유아 변기 추천".
2) 카테고리를 ['건강식품','생활/리빙','디지털/가전','뷰티','식품','패션','육아','기타'] 중 하나로.
3) 댓글/본문에서 실제로 추천된 구체적 상품/브랜드/모델명을 모두 추출(recommendations). 같은 상품이 여러 번 언급되면 mention_count 를 올리고, 댓글 톤으로 sentiment 판정.

규칙:
- 추천요청이 아니면 {"is_ask": false, "ask_text":"", "category":null, "recommendations":[]} 만 출력.
- recommended_name 은 구체적이어야 함. "그거 좋아요" 같은 모호한 건 제외. 브랜드/제품명만.
- 광고·도배성 댓글은 무시.
- JSON 만 출력. 코드펜스·설명 금지.

출력 스키마:
{"is_ask": boolean, "ask_text": string, "category": string|null, "recommendations": [{"recommended_name": string, "mention_count": number, "sentiment": "positive"|"neutral"|"mixed"|"negative"}]}`

function extractJson(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1] : text
  const first = candidate.indexOf('{')
  const last = candidate.lastIndexOf('}')
  if (first === -1 || last === -1) return null
  try {
    return JSON.parse(candidate.slice(first, last + 1))
  } catch {
    return null
  }
}

const VALID_CATEGORIES = ['건강식품', '생활/리빙', '디지털/가전', '뷰티', '식품', '패션', '육아', '기타']

/**
 * 글 1건(제목+본문+댓글)을 Gemini 로 추출. apiKey 없으면 null.
 * 실패해도 throw 하지 않고 null 반환 (크론이 다음 글로 진행).
 */
export async function extractAskRecommendations(input: {
  title: string
  body?: string | null
  comments?: string[]
}): Promise<AskExtraction | null> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return null

  const commentsText = (input.comments ?? []).slice(0, 80).join('\n')
  const userPrompt = `## 제목
${input.title}

## 본문
${(input.body ?? '').slice(0, 2000) || '(없음)'}

## 댓글 (${input.comments?.length ?? 0}개)
${commentsText.slice(0, 6000) || '(없음)'}`

  let res: Response
  try {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 2048, responseMimeType: 'application/json' },
        }),
      },
    )
  } catch {
    return null
  }
  if (!res.ok) return null

  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[]
  }
  const rawText = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p?.text ?? '').join('')
  const parsed = extractJson(rawText)
  if (!parsed) return null

  if (parsed.is_ask !== true) {
    return { is_ask: false, ask_text: '', category: null, recommendations: [] }
  }

  const ask_text = typeof parsed.ask_text === 'string' ? parsed.ask_text.trim() : ''
  if (!ask_text) return { is_ask: false, ask_text: '', category: null, recommendations: [] }

  const category =
    typeof parsed.category === 'string' && VALID_CATEGORIES.includes(parsed.category)
      ? parsed.category
      : null

  const recoRaw = Array.isArray(parsed.recommendations) ? parsed.recommendations : []
  const recommendations = recoRaw
    .map((r) => {
      if (!r || typeof r !== 'object') return null
      const o = r as Record<string, unknown>
      const name = typeof o.recommended_name === 'string' ? o.recommended_name.trim() : ''
      if (!name || name.length < 2) return null
      const mc = Number(o.mention_count)
      const sentRaw = typeof o.sentiment === 'string' ? o.sentiment : 'neutral'
      const sentiment = (['positive', 'neutral', 'mixed', 'negative'].includes(sentRaw)
        ? sentRaw
        : 'neutral') as AskExtraction['recommendations'][number]['sentiment']
      return {
        recommended_name: name,
        mention_count: Number.isFinite(mc) && mc > 0 ? Math.floor(mc) : 1,
        sentiment,
      }
    })
    .filter((x): x is AskExtraction['recommendations'][number] => x !== null)

  return { is_ask: true, ask_text, category, recommendations }
}

// metadata helper — market_raw.metadata 에 ask 플래그/댓글 적재 시 타입 안정용
export type AskRawMetadata = {
  is_demand_ask?: boolean
  body?: string
  comments?: string[]
  [k: string]: Json | undefined
}
