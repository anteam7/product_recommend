import { NextResponse, type NextRequest } from 'next/server'
import { createClient, isAdminEmail } from '@/lib/auth/server'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { BLOG_CATEGORIES, type BlogCategory, slugify } from '@/lib/blog'
import { getActiveBlogPrompt } from '@/lib/blog-prompts'
import { generateAndStoreBlogCover } from '@/lib/blog-cover'
import { logAdminAction } from '@/lib/admin-log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 90

const MODEL = 'gemini-2.5-pro'

// 시스템 프롬프트는 DB(`jimscanner_blog_generation_prompts`)의 active 행을 사용.
// 코드 fallback 본문은 `lib/blog-prompts.ts`의 DEFAULT_BLOG_GENERATION_PROMPT 참조.

async function buildSiteContext() {
  const admin = createAdminClient()
  const [fwdRes, rateRes, exRes] = await Promise.all([
    admin
      .from('forwarders')
      .select('name, slug, website, description, pros, cons')
      .eq('is_active', true)
      .order('name'),
    admin
      .from('shipping_rates')
      .select('forwarder_id, country, weight_min, weight_max, price_krw, price_usd, price_jpy, price_cny, grade_level')
      .eq('grade_level', 1)
      .in('weight_min', [0.5, 1, 3, 5]),
    admin
      .from('jimscanner_exchange_rates')
      .select('currency, rate_krw, updated_at'),
  ])

  const fwd = fwdRes.data ?? []
  const rates = rateRes.data ?? []
  const fx = exRes.data ?? []

  const fwdByCountry: Record<string, typeof fwd> = { US: [], JP: [], CN: [] }
  const fwdMap = new Map(fwd.map((f) => [f.name, f]))

  // 1kg 기준 요금 정리 (grade_level=1 일반 등급)
  const pricing: Record<string, { name: string; slug: string; krw?: number; usd?: number }[]> = {
    US: [], JP: [], CN: [],
  }
  for (const r of rates) {
    const f = fwd.find((x) => x.slug && rates.some((_) => true) && x && x.slug && r.forwarder_id) as unknown
    void f
    // map by forwarder_id via admin join — simplified: only use matching rows when we query with forwarders include
  }

  // Simpler: fetch forwarder info by id
  const fwdByIdRes = await admin
    .from('forwarders')
    .select('id, name, slug')
    .eq('is_active', true)
  const idMap = new Map((fwdByIdRes.data ?? []).map((x) => [x.id, x]))

  const weight1kg = rates.filter((r) => r.weight_min === 1 || (r.weight_min <= 1 && r.weight_max >= 1))
  for (const r of weight1kg) {
    if (!r.forwarder_id) continue
    const f = idMap.get(r.forwarder_id)
    if (!f) continue
    const bucket = pricing[r.country as keyof typeof pricing]
    if (!bucket) continue
    bucket.push({ name: f.name, slug: f.slug, krw: r.price_krw ?? undefined, usd: r.price_usd ?? undefined })
  }
  for (const k of Object.keys(pricing)) {
    pricing[k].sort((a, b) => (a.krw ?? Infinity) - (b.krw ?? Infinity))
    pricing[k] = pricing[k].slice(0, 10)
  }

  void fwdByCountry
  void fwdMap

  const lines: string[] = []
  lines.push('## 짐스캐너 등록 배대지 (활성 ' + fwd.length + '곳)')
  lines.push(fwd.slice(0, 20).map((f) => `- ${f.name} (slug: ${f.slug})`).join('\n'))
  lines.push('')
  lines.push('## 1kg 기준 최저가 TOP 10 (일반 등급, KRW)')
  for (const country of ['US', 'JP', 'CN'] as const) {
    const list = pricing[country]
    if (list.length === 0) continue
    const flag = { US: '🇺🇸 미국', JP: '🇯🇵 일본', CN: '🇨🇳 중국' }[country]
    lines.push(`### ${flag}`)
    lines.push(
      list
        .map((p, i) => {
          const priceStr = p.krw ? `${p.krw.toLocaleString()}원` : p.usd ? `$${p.usd}` : '—'
          return `${i + 1}. ${p.name} · ${priceStr}`
        })
        .join('\n'),
    )
    lines.push('')
  }
  lines.push('## 현재 환율 (네이버 금융 매매기준율 · 하나은행 기준)')
  lines.push(
    fx
      .map((r) => {
        const disp = r.currency === 'JPY' ? `100 JPY = ${(r.rate_krw * 100).toFixed(2)}원` : `1 ${r.currency} = ${r.rate_krw.toFixed(2)}원`
        return `- ${disp}`
      })
      .join('\n'),
  )
  lines.push('')
  lines.push('## 사용 가능한 내부 링크 목록')
  lines.push('- / (홈)')
  lines.push('- /compare (전체 비교)')
  lines.push('- /compare/us, /compare/jp, /compare/cn (국가별 비교)')
  lines.push('- /forwarders (배대지 목록)')
  lines.push('- /exchange-rates (환율 동향)')
  lines.push('- /guide (직구 가이드)')
  lines.push(fwd.slice(0, 20).map((f) => `- /forwarders/${f.slug} (${f.name})`).join('\n'))

  return lines.join('\n')
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
  const firstBrace = candidate.indexOf('{')
  const lastBrace = candidate.lastIndexOf('}')
  if (firstBrace === -1 || lastBrace === -1) return null
  try {
    return JSON.parse(candidate.slice(firstBrace, lastBrace + 1))
  } catch {
    return null
  }
}

export async function POST(request: NextRequest) {
  const user = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => ({}))
  const category: BlogCategory = BLOG_CATEGORIES.includes(body.category)
    ? body.category
    : '가이드'

  const admin = createAdminClient()

  // 빈 글 생성 (AI 없이 수동 작성용)
  if (body.blank) {
    const slug = `draft-${Date.now()}`
    const { data, error } = await admin
      .from('jimscanner_blog_posts')
      .insert({
        slug,
        title: '(제목을 입력하세요)',
        content: '',
        category,
        status: 'draft',
        created_by: user.email,
      })
      .select()
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    await logAdminAction({
      actor: user.email,
      action: 'blog_create_blank',
      target_type: 'blog_post',
      target_id: slug,
      summary: `빈 블로그 초안 생성: ${category}`,
    })
    return NextResponse.json({ ok: true, post: data })
  }

  const keyword = String(body.keyword ?? '').trim()
  if (!keyword) return NextResponse.json({ error: 'keyword 필수' }, { status: 400 })
  const angle = body.angle ? String(body.angle).trim() : null

  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return NextResponse.json({ error: 'GEMINI_API_KEY 미설정' }, { status: 500 })

  // 기존 발행된 글의 키워드 (중복 회피)
  const { data: existing } = await admin
    .from('jimscanner_blog_posts')
    .select('title, target_keywords')
  const existingTitles = (existing ?? []).map((p) => p.title).filter(Boolean)

  const siteContext = await buildSiteContext()
  const promptResult = await getActiveBlogPrompt()

  const userPrompt = `타겟 키워드: "${keyword}"
카테고리: ${category}
${angle ? `특정 앵글: ${angle}` : ''}

이미 사이트에 발행된 블로그 제목 (중복 회피):
${existingTitles.length > 0 ? existingTitles.map((t) => `- ${t}`).join('\n') : '(없음)'}

짐스캐너 사이트 데이터:
${siteContext}

위 데이터와 Google Search 결과(grounding)를 결합해 JSON 스키마로 초안을 작성하세요.
특히 숫자/요금/배대지명은 위 데이터에서만 인용하세요. 내부 링크도 위 목록에서만.`

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: promptResult.text }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: {
          temperature: 0.5,
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
      groundingMetadata?: {
        groundingChunks?: { web?: { uri?: string; title?: string } }[]
      }
    }[]
  }

  const candidate = gemini.candidates?.[0]
  const rawText = candidate?.content?.parts?.[0]?.text ?? ''
  const draft = extractJson(rawText)

  if (!draft) {
    return NextResponse.json(
      { error: 'AI JSON 파싱 실패', raw: rawText.slice(0, 1000) },
      { status: 502 },
    )
  }

  // Grounding URL 수집
  const groundingUrls = (candidate?.groundingMetadata?.groundingChunks ?? [])
    .map((c) => c.web?.uri)
    .filter((u): u is string => typeof u === 'string')

  const baseSlug = slugify(String(draft.slug ?? draft.title ?? keyword))
  // slug 중복 해소
  let slug = baseSlug
  let suffix = 0
  while (true) {
    const { data: dup } = await admin
      .from('jimscanner_blog_posts')
      .select('slug')
      .eq('slug', slug)
      .maybeSingle()
    if (!dup) break
    suffix++
    slug = `${baseSlug}-${suffix}`
    if (suffix > 20) break
  }

  const title = String(draft.title ?? keyword)

  const { data: post, error } = await admin
    .from('jimscanner_blog_posts')
    .insert({
      slug,
      title,
      description: typeof draft.description === 'string' ? draft.description : null,
      content: String(draft.content ?? ''),
      category,
      tags: Array.isArray(draft.tags) ? (draft.tags as string[]).slice(0, 10) : [],
      target_keywords: [keyword],
      faq: Array.isArray(draft.faq) ? draft.faq : [],
      status: 'draft',
      source_urls: groundingUrls,
      seo_title: typeof draft.title === 'string' ? draft.title : null,
      seo_description: typeof draft.description === 'string' ? draft.description : null,
      author: '짐스캐너 운영자',
      created_by: user.email,
    })
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // 커버 이미지 자동 생성 (실패해도 draft 자체는 살림)
  let coverInfo: { publicUrl: string; modelUsed: string; sizeKB: number } | null = null
  let coverError: string | null = null
  try {
    coverInfo = await generateAndStoreBlogCover({
      slug,
      title,
      category,
      geminiKey: apiKey,
    })
    await admin
      .from('jimscanner_blog_posts')
      .update({ cover_image_url: coverInfo.publicUrl, og_image: coverInfo.publicUrl })
      .eq('slug', slug)
  } catch (err) {
    coverError = err instanceof Error ? err.message : String(err)
  }

  await logAdminAction({
    actor: user.email,
    action: 'blog_generate_draft',
    target_type: 'blog_post',
    target_id: slug,
    summary: `AI 초안 생성: "${keyword}" (${category})`,
    metadata: {
      keyword,
      category,
      angle,
      prompt_source: promptResult.source,
      prompt_version: promptResult.meta?.version ?? null,
      prompt_id: promptResult.meta?.id ?? null,
    },
  })

  return NextResponse.json({
    ok: true,
    post: coverInfo ? { ...post, cover_image_url: coverInfo.publicUrl, og_image: coverInfo.publicUrl } : post,
    model: MODEL,
    prompt: promptResult.meta
      ? { source: 'db', version: promptResult.meta.version, label: promptResult.meta.label }
      : { source: 'fallback' },
    cover: coverInfo ? { ...coverInfo } : null,
    coverError,
  })
}
