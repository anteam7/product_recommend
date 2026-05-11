import { NextResponse, type NextRequest } from 'next/server'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 90

const MODEL = 'gemini-2.5-pro'

const SYSTEM_PROMPT = `# 역할

당신은 짐스캐너 블로그 글 생성용 **system prompt 의 편집자**입니다.
현재 운영 중인 system prompt 와 최근 검토에서 누적된 문제 패턴을 받아서,
같은 문제가 반복되지 않도록 system prompt 를 업데이트한 **새 버전**을 제안합니다.

# 원칙 (엄격)

1. **base prompt 의 구조·기조·서식을 유지**하라. 통째로 새로 쓰지 말 것. 마크다운 헤딩 구조, 섹션 순서, 톤은 그대로.
2. **자주 나온 issues**(빈도 높은 항목 위주) 만 반영. 1~2회밖에 안 나온 것은 노이즈로 간주하고 skipped_findings 에 분류.
3. 추가는 적절한 섹션에. 예:
   - 자주 등장한 AI 상투구 → "절대 금지 표현" 섹션
   - SEO 관련 빠진 규칙 → "구조 제한" 또는 "필수 포함"
   - 사실 오류 패턴 → "사실 데이터 원칙"
4. **이미 base 에 있는 규칙은 중복 추가 금지**. 강화가 필요하면 같은 섹션에서 한두 단어만 보강.
5. 반대 의견·예외가 없는 한 **기존 규칙을 삭제하지 말 것**. 보강만.
6. **분량 폭증 금지**. base 대비 +30% 이상 늘어나면 우선순위 낮은 추가는 빼라.
7. 추가 규칙에 빈도 정보 표기 권장 — 예: "이 표현은 검토에서 12건 발견됨" 식의 메타는 본문에 박지 말고 applied_findings 에만 기록.

# 출력 형식 (JSON 만, 앞뒤 설명·코드펜스 금지)

{
  "proposed_prompt": "전체 새 system prompt 본문 (마크다운 그대로)",
  "change_summary": "한~두 문장으로 무엇을 어떻게 바꿨는지",
  "applied_findings": [
    {
      "source": "manual|pipeline",
      "perspective_or_axis": "AI 문체 / SEO / human_likeness 등",
      "issue": "원문 이슈 텍스트",
      "frequency": 8,
      "applied_section": "절대 금지 표현 / 구조 제한 / 사실 데이터 원칙 등",
      "how": "어떤 표현을 어디에 추가/수정했는지 한 줄"
    }
  ],
  "skipped_findings": [
    {
      "issue": "원문 이슈 텍스트",
      "reason": "이미 base 에 있음 / 1회만 등장(노이즈) / 모순 / 너무 구체적"
    }
  ]
}`

type AggregateInput = {
  filters: Record<string, unknown>
  manual: {
    perspectives: {
      perspective: string
      total_reviews: number
      issues: { issue: string; count: number }[]
      suggestions: { issue: string; count: number }[]
    }[]
    used_review_ids: string[]
    total_reviews: number
  }
  pipeline: {
    axes: {
      axis: string
      avg_score: number | null
      sample_count: number
      issues: { issue: string; count: number }[]
      suggestions: { issue: string; count: number }[]
    }[]
    sample_count: number
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

function formatAggregate(a: AggregateInput): string {
  const lines: string[] = []
  lines.push(`## 검토 집계 요약`)
  lines.push(
    `- 수동 검토: ${a.manual.total_reviews}건 / 파이프라인 샘플: ${a.pipeline.sample_count}건`,
  )
  lines.push(`- 필터: ${JSON.stringify(a.filters)}`)
  lines.push('')

  if (a.manual.perspectives.length > 0) {
    lines.push(`## 수동 검토 관점별 빈도`)
    for (const p of a.manual.perspectives) {
      lines.push(`### 관점: ${p.perspective} (반영 ${p.total_reviews}건)`)
      if (p.issues.length > 0) {
        lines.push(`이슈 빈도:`)
        for (const i of p.issues) lines.push(`- (${i.count}회) ${i.issue}`)
      }
      if (p.suggestions.length > 0) {
        lines.push(`개선 제안 빈도:`)
        for (const s of p.suggestions) lines.push(`- (${s.count}회) ${s.issue}`)
      }
      lines.push('')
    }
  }

  if (a.pipeline.axes.length > 0) {
    lines.push(`## 파이프라인 5축 점수·빈도`)
    for (const ax of a.pipeline.axes) {
      lines.push(
        `### ${ax.axis} — 평균 ${ax.avg_score ?? 'N/A'}/10 (샘플 ${ax.sample_count})`,
      )
      if (ax.issues.length > 0) {
        lines.push(`이슈 빈도:`)
        for (const i of ax.issues) lines.push(`- (${i.count}회) ${i.issue}`)
      }
      if (ax.suggestions.length > 0) {
        lines.push(`개선 제안 빈도:`)
        for (const s of ax.suggestions) lines.push(`- (${s.count}회) ${s.issue}`)
      }
      lines.push('')
    }
  }

  return lines.join('\n')
}

export async function POST(request: NextRequest) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = (await request.json().catch(() => ({}))) as {
    base_prompt_id?: unknown
    aggregate?: unknown
    guidance?: unknown
  }

  const basePromptId = typeof body.base_prompt_id === 'string' ? body.base_prompt_id : ''
  if (!basePromptId) return NextResponse.json({ error: 'base_prompt_id 필수' }, { status: 400 })

  if (!body.aggregate || typeof body.aggregate !== 'object') {
    return NextResponse.json({ error: 'aggregate 필수' }, { status: 400 })
  }
  const aggregate = body.aggregate as AggregateInput

  const totalSignal =
    (aggregate.manual?.total_reviews ?? 0) + (aggregate.pipeline?.sample_count ?? 0)
  if (totalSignal === 0) {
    return NextResponse.json(
      { error: '집계 결과가 비어 있습니다. 필터를 완화하거나 검토 로그가 더 쌓일 때까지 기다리세요.' },
      { status: 400 },
    )
  }

  const guidance = typeof body.guidance === 'string' ? body.guidance.trim() : ''

  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return NextResponse.json({ error: 'GEMINI_API_KEY 미설정' }, { status: 500 })

  const admin = createAdminClient()
  const { data: base, error: baseErr } = await admin
    .from('jimscanner_blog_generation_prompts')
    .select('id, version, label, system_prompt')
    .eq('id', basePromptId)
    .maybeSingle()
  if (baseErr) return NextResponse.json({ error: baseErr.message }, { status: 500 })
  if (!base) return NextResponse.json({ error: 'base prompt not found' }, { status: 404 })

  const formatted = formatAggregate(aggregate)

  const userPrompt = `현재 운영 중인 base system prompt (v${base.version} — ${base.label}):

\`\`\`
${base.system_prompt}
\`\`\`

${formatted}

${guidance ? `## 추가 지시 (운영자가 수동으로 첨부)\n${guidance}\n` : ''}
위 base 의 구조를 유지하면서, 누적 빈도 높은 issues 를 적절한 섹션에 보강해 새 system prompt 를 제안하세요.
applied_findings·skipped_findings 에 처리 내역을 명시하고, change_summary 에 한~두 문장 요약을 적으세요.`

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 16384,
          responseMimeType: 'application/json',
        },
      }),
    },
  )

  if (!res.ok) {
    const t = await res.text()
    return NextResponse.json(
      { error: `Gemini ${res.status}: ${t.slice(0, 500)}` },
      { status: 502 },
    )
  }

  const gemini = (await res.json()) as {
    candidates?: {
      content?: { parts?: { text?: string }[] }
      finishReason?: string
    }[]
    promptFeedback?: { blockReason?: string }
    usageMetadata?: { totalTokenCount?: number }
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
        usage: gemini.usageMetadata,
        raw: rawText.slice(0, 800),
      },
      { status: 502 },
    )
  }

  const proposed =
    typeof parsed.proposed_prompt === 'string' ? parsed.proposed_prompt : ''
  if (!proposed.trim()) {
    return NextResponse.json({ error: 'proposed_prompt 가 비어있음', raw: rawText.slice(0, 800) }, { status: 502 })
  }

  return NextResponse.json({
    base: { id: base.id, version: base.version, label: base.label },
    proposed_prompt: proposed,
    change_summary: typeof parsed.change_summary === 'string' ? parsed.change_summary : '',
    applied_findings: Array.isArray(parsed.applied_findings) ? parsed.applied_findings : [],
    skipped_findings: Array.isArray(parsed.skipped_findings) ? parsed.skipped_findings : [],
    review_ids_used: aggregate.manual?.used_review_ids ?? [],
    char_count: { base: base.system_prompt.length, proposed: proposed.length },
    model: MODEL,
    usage: gemini.usageMetadata,
  })
}
