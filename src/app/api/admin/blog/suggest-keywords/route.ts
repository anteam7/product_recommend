import { NextResponse, type NextRequest } from 'next/server'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { BLOG_CATEGORIES, type BlogCategory } from '@/lib/blog'
import { buildMarketSignalContext } from '@/lib/market-signals-context'
import { buildGscContext } from '@/lib/search-console'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const MODEL = 'gemini-2.5-pro'

type Suggestion = {
  keyword: string
  category: BlogCategory
  angle: string
  reason: string
}

type ResponsePayload = {
  distribution: Record<BlogCategory, number>
  totalPublished: number
  recommendedCategory: BlogCategory
  suggestions: Suggestion[]
  model: string
  groundingUrls: string[]
}

const SYSTEM_PROMPT = `# 역할

당신은 짐스캐너(jimscanner.co.kr, 해외 배대지 비교 플랫폼) 블로그의 키워드 전략가입니다.
1인 개발자가 운영하는 이 사이트의 트래픽을 키우기 위한 다음 글의 타겟 키워드를 제안합니다.

# 제안 원칙

1. **GSC 시그널 최우선** — "Google Search Console 시그널" 섹션이 있으면 이 데이터를 1순위로. 노출은 많지만 CTR이 낮은 검색어("CTR 개선 기회")는 콘텐츠가 부족해서 클릭이 안 되는 것 — 이 검색어로 글을 작성하면 즉시 트래픽 효과. Top 검색어 중 짐스캐너에 콘텐츠가 약한 영역도 보강 후보.
2. **시장 시그널 활용** — "짐스캐너 시장 시그널" 섹션이 2순위. 정부 공지·자동완성 빈도·핫딜 카테고리·블로그 후기 query 가 실제 한국 직구러의 관심사이므로 키워드 선정에 직결시킬 것.
3. **검색 수요가 실제로 있는 키워드**를 고를 것. 시그널이 없거나 부족한 영역은 Google Search 결과로 보강.
4. **현재 시즌 / 최근 트렌드 반영** — "오늘 날짜" 기준 직구 이슈(블랙프라이데이, 광군제, 직구 규제, 환율, 관세 변화, 신규 배대지 론칭 등) 반영.
5. **기존에 다룬 주제 중복 금지** — 입력된 기존 제목·키워드 리스트와 겹치지 않게.
6. **카테고리 보강** — 입력된 카테고리 분포에서 **부족한 카테고리를 우선 배분**. 단 모든 제안을 같은 카테고리로 몰지 말고 골고루.
7. 키워드는 실제로 한국인이 검색창에 칠 만한 표현으로. 예: "미국 배대지 추천 2026", "일본 배대지 도쿄 센터 비교", "블랙프라이데이 관세 피하는 법".
8. 각 키워드는 **독립된 1편의 글**이 되어야 함. 너무 좁거나(롱테일 과소), 너무 넓으면(레드오션) 제외.
9. **reason 필드는 근거 시그널을 명시** — 예: "GSC: '미국 직구 환급' 노출 12건 CTR 0.8% — 콘텐츠 부족", "정부 공지: '~ 보도자료'를 사용자가 검색할 가능성", "자동완성 'X' 가 N건 등장"

# 카테고리

- 가이드: 입문자용 절차/설명 (예: "처음 하는 미국 직구 절차")
- 추천: TOP·랭킹 콘텐츠 (예: "미국 배대지 TOP 10")
- 비교: A vs B 형태 (예: "몰테일 vs 오마이집")
- 팁: 노하우·꿀팁 (예: "배대지 할인쿠폰 받는 법")
- 뉴스: 업계 동향·이슈 (예: "2026년 관세 개정안 정리")

# 출력 형식

JSON만 출력. 앞뒤 설명·코드펜스 금지.

{
  "suggestions": [
    {
      "keyword": "검색 키워드 (한국어)",
      "category": "가이드|추천|비교|팁|뉴스 중 하나",
      "angle": "글의 앵글/관점 한 줄",
      "reason": "이 시점에 이 키워드를 고른 이유 (시즌/트렌드/부족 카테고리 근거 포함, 1~2문장)"
    }
  ]
}

정확히 5개 제안. 각 키워드는 서로 다른 주제여야 함.`

async function requireAdmin() {
  const sb = await createClient()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user || !isAdminEmail(user.email)) return null
  return user
}

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

function normalizeCategory(value: unknown): BlogCategory {
  if (typeof value === 'string' && (BLOG_CATEGORIES as readonly string[]).includes(value)) {
    return value as BlogCategory
  }
  return '가이드'
}

export async function POST(_request: NextRequest) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return NextResponse.json({ error: 'GEMINI_API_KEY 미설정' }, { status: 500 })

  const admin = createAdminClient()

  const { data: posts, error: postsErr } = await admin
    .from('jimscanner_blog_posts')
    .select('title, category, status, target_keywords, published_at')
    .order('published_at', { ascending: false })

  if (postsErr) {
    return NextResponse.json({ error: postsErr.message }, { status: 500 })
  }

  const list = posts ?? []
  const published = list.filter((p) => p.status === 'published')

  const distribution = BLOG_CATEGORIES.reduce(
    (acc, c) => ({ ...acc, [c]: 0 }),
    {} as Record<BlogCategory, number>,
  )
  for (const p of published) {
    const c = normalizeCategory(p.category)
    distribution[c] = (distribution[c] ?? 0) + 1
  }

  // 가장 적은 카테고리를 추천 카테고리로 (동률이면 BLOG_CATEGORIES 선언 순서상 앞쪽)
  let recommendedCategory: BlogCategory = BLOG_CATEGORIES[0]
  let minCount = Number.POSITIVE_INFINITY
  for (const c of BLOG_CATEGORIES) {
    const n = distribution[c] ?? 0
    if (n < minCount) {
      minCount = n
      recommendedCategory = c
    }
  }

  const existingTitles = list.map((p) => p.title).filter(Boolean) as string[]
  const existingKeywords = list
    .flatMap((p) => p.target_keywords ?? [])
    .filter((k): k is string => typeof k === 'string' && k.length > 0)

  const distributionLines = BLOG_CATEGORIES.map(
    (c) => `- ${c}: ${distribution[c] ?? 0}편`,
  ).join('\n')

  const today = new Date().toISOString().slice(0, 10)
  const [signalContext, gscContext] = await Promise.all([
    buildMarketSignalContext({ days: 7, limit: 12 }),
    buildGscContext({ days: 30 }),
  ])

  const userPrompt = `오늘 날짜: ${today}

## 현재 사이트 카테고리 분포 (게시된 글 기준, 총 ${published.length}편)
${distributionLines}

**부족한 카테고리(우선 보강): ${recommendedCategory}** — 이 카테고리에 1~2개는 꼭 할애하되, 전체는 골고루 섞어주세요.

## 이미 발행·초안인 제목 (중복 금지 · 최대 50개)
${existingTitles.slice(0, 50).map((t) => `- ${t}`).join('\n') || '(없음)'}

## 이미 쓰인 타겟 키워드 (중복 금지 · 최대 50개)
${existingKeywords.slice(0, 50).map((k) => `- ${k}`).join('\n') || '(없음)'}

${gscContext.text}

${signalContext.text}

## 과제
**1순위로 GSC 시그널** (특히 "CTR 개선 기회" 검색어)을 활용하고, **2순위로 시장 시그널**을 활용해 타겟 키워드 5개를 제안하세요.
시그널이 비어있거나 부족한 영역은 Google Search grounding 으로 보강.
각 제안의 reason 필드에 어떤 시그널이 근거가 되었는지 명시하세요 (예: "GSC: '~' 노출 N CTR X%", "정부 공지: ~", "자동완성 빈도: ~×N").`

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 8192,
        },
      }),
    },
  )

  if (!res.ok) {
    const errText = await res.text()
    return NextResponse.json(
      { error: `Gemini API ${res.status}: ${errText.slice(0, 500)}` },
      { status: 502 },
    )
  }

  const gemini = (await res.json()) as {
    candidates?: {
      content?: { parts?: { text?: string }[] }
      finishReason?: string
      groundingMetadata?: {
        groundingChunks?: { web?: { uri?: string; title?: string } }[]
      }
    }[]
    promptFeedback?: { blockReason?: string; safetyRatings?: unknown }
    usageMetadata?: {
      promptTokenCount?: number
      candidatesTokenCount?: number
      thoughtsTokenCount?: number
      totalTokenCount?: number
    }
  }

  const candidate = gemini.candidates?.[0]
  const rawText = (candidate?.content?.parts ?? [])
    .map((p) => p?.text ?? '')
    .join('')
  const parsed = extractJson(rawText)

  const rawSuggestions = Array.isArray(parsed?.suggestions) ? (parsed!.suggestions as unknown[]) : []
  const suggestions: Suggestion[] = rawSuggestions
    .map((item) => {
      if (!item || typeof item !== 'object') return null
      const o = item as Record<string, unknown>
      const keyword = typeof o.keyword === 'string' ? o.keyword.trim() : ''
      if (!keyword) return null
      return {
        keyword,
        category: normalizeCategory(o.category),
        angle: typeof o.angle === 'string' ? o.angle.trim() : '',
        reason: typeof o.reason === 'string' ? o.reason.trim() : '',
      }
    })
    .filter((x): x is Suggestion => x !== null)
    .slice(0, 5)

  if (suggestions.length === 0) {
    const finishReason = candidate?.finishReason
    const blockReason = gemini.promptFeedback?.blockReason
    const candidatesCount = gemini.candidates?.length ?? 0
    const partsCount = candidate?.content?.parts?.length ?? 0
    const hint =
      finishReason === 'MAX_TOKENS'
        ? ' (토큰 한도 초과)'
        : finishReason === 'SAFETY' || blockReason
          ? ` (세이프티 차단: ${blockReason ?? finishReason})`
          : candidatesCount === 0
            ? ' (candidates 비어있음)'
            : partsCount === 0
              ? ' (parts 비어있음)'
              : rawText === ''
                ? ' (text 파트 없음)'
                : ''
    return NextResponse.json(
      {
        error: `AI 응답 파싱 실패${hint}`,
        finishReason,
        blockReason,
        candidatesCount,
        partsCount,
        usage: gemini.usageMetadata,
        raw: rawText.slice(0, 800),
      },
      { status: 502 },
    )
  }

  const groundingUrls = (candidate?.groundingMetadata?.groundingChunks ?? [])
    .map((c) => c.web?.uri)
    .filter((u): u is string => typeof u === 'string')

  const payload: ResponsePayload = {
    distribution,
    totalPublished: published.length,
    recommendedCategory,
    suggestions,
    model: MODEL,
    groundingUrls,
  }

  return NextResponse.json({
    ...payload,
    signal_meta: signalContext.meta,
  })
}
