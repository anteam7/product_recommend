import { NextResponse, type NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { logAdminAction } from '@/lib/admin-log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const MODEL = 'gemini-2.5-pro'

const SYSTEM_PROMPT = `당신은 해외 쇼핑 세일 이벤트의 "지금 열리는" 공식·뉴스 URL 을 찾는 역할입니다.

# 목표
제공된 이벤트의 **공식 랜딩 페이지 또는 주요 매체 기사 URL** 하나를 반환. 반드시 Google Search grounding 으로 실제 열리는 URL 만.

# 허용 유형
1. 뉴스 / 블로그 기사 (TechRadar, CNET, The Verge, NRF, 한국 매체 등) — 해당 이벤트의 날짜·할인 정리된 기사. 최우선.
2. 브랜드·리테일러의 상시 세일 카테고리 — 실제 할인 상품이 **현재 노출되는** 경우에만. 예: \`uniqlo.com/jp/ja/feature/sale/women\`, \`nordstrom.com/sale\`.

# 금지
- 시즈널 이벤트 랜딩 (세일 기간에만 활성화되는 URL): \`amazon.com/primeday\`, \`event.rakuten.co.jp/supersale/\`, \`event.rakuten.co.jp/campaign/marathon/\`, \`aliexpress.com/p/sale/\` 류.
- 도메인 루트 (\`aliexpress.com/\`, \`amazon.co.jp/\`) — 세일 정보 없음.
- 검증 안 된 추측 URL.

# 검증
Google Search grounding 으로 URL 근거 확보. URL 이 정말 해당 이벤트의 할인 정보를 담고 있는지 확인.
확실한 것 없으면 \`null\`.

# 출력 (JSON, 앞뒤 설명·코드펜스 금지)

{
  "url": "https://...",          // 못 찾으면 null
  "source_url": "https://...",   // grounding URL (있으면)
  "reason": "왜 이 URL 을 골랐는지 한 문장 (또는 왜 못 찾았는지)"
}`

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
  const first = candidate.indexOf('{')
  const last = candidate.lastIndexOf('}')
  if (first === -1 || last === -1) return null
  try {
    return JSON.parse(candidate.slice(first, last + 1))
  } catch {
    return null
  }
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return NextResponse.json({ error: 'GEMINI_API_KEY 미설정' }, { status: 500 })

  const { id } = await params
  const admin = createAdminClient()

  const { data: event } = await admin
    .from('jimscanner_sale_events')
    .select('id, name, country, start_at, end_at, description, status, external_url')
    .eq('id', id)
    .maybeSingle<{
      id: string
      name: string
      country: string
      start_at: string | null
      end_at: string | null
      description: string | null
      status: string
      external_url: string | null
    }>()

  if (!event) return NextResponse.json({ error: 'Event not found' }, { status: 404 })

  const userPrompt = `이벤트 정보:
- 이름: ${event.name}
- 국가: ${event.country}
- 기간: ${event.start_at ?? '미정'}${event.end_at && event.end_at !== event.start_at ? ` ~ ${event.end_at}` : ''}
- 설명: ${event.description ?? '(없음)'}
- 기존 URL: ${event.external_url ?? 'NULL'}

지금 이 시점에 열리는 URL 하나를 찾아서 JSON 으로 반환하세요. 없으면 url=null.`

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 4096 },
      }),
    },
  )

  if (!res.ok) {
    const t = await res.text()
    return NextResponse.json({ error: `Gemini ${res.status}: ${t.slice(0, 400)}` }, { status: 502 })
  }

  const gemini = (await res.json()) as {
    candidates?: {
      content?: { parts?: { text?: string }[] }
      finishReason?: string
      groundingMetadata?: {
        groundingChunks?: { web?: { uri?: string; title?: string } }[]
      }
    }[]
  }

  const candidate = gemini.candidates?.[0]
  const rawText = (candidate?.content?.parts ?? [])
    .map((p) => p?.text ?? '')
    .join('')
  const parsed = extractJson(rawText)

  if (!parsed) {
    return NextResponse.json(
      {
        error: 'AI 응답 파싱 실패',
        finishReason: candidate?.finishReason,
        raw: rawText.slice(0, 400),
      },
      { status: 502 },
    )
  }

  const newUrl = typeof parsed.url === 'string' && parsed.url.startsWith('http') ? parsed.url : null
  const sourceUrl =
    typeof parsed.source_url === 'string' && parsed.source_url.startsWith('http')
      ? parsed.source_url
      : (candidate?.groundingMetadata?.groundingChunks ?? [])
          .map((c) => c.web?.uri)
          .find((u) => typeof u === 'string') ?? null
  const reason = typeof parsed.reason === 'string' ? parsed.reason : null

  // 실제 업데이트 — url 이 null 이어도 source_url/reason 은 반환만
  let updated = false
  if (newUrl && newUrl !== event.external_url) {
    const { error: upErr } = await admin
      .from('jimscanner_sale_events')
      .update({
        external_url: newUrl,
        source_url: sourceUrl ?? undefined,
      })
      .eq('id', id)
    if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 })
    updated = true
  }

  await logAdminAction({
    actor: user.email,
    action: 'deal_refresh_url',
    target_type: 'sale_event',
    target_id: id,
    summary: updated
      ? `URL 자동 갱신: ${event.name} → ${newUrl}`
      : `URL 갱신 시도 (결과 없음): ${event.name}`,
    metadata: { url: newUrl, reason, source_url: sourceUrl },
  })

  if (updated && event.status === 'active') {
    revalidatePath('/deals', 'layout')
    revalidatePath('/', 'layout')
  }

  return NextResponse.json({
    ok: true,
    url: newUrl,
    source_url: sourceUrl,
    reason,
    updated,
  })
}
