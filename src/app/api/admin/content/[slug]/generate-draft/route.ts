import { NextResponse, type NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { requireAdminAndForwarder } from '@/lib/content-api'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const MODEL = 'gemini-2.5-flash'

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

async function fetchSourceText(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; jimscanner-bot/1.0; +https://jimscanner.co.kr/about)',
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return `[fetch failed: HTTP ${res.status}]`
    const html = await res.text()
    const text = stripHtml(html)
    return text.slice(0, 8000)
  } catch (err) {
    return `[fetch error: ${err instanceof Error ? err.message : String(err)}]`
  }
}

const SYSTEM_PROMPT = `당신은 한국 해외직구·배대지 정보 사이트의 에디터입니다.
주어진 배대지의 공식 사이트 텍스트를 읽고, 아래 JSON 스키마 형식으로만 응답하세요.

중요한 원칙:
- 제공된 공식 사이트 텍스트에 명시된 사실만 사용하세요.
- 불확실하거나 텍스트에 없는 정보는 빈 문자열/빈 배열로 두세요.
- 추측하거나 창작하지 마세요.
- 경쟁 업체를 비방하지 말고, 중립적이고 정보 제공적인 어조를 유지하세요.
- 해외직구 초보자도 이해할 수 있게 쉽게 풀어 쓰세요.
- 숫자(요금, 수수료)는 텍스트에 있는 경우에만 포함하고, 단위(원/달러/엔)를 명확히.
- overview는 500~800자, 각 list 항목은 제목 10~30자 + 설명 80~200자.

출력 형식(JSON만, 앞뒤에 설명·코드블록 금지):
{
  "overview": "회사 소개 500~800자",
  "strengths": [{"title": "강점 제목", "description": "상세 설명"}],
  "weaknesses": [{"title": "주의점 제목", "description": "상세 설명"}],
  "service_features": [{"title": "서비스명", "description": "상세 설명"}],
  "pricing_notes": "요금 체계 설명 200~400자",
  "recommended_for": "어떤 사용자에게 적합한지 150~300자",
  "usage_tips": [{"title": "팁 제목", "description": "상세 설명"}],
  "faq": [{"question": "이 배대지 특화 질문", "answer": "답변"}]
}`

type DraftJson = {
  overview?: string
  strengths?: { title: string; description: string }[]
  weaknesses?: { title: string; description: string }[]
  service_features?: { title: string; description: string }[]
  pricing_notes?: string
  recommended_for?: string
  usage_tips?: { title: string; description: string }[]
  faq?: { question: string; answer: string }[]
}

function extractJson(text: string): DraftJson | null {
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

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params
  const auth = await requireAdminAndForwarder(slug)
  if ('response' in auth) return auth.response

  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    return NextResponse.json(
      { error: 'GEMINI_API_KEY 환경 변수가 설정되지 않았습니다.' },
      { status: 500 },
    )
  }

  const body = await request.json().catch(() => ({}))
  const sourceUrl: string | null = body.sourceUrl ?? auth.ctx.forwarderWebsite
  if (!sourceUrl) {
    return NextResponse.json(
      { error: '공식 사이트 URL이 없습니다. 먼저 forwarders.website 값을 설정하세요.' },
      { status: 400 },
    )
  }

  const sourceText = await fetchSourceText(sourceUrl)
  const userPrompt = `배대지 이름: ${auth.ctx.forwarderName}
공식 사이트: ${sourceUrl}

--- 공식 사이트에서 추출한 텍스트 ---
${sourceText}
--- 끝 ---

위 텍스트를 참고해 JSON 스키마 형식으로 초안을 작성하세요. 텍스트에 없는 내용은 빈 값으로.`

  const geminiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.4,
          maxOutputTokens: 8192,
        },
      }),
    },
  )

  if (!geminiRes.ok) {
    const errText = await geminiRes.text()
    return NextResponse.json(
      { error: `Gemini API ${geminiRes.status}: ${errText.slice(0, 500)}` },
      { status: 502 },
    )
  }

  const geminiJson = (await geminiRes.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[]
  }
  const rawText = geminiJson.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
  const draft = extractJson(rawText)

  if (!draft) {
    return NextResponse.json(
      {
        error: 'AI 응답을 JSON으로 파싱하지 못했습니다.',
        raw: rawText.slice(0, 1000),
      },
      { status: 502 },
    )
  }

  const admin = createAdminClient()
  const { data, error } = await admin
    .from('jimscanner_forwarder_content')
    .upsert(
      {
        forwarder_id: auth.ctx.forwarderId,
        status: 'draft',
        overview: draft.overview ?? null,
        strengths: draft.strengths ?? [],
        weaknesses: draft.weaknesses ?? [],
        service_features: draft.service_features ?? [],
        pricing_notes: draft.pricing_notes ?? null,
        recommended_for: draft.recommended_for ?? null,
        usage_tips: draft.usage_tips ?? [],
        faq: draft.faq ?? [],
        source_urls: [sourceUrl],
        created_by: auth.ctx.userEmail,
      },
      { onConflict: 'forwarder_id' },
    )
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, content: data, model: MODEL })
}
