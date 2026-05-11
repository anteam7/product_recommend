import { NextResponse, type NextRequest } from 'next/server'
import { revalidatePath } from 'next/cache'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import {
  DEFAULT_REVIEW_PERSPECTIVES,
  GROUNDING_PRESET_PERSPECTIVES,
  type ReviewFinding,
} from '@/lib/blog'
import { logAdminAction } from '@/lib/admin-log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 90

const MODEL = 'gemini-2.5-flash'

const PERSPECTIVE_GUIDE: Record<string, string> = {
  'AI 문체':
    'AI가 쓴 티가 나는 상투구·과잉 마케팅 어휘·AI 연결어("결론적으로", "~는 매우 중요합니다", "혁신적인", "완벽한" 등), 도입부·결말 상투 패턴을 찾아내고 사람이 쓴 느낌으로 다시 써라. 종결어미는 ~습니다 70% + ~어요/예요 30% 혼용.',
  SEO:
    '타겟 키워드가 제목·도입부·H2에 자연스럽게 들어가 있는지, 메타 설명이 검색 스니펫에 적합한지(150자 이내), H2/H3 위계·내부 링크 활용, 검색 의도 매칭을 점검하고 고쳐라.',
  '클릭 유도':
    '검색 결과에서 클릭하고 싶은 제목·메타 설명인지. 숫자·연도·비교·반전 요소가 있는지. 낚시성 아니면서도 후킹되는 표현으로 제목/설명을 개선. 본문 도입부 첫 문장도 이탈 줄이는 쪽으로.',
  '유입 잠재력':
    '타겟 키워드의 검색 수요·관련 롱테일 키워드 반영·카니발라이제이션 여부. 본문 내 관련 키워드 자연 삽입으로 유입 경로를 넓혀라. 제목에 검색량 있는 표현을 우선.',
  '팩트 검증':
    '본문에 등장하는 숫자·금액·연도·회사명·정책·환율·세율 등 **사실 주장**을 Google Search로 하나씩 검증하라. 틀렸거나 오래된 수치는 **최신 공신력 있는 출처로 교체하고**, issues에 "원문 값 → 교체 값" 형식으로 명시하라. 확정적 출처가 없으면 단정 표현을 완화("약", "~기준", "시기에 따라 다름")하는 식으로 고쳐라. 새 사실을 지어내지 말 것.',
}

function buildSystemPrompt(perspectives: string[]) {
  const guides = perspectives
    .map((p) => {
      const built = PERSPECTIVE_GUIDE[p]
      return built
        ? `- **${p}**: ${built}`
        : `- **${p}**: 이 관점에서 문제를 찾고 개선안을 반영해 본문/제목/메타 설명을 고쳐라.`
    })
    .join('\n')

  return `# 역할

당신은 짐스캐너(jimscanner.co.kr, 해외 배대지 비교 플랫폼) 운영자의 편집자입니다.
이미 작성된 블로그 글을 **지정된 관점**에서 검토하고, **그 관점에서 부족한 부분만** 최소한으로 수정하여 개선된 버전을 돌려줍니다.

# 검토 관점
${guides}

# 수정 원칙 (매우 중요)

1. **사실 데이터 보존**: 숫자·금액·연도·배대지명·URL은 입력 그대로 유지. 새 숫자/URL 창작 금지.
2. **구조 보존**: H2·H3 개수·순서는 가급적 유지. 필요할 때만 조정.
3. **길이 보존**: 본문 전체 길이를 크게 줄이거나 두 배 늘리지 말 것. ±20% 이내.
4. **톤 보존**: 원문이 ~해요/~습니다 혼용이면 그대로. 갑자기 학술체나 마케팅체로 바꾸지 말 것.
5. **관점 밖 개입 금지**: 제시된 관점과 관련 없는 곳은 건드리지 말 것. 예: "SEO" 관점 한 개만 주어졌으면 FAQ는 그대로 둘 것.
6. **findings 필수**: 각 관점에서 "무엇이 문제였고" "무엇을 고쳤는지" 간결히 기록.

# 금지 표현 (AI 문체 관점에서 특히 주의)

혁신적인 / 놀라운 / 완벽한 / 최고의 / 압도적인 / 믿을 수 없는 / 반드시 / 분명히 / 확실히
"오늘은 ~에 대해 알아보겠습니다" / "결론적으로" / "종합적으로" / "요약하자면"
"~는 매우 중요합니다" / "~을 이해하는 것이 핵심입니다" / "다음과 같은 장점이 있습니다"
"이상으로 ~을 살펴봤습니다" / "이 글이 도움이 되었길 바랍니다"

# 출력 형식 (JSON만, 앞뒤 설명·코드펜스 금지)

{
  "findings": [
    {
      "perspective": "관점명 (입력과 정확히 동일)",
      "issues": ["발견된 문제 1", "문제 2"],
      "suggestions": ["어떻게 고쳤는지 한 줄 설명 1", "..."]
    }
  ],
  "summary": "이번 검토의 한 줄 요약",
  "title": "수정된 제목 (변경 없으면 원본 그대로)",
  "description": "수정된 메타 설명 (변경 없으면 원본 그대로, 150자 이내)",
  "content": "수정된 본문 마크다운 전체 (변경 없으면 원본 그대로)"
}

- findings 배열은 입력된 관점 수만큼. 이슈가 없으면 issues/suggestions 빈 배열.
- title/description/content 3개는 **항상** 출력. 안 바꿨어도 원본을 그대로 복사.
- 본문 맨 앞에 '# 제목' 같은 H1 절대 넣지 말 것 (제목은 title 필드로만).`
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

async function requireAdmin() {
  const sb = await createClient()
  const {
    data: { user },
  } = await sb.auth.getUser()
  if (!user || !isAdminEmail(user.email)) return null
  return user
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { slug } = await params
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return NextResponse.json({ error: 'GEMINI_API_KEY 미설정' }, { status: 500 })

  const body = (await request.json().catch(() => ({}))) as {
    perspectives?: unknown
    useGrounding?: unknown
  }
  const requested = Array.isArray(body.perspectives)
    ? (body.perspectives as unknown[])
        .map((p) => (typeof p === 'string' ? p.trim() : ''))
        .filter((p) => p.length > 0 && p.length <= 40)
    : []
  const perspectives =
    requested.length > 0 ? Array.from(new Set(requested)) : [...DEFAULT_REVIEW_PERSPECTIVES]

  if (perspectives.length > 10) {
    return NextResponse.json({ error: '관점은 최대 10개까지 가능합니다' }, { status: 400 })
  }

  // 팩트 검증이 포함되면 grounding 없이 돌리지 못하게 강제. 그 외엔 호출자 선택.
  const requiresGrounding = perspectives.some((p) =>
    GROUNDING_PRESET_PERSPECTIVES.includes(p),
  )
  const useGrounding = body.useGrounding === true || requiresGrounding

  const admin = createAdminClient()
  const { data: post } = await admin
    .from('jimscanner_blog_posts')
    .select('title, description, content, category, target_keywords, status, tags')
    .eq('slug', slug)
    .maybeSingle<{
      title: string
      description: string | null
      content: string
      category: string
      target_keywords: string[]
      status: string
      tags: string[]
    }>()

  if (!post) return NextResponse.json({ error: 'Post not found' }, { status: 404 })

  const userPrompt = `아래 짐스캐너 블로그 글을 위의 관점에서만 검토·수정하세요.
원문의 사실·숫자·구조는 보존하고, 관점과 관련 없는 곳은 건드리지 마세요.

# 제목
${post.title}

# 메타 설명
${post.description ?? '(비어있음)'}

# 카테고리
${post.category}

# 타겟 키워드
${post.target_keywords.join(', ') || '(없음)'}

# 태그
${(post.tags ?? []).join(', ') || '(없음)'}

# 본문 (마크다운)
${post.content}

---

위 글을 지정 관점(${perspectives.join(' / ')})에서만 개선해 JSON으로 출력하세요.`

  const requestBody: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: buildSystemPrompt(perspectives) }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 16384 },
  }
  if (useGrounding) {
    requestBody.tools = [{ google_search: {} }]
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
    },
  )

  if (!res.ok) {
    const t = await res.text()
    return NextResponse.json({ error: `Gemini ${res.status}: ${t.slice(0, 500)}` }, { status: 502 })
  }

  const gemini = (await res.json()) as {
    candidates?: {
      content?: { parts?: { text?: string }[] }
      finishReason?: string
      groundingMetadata?: {
        groundingChunks?: { web?: { uri?: string; title?: string } }[]
      }
    }[]
    promptFeedback?: { blockReason?: string }
    usageMetadata?: {
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

  if (!parsed) {
    const finishReason = candidate?.finishReason
    const hint =
      finishReason === 'MAX_TOKENS'
        ? ' (토큰 한도 초과)'
        : gemini.promptFeedback?.blockReason
          ? ` (세이프티 차단: ${gemini.promptFeedback.blockReason})`
          : ''
    return NextResponse.json(
      {
        error: `AI 응답 파싱 실패${hint}`,
        finishReason,
        usage: gemini.usageMetadata,
        raw: rawText.slice(0, 800),
      },
      { status: 502 },
    )
  }

  const nextTitle = typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : post.title
  const nextDescription =
    typeof parsed.description === 'string' ? parsed.description.trim() : post.description
  const nextContent =
    typeof parsed.content === 'string' && parsed.content.trim() ? parsed.content : post.content

  const findings: ReviewFinding[] = Array.isArray(parsed.findings)
    ? (parsed.findings as unknown[])
        .map((f) => {
          if (!f || typeof f !== 'object') return null
          const o = f as Record<string, unknown>
          return {
            perspective: typeof o.perspective === 'string' ? o.perspective : '',
            issues: Array.isArray(o.issues)
              ? (o.issues as unknown[]).filter((x): x is string => typeof x === 'string')
              : [],
            suggestions: Array.isArray(o.suggestions)
              ? (o.suggestions as unknown[]).filter((x): x is string => typeof x === 'string')
              : [],
          }
        })
        .filter((f): f is ReviewFinding => f !== null && f.perspective.length > 0)
    : []

  const summary = typeof parsed.summary === 'string' ? parsed.summary : null

  const groundingUrls = (candidate?.groundingMetadata?.groundingChunks ?? [])
    .map((c) => c.web?.uri)
    .filter((u): u is string => typeof u === 'string')

  const contentChanged = nextContent !== post.content
  const titleChanged = nextTitle !== post.title
  const descChanged = nextDescription !== post.description

  // 본문/제목/메타 중 하나라도 바뀌면 적용
  if (contentChanged || titleChanged || descChanged) {
    const { error: upErr } = await admin
      .from('jimscanner_blog_posts')
      .update({
        title: nextTitle,
        description: nextDescription,
        content: nextContent,
        updated_at: new Date().toISOString(),
      })
      .eq('slug', slug)
    if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 })
  }

  // 처음 사용된 커스텀 관점은 프리셋으로 저장 (기본 4개는 제외)
  const defaults = new Set<string>(DEFAULT_REVIEW_PERSPECTIVES)
  const customToSave = perspectives.filter((p) => !defaults.has(p))
  if (customToSave.length > 0) {
    await admin
      .from('jimscanner_blog_review_perspectives')
      .upsert(
        customToSave.map((name) => ({ name, created_by: user.email })),
        { onConflict: 'name', ignoreDuplicates: true },
      )
  }

  const { data: review, error: insErr } = await admin
    .from('jimscanner_blog_post_reviews')
    .insert({
      post_slug: slug,
      created_by: user.email,
      model: MODEL,
      perspectives,
      findings,
      summary,
      title_before: post.title,
      title_after: nextTitle,
      description_before: post.description,
      description_after: nextDescription,
      content_before: post.content,
      content_after: nextContent,
      applied: contentChanged || titleChanged || descChanged,
      grounding_urls: groundingUrls,
    })
    .select()
    .single()

  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 })

  await logAdminAction({
    actor: user.email,
    action: 'blog_review',
    target_type: 'blog_post',
    target_id: slug,
    summary: `AI 검토: ${perspectives.join(', ')} · ${
      contentChanged || titleChanged || descChanged ? '반영됨' : '변경 없음'
    }`,
    metadata: {
      perspectives,
      useGrounding,
      changed: { title: titleChanged, description: descChanged, content: contentChanged },
      review_id: review?.id,
    },
  })

  if (post.status === 'published' && (contentChanged || titleChanged || descChanged)) {
    revalidatePath('/blog', 'layout')
    revalidatePath(`/blog/${slug}`, 'layout')
  }

  return NextResponse.json({
    ok: true,
    review,
    changed: { title: titleChanged, description: descChanged, content: contentChanged },
    grounding: { used: useGrounding, urls: groundingUrls },
  })
}
