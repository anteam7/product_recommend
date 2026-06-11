/**
 * 스마트스토어 상세 상단 브랜드 배너 생성 — "몸에조은가게" 심플 브랜드 배너.
 *   1) Gemini 이미지로 배경 생성(텍스트 없는 보태니컬 배경 — AI 한글 렌더링 불안정 회피)
 *   2) sharp SVG 오버레이로 한글 카피 합성 (맑은 고딕)
 *   3) store-assets/brand-intro.jpg 교체 (기존본은 brand-intro-old.jpg 백업)
 *
 *   node --env-file=.env.local scripts/naver-brand-banner.mjs [--skip-bg]
 *   --skip-bg: .tmp/banner-bg.png 재사용(텍스트 레이아웃만 다시)
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

const GEMINI_KEY = process.env.GEMINI_API_KEY
if (!GEMINI_KEY) { console.error('GEMINI_API_KEY 누락'); process.exit(1) }
const SKIP_BG = process.argv.includes('--skip-bg')

const W = 1300, H = 440
const TMP = path.resolve(process.cwd(), '.tmp')
const BG_PATH = path.join(TMP, 'banner-bg.png')
const OUT = path.resolve(process.cwd(), 'store-assets', 'brand-intro.jpg')
const BACKUP = path.resolve(process.cwd(), 'store-assets', 'brand-intro-old.jpg')

const BG_PROMPT = `A clean horizontal banner background photograph for a Korean health supplement online store, aspect ratio 3:1 wide landscape.

Style: bright, airy, premium and trustworthy. Soft natural morning light. A plain warm ivory/cream surface fills the CENTER of the frame — the center 60% must be nearly empty, smooth, out-of-focus-free clean space reserved for text overlay.

Decoration only at the EDGES: soft out-of-focus fresh green leaves and botanical sprigs entering from the left and right edges, gentle bokeh, maybe a hint of a small glass bottle silhouette far at the right edge, heavily blurred.

Color palette: warm ivory #faf8f3 base, soft sage and fresh leaf greens, no saturated colors, no harsh shadows.

STRICTLY NO text, NO letters, NO logos, NO labels, NO people, NO hands. Photographic quality, not illustration.`

async function geminiImage(prompt) {
  for (const model of ['gemini-3.1-flash-image-preview', 'gemini-2.5-flash-image']) {
    console.log(`  시도: ${model}`)
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['IMAGE'] } }),
    })
    if (res.ok) {
      const data = await res.json()
      const part = (data.candidates?.[0]?.content?.parts ?? []).find((p) => p.inlineData?.data)
      if (part) return Buffer.from(part.inlineData.data, 'base64')
    } else console.log(`    ${res.status} ${(await res.text()).slice(0, 120)}`)
  }
  throw new Error('이미지 생성 실패 (모든 모델)')
}

await fs.mkdir(TMP, { recursive: true })
let bg
if (SKIP_BG) {
  bg = await fs.readFile(BG_PATH)
  console.log('배경 재사용:', BG_PATH)
} else {
  console.log('Gemini 배경 생성 중...')
  bg = await geminiImage(BG_PROMPT)
  await fs.writeFile(BG_PATH, bg)
  console.log('배경 저장:', BG_PATH)
}

// 텍스트 오버레이 (SVG) — 가운데 정렬, 잎 모티프는 배경이 담당
const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <style>
    .name { font-family: 'Malgun Gothic', sans-serif; font-weight: 700; font-size: 86px; fill: #2f3b2f; letter-spacing: 2px; }
    .copy { font-family: 'Malgun Gothic', sans-serif; font-weight: 400; font-size: 34px; fill: #5d6b5d; letter-spacing: 6px; }
  </style>
  <text x="50%" y="218" text-anchor="middle" class="name">몸에조은가게</text>
  <line x1="${W / 2 - 170}" y1="262" x2="${W / 2 + 170}" y2="262" stroke="#9fae9b" stroke-width="1.5"/>
  <text x="50%" y="326" text-anchor="middle" class="copy">몸에 좋은 것만 골라 담았습니다</text>
</svg>`

// 배경을 1300x440 cover 리사이즈 후 텍스트 합성. 중앙 가독성 위해 옅은 화이트 비네트 추가.
const centerWash = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs><radialGradient id="g" cx="50%" cy="55%" r="58%">
    <stop offset="0%" stop-color="#ffffff" stop-opacity="0.78"/>
    <stop offset="62%" stop-color="#ffffff" stop-opacity="0.45"/>
    <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
  </radialGradient></defs>
  <rect width="${W}" height="${H}" fill="url(#g)"/>
</svg>`

await fs.copyFile(OUT, BACKUP).catch(() => {})
const out = await sharp(bg)
  .resize(W, H, { fit: 'cover', position: 'centre' })
  .composite([
    { input: Buffer.from(centerWash), top: 0, left: 0 },
    { input: Buffer.from(svg), top: 0, left: 0 },
  ])
  .jpeg({ quality: 92 })
  .toBuffer()
await fs.writeFile(OUT, out)
console.log(`완료: ${OUT} (${Math.round(out.length / 1024)}KB, ${W}x${H})`)
