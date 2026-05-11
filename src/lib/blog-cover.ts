import { createAdminClient } from '@/lib/auth/admin-supabase'
import type { BlogCategory } from '@/lib/blog'

const BUCKET = 'blog-covers'
const MODELS = [
  'gemini-3.1-flash-image-preview', // Nano Banana 2 (2026-02)
  'gemini-2.5-flash-image',          // Nano Banana 1 (폴백)
]

// 카테고리별 색감 팔레트 — 독자가 목록에서 카테고리를 시각적으로 구분하도록
const CATEGORY_PALETTES: Record<BlogCategory, string> = {
  가이드: 'warm cream background with deep navy and soft gold accents, trustworthy editorial mood',
  추천: 'soft sage green background with mustard yellow and terracotta accents, friendly magazine mood',
  비교: 'soft sky blue background with coral and slate gray accents, analytical clean mood',
  팁: 'pale lavender background with mint green and dusty rose accents, playful light mood',
  뉴스: 'light warm gray background with deep burgundy and muted teal accents, serious newsroom mood',
}

const COMMON_STYLE_FRAGMENT = `Style: flat vector illustration, professional magazine-cover quality.
Composition: centered hero composition, no text overlays, no watermark, generous negative space, 16:9 landscape aspect ratio suitable for blog og-image.`

function buildPrompt(title: string, category: BlogCategory | null, customPrompt?: string | null): string {
  if (customPrompt && customPrompt.trim().length > 0) return customPrompt
  const palette = category ? CATEGORY_PALETTES[category] : CATEGORY_PALETTES.가이드
  return `A clean, modern editorial illustration for a Korean blog cover about international online shopping and shipping forwarders.

Color palette: ${palette}.
${COMMON_STYLE_FRAGMENT}

Topic: ${title}`
}

type GenerateCoverResult = {
  publicUrl: string
  modelUsed: string
  sizeKB: number
}

export async function generateAndStoreBlogCover({
  slug,
  title,
  category,
  customPrompt,
  geminiKey,
}: {
  slug: string
  title: string
  category?: BlogCategory | null
  customPrompt?: string | null
  geminiKey: string
}): Promise<GenerateCoverResult> {
  const prompt = buildPrompt(title, category ?? null, customPrompt)

  let response: Response | null = null
  let modelUsed = ''
  let lastError = ''

  for (const model of MODELS) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseModalities: ['IMAGE'] },
        }),
      },
    )
    if (res.ok) {
      response = res
      modelUsed = model
      break
    }
    const t = await res.text()
    lastError = `${model} → ${res.status}: ${t.slice(0, 200)}`
  }

  if (!response) {
    throw new Error(`이미지 생성 실패: ${lastError}`)
  }

  const data = (await response.json()) as {
    candidates?: {
      content?: {
        parts?: { inlineData?: { data?: string; mimeType?: string } }[]
      }
    }[]
  }
  const imagePart = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)
  if (!imagePart?.inlineData?.data) {
    throw new Error('이미지 응답 없음')
  }
  const b64 = imagePart.inlineData.data
  const mimeType = imagePart.inlineData.mimeType ?? 'image/png'
  const ext = mimeType.includes('jpeg') ? 'jpg' : 'png'

  const buffer = Buffer.from(b64, 'base64')
  const path = `${slug}.${ext}`

  const admin = createAdminClient()
  const { error: upErr } = await admin.storage.from(BUCKET).upload(path, buffer, {
    contentType: mimeType,
    upsert: true,
    cacheControl: '31536000',
  })
  if (upErr) {
    throw new Error(`Storage 업로드 실패: ${upErr.message}`)
  }

  const { data: urlData } = admin.storage.from(BUCKET).getPublicUrl(path)
  // 캐시 버스팅 쿼리
  const publicUrl = `${urlData.publicUrl}?v=${Date.now()}`

  return {
    publicUrl,
    modelUsed,
    sizeKB: Math.round(buffer.length / 1024),
  }
}
