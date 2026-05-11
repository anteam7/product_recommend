import { NextResponse, type NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { logAdminAction } from '@/lib/admin-log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const MODEL = 'gemini-2.5-pro'

const SYSTEM_PROMPT = `당신은 짐스캐너(jimscanner.co.kr)를 운영하는 1인 개발자입니다.
이미 발행된 블로그 글에 FAQ 섹션을 추가/개선하는 작업을 합니다.

# 톤 원칙 (필수)
- 본문의 톤과 어휘를 그대로 이어가세요. AI 티가 나면 실패입니다.
- 제공된 본문이 "~해요/~습니다" 혼용이면 FAQ도 혼용. "사실", "의외로" 같은 구어체가 본문에 있으면 FAQ에도 자연스럽게 녹이기.
- 독자가 "이거 AI가 쓴 거 아냐?" 의심하지 않는 수준의 자연스러움이 목표.

# 절대 금지 표현
혁신적인 / 완벽한 / 최고의 / 놀라운 / 반드시 / 분명히 / 확실히
"~는 매우 중요합니다" / "~을 이해하는 것이 핵심입니다" / "다음과 같은 장점이 있습니다"
"~하시기 바랍니다" / "~라고 할 수 있습니다"

# FAQ 생성 규칙
- **정확히 5개**. 4개 이하·6개 이상 금지.
- 질문은 본문에서 이미 답한 내용의 재탕이 아니라, 독자가 추가로 궁금해할 실제 질문.
  예: 본문이 요금 비교라면 "할인 쿠폰은 어떻게 받나요?", "회원 등급별 차이는?", "합배송 시 추가비용?" 등.
- "~이 무엇인가요?" 같은 추상·일반 질문 나열 금지.
- 답변은 각 2~4문장, 50~200자. 본문 내용 반복 최소화하고 보완 정보 제공.
- 구체 숫자/예시를 녹일 수 있으면 활용 (제공된 본문에서 확인 가능한 것만).

# 사실성
- 본문과 제공된 컨텍스트에 없는 숫자·연도·사실은 창작 금지.
- 불확실한 건 "시기에 따라 다르다" / "각 업체에 확인 필요" 같이 모호하게.

# 출력 (JSON만, 코드블록·설명 없이)
{
  "faq": [
    {"question": "...", "answer": "..."},
    {"question": "...", "answer": "..."},
    {"question": "...", "answer": "..."},
    {"question": "...", "answer": "..."},
    {"question": "...", "answer": "..."}
  ]
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
  { params }: { params: Promise<{ slug: string }> },
) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { slug } = await params
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return NextResponse.json({ error: 'GEMINI_API_KEY 미설정' }, { status: 500 })

  const admin = createAdminClient()
  const { data: post } = await admin
    .from('jimscanner_blog_posts')
    .select('title, content, category, target_keywords, status, faq')
    .eq('slug', slug)
    .maybeSingle<{
      title: string
      content: string
      category: string
      target_keywords: string[]
      status: string
      faq: { question: string; answer: string }[]
    }>()

  if (!post) return NextResponse.json({ error: 'Post not found' }, { status: 404 })

  const userPrompt = `아래는 짐스캐너 블로그에 이미 발행된 글입니다. 이 글의 FAQ 섹션(정확히 5개)을 생성하세요.

# 글 제목
${post.title}

# 카테고리
${post.category}

# 타겟 키워드
${post.target_keywords.join(', ')}

# 기존 FAQ (참고용 — 이와 중복되지 않는 새 5개를 작성하되, 기존 2개의 톤·어휘는 참고)
${JSON.stringify(post.faq ?? [], null, 2)}

# 본문 (이 톤에 맞춰 FAQ 작성)
${post.content}

---

위 본문의 톤·어휘를 유지하면서 FAQ 정확히 5개를 생성하세요.
본문에 이미 답한 내용은 재탕하지 말고, 독자가 추가로 궁금해할 실제 질문을 다루세요.`

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.5, maxOutputTokens: 4096 },
      }),
    },
  )

  if (!res.ok) {
    const t = await res.text()
    return NextResponse.json({ error: `Gemini ${res.status}: ${t.slice(0, 500)}` }, { status: 502 })
  }

  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[]
  }
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
  const parsed = extractJson(rawText)
  if (!parsed || !Array.isArray(parsed.faq)) {
    return NextResponse.json(
      { error: 'JSON 파싱 실패', raw: rawText.slice(0, 500) },
      { status: 502 },
    )
  }
  const newFaq = (parsed.faq as { question: string; answer: string }[]).filter(
    (i) => i && typeof i.question === 'string' && typeof i.answer === 'string',
  )

  if (newFaq.length !== 5) {
    return NextResponse.json(
      { error: `FAQ 개수 불일치: ${newFaq.length}개 (5개 필요)`, faq: newFaq },
      { status: 502 },
    )
  }

  // **faq 필드만** 업데이트 (다른 필드는 절대 건드리지 않음)
  const { error: upErr } = await admin
    .from('jimscanner_blog_posts')
    .update({ faq: newFaq })
    .eq('slug', slug)

  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 })

  await logAdminAction({
    actor: user.email,
    action: 'blog_regenerate_faq',
    target_type: 'blog_post',
    target_id: slug,
    summary: `FAQ 재생성: ${post.title}`,
  })

  if (post.status === 'published') {
    revalidatePath('/blog', 'layout')
    revalidatePath(`/blog/${slug}`, 'layout')
  }

  return NextResponse.json({ ok: true, faq: newFaq, previousFaq: post.faq })
}
