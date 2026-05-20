#!/usr/bin/env node
/**
 * SKU 리스팅 적합도 게이트 스코어러 (heuristic-v1)
 *
 * jimscanner_ggsan_products 의 image_url / title 을 휴리스틱으로 채점해
 * jimscanner_ggsan_listing_quality 에 UPSERT 한다.
 *
 * 호출:
 *   node --env-file=.env.local scripts/score-listing-quality.mjs
 *   node --env-file=.env.local scripts/score-listing-quality.mjs --limit=50 --force
 *
 * 옵션:
 *   --limit=N  : 채점할 최대 SKU 수 (기본 500)
 *   --force    : 이미 채점된 SKU 도 재채점
 *
 * 휴리스틱-only 1차 버전. 향후 비전 LLM(워터마크·배경 단색·모델노출)으로
 * image_score 보강 예정 — issues 배열의 confidence 필드로 단계적 교체 가능.
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
})

const SCORER_VERSION = 'heuristic-v1'

const args = process.argv.slice(2)
const limitArg = args.find((a) => a.startsWith('--limit='))
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : 500
const FORCE = args.includes('--force')

// ── 휴리스틱 사전 ───────────────────────────────────────
// 채널 업로드시 흔히 reject 되는 단어. 가독성·신뢰성 깎임.
const BANNED_TITLE_WORDS = [
  '최저가', '최고', '1위', '1등', '베스트', '특가', '대박', '핫딜',
  '무료배송', '오늘만', '한정', '폭탄', '대박세일', '무조건', '강추',
  '!!', '!!!', '★', '☆', '♥', '♡', '※',
]
// 일반 도매 이미지 호스트(신뢰). 외 호스트는 살짝 감점.
const TRUSTED_IMAGE_HOSTS = new Set([
  'ggsan.com', 'www.ggsan.com', 'img.ggsan.com',
  'cdn.ggsan.com', 'sitem.ggsan.com',
])

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n))
}

/** 한글 비율 (한글 음절 / 전체 가시 문자). */
function hangulRatio(s) {
  if (!s) return 0
  const visible = s.replace(/\s+/g, '')
  if (!visible.length) return 0
  const hangul = (visible.match(/[가-힣]/g) || []).length
  return hangul / visible.length
}

/** 단어 중복 비율 = (총단어수 - 고유단어수) / 총단어수. */
function duplicateRatio(s) {
  const tokens = s
    .toLowerCase()
    .split(/[\s,/()\[\]·.\-_+|]+/)
    .filter((t) => t.length >= 2)
  if (tokens.length < 2) return 0
  const uniq = new Set(tokens)
  return (tokens.length - uniq.size) / tokens.length
}

function scoreTitle(title) {
  const issues = []
  let score = 10.0
  const t = (title ?? '').trim()
  if (!t) {
    issues.push({ code: 'no_title', label: '제목 없음', dim: 'title', weight: 10 })
    return { score: 0, issues }
  }

  // 길이 (한글 기준 12~40자 권장)
  const len = t.length
  if (len < 8) {
    score -= 3
    issues.push({ code: 'title_short', label: `너무 짧음(${len}자)`, dim: 'title', weight: 3 })
  } else if (len > 60) {
    score -= 2
    issues.push({ code: 'title_long', label: `너무 김(${len}자)`, dim: 'title', weight: 2 })
  }

  // 한글 비율 (한국 시장 가독성)
  const hr = hangulRatio(t)
  if (hr < 0.4) {
    score -= 2
    issues.push({
      code: 'low_hangul',
      label: `한글 비율 낮음(${(hr * 100).toFixed(0)}%)`,
      dim: 'title',
      weight: 2,
    })
  }

  // 금칙어
  const lowered = t.toLowerCase()
  const banned = BANNED_TITLE_WORDS.filter((w) => lowered.includes(w.toLowerCase()))
  if (banned.length > 0) {
    const penalty = Math.min(4, banned.length * 1.5)
    score -= penalty
    issues.push({
      code: 'banned_words',
      label: `금칙어: ${banned.slice(0, 3).join(', ')}`,
      dim: 'title',
      weight: penalty,
    })
  }

  // 중복 단어
  const dr = duplicateRatio(t)
  if (dr > 0.25) {
    const penalty = clamp(dr * 6, 1, 3)
    score -= penalty
    issues.push({
      code: 'duplicate_tokens',
      label: `중복 단어 비율 ${(dr * 100).toFixed(0)}%`,
      dim: 'title',
      weight: penalty,
    })
  }

  // 특수문자 폭주 (5개 이상의 비-한글/숫자/공백)
  const specials = (t.match(/[^\w\s가-힣()/\-+,.×x]/g) || []).length
  if (specials >= 5) {
    score -= 1.5
    issues.push({
      code: 'special_chars',
      label: `특수문자 ${specials}개`,
      dim: 'title',
      weight: 1.5,
    })
  }

  // 괄호 안 옵션이 너무 많으면 가독성 저하
  const parens = (t.match(/[\(\[][^)\]]+[\)\]]/g) || []).length
  if (parens >= 3) {
    score -= 1
    issues.push({
      code: 'many_options',
      label: `옵션 괄호 ${parens}개`,
      dim: 'title',
      weight: 1,
    })
  }

  return { score: clamp(score, 0, 10), issues }
}

function scoreImage(imageUrl) {
  const issues = []
  let score = 10.0
  const u = (imageUrl ?? '').trim()
  if (!u) {
    issues.push({ code: 'no_image', label: '이미지 URL 없음', dim: 'image', weight: 10 })
    return { score: 0, issues }
  }

  let parsed
  try {
    parsed = new URL(u)
  } catch {
    issues.push({ code: 'bad_image_url', label: 'URL 파싱 실패', dim: 'image', weight: 10 })
    return { score: 0, issues }
  }

  // 호스트 신뢰도
  if (!TRUSTED_IMAGE_HOSTS.has(parsed.hostname)) {
    score -= 1
    issues.push({
      code: 'untrusted_host',
      label: `호스트 ${parsed.hostname}`,
      dim: 'image',
      weight: 1,
    })
  }

  // 확장자/파일타입
  const pathLower = parsed.pathname.toLowerCase()
  const ext = pathLower.match(/\.(jpg|jpeg|png|webp|gif|bmp)(\?|$)/)?.[1]
  if (!ext) {
    score -= 1.5
    issues.push({ code: 'unknown_ext', label: '확장자 미상', dim: 'image', weight: 1.5 })
  } else if (ext === 'gif' || ext === 'bmp') {
    score -= 2
    issues.push({ code: 'bad_ext', label: `확장자 ${ext}`, dim: 'image', weight: 2 })
  }

  // 썸네일 추정 (작은 사이즈 패턴)
  // ggsan 은 /data/goods/{goods_no}/medium/... 또는 /thumb/... 같은 패턴.
  if (/\/(thumb|thumbs|small|tiny|s_|sm_|m_|mini)\//.test(pathLower)) {
    score -= 3
    issues.push({
      code: 'thumbnail_likely',
      label: '썸네일 경로(저해상도 추정)',
      dim: 'image',
      weight: 3,
    })
  }
  // 가로 사이즈가 URL에 박혀 있는 경우 (예: _300x300, =w200)
  const sizeMatch =
    pathLower.match(/_(\d{2,4})x(\d{2,4})/) ||
    parsed.search.match(/[?&](?:w|width)=(\d+)/i)
  if (sizeMatch) {
    const w = parseInt(sizeMatch[1], 10)
    if (w && w < 500) {
      const penalty = w < 300 ? 3 : 1.5
      score -= penalty
      issues.push({
        code: 'low_res_url',
        label: `URL 가로 ${w}px`,
        dim: 'image',
        weight: penalty,
      })
    } else if (w && w >= 800) {
      // bonus: 충분한 해상도 단서 (감점 없음)
    }
  }

  // 파일명 keyword 휴리스틱: "wm", "watermark", "logo" 들어 있으면 감점
  if (/(wm|watermark|logo|stamp)/i.test(pathLower)) {
    score -= 2
    issues.push({
      code: 'watermark_hint',
      label: '파일명에 워터마크/로고 단서',
      dim: 'image',
      weight: 2,
    })
  }

  // HTTPS 아닌 경우
  if (parsed.protocol !== 'https:') {
    score -= 1
    issues.push({ code: 'http_only', label: 'HTTPS 아님', dim: 'image', weight: 1 })
  }

  return { score: clamp(score, 0, 10), issues }
}

async function fetchTargets() {
  let q = sb
    .from('jimscanner_ggsan_products')
    .select('goods_no, title, image_url')
    .eq('status', 'active')
    .order('last_seen_at', { ascending: false })
    .limit(LIMIT)

  if (!FORCE) {
    // 미채점 SKU 만. computed_at IS NULL 을 LEFT JOIN 으로 잡기 어려워
    // 2-step: 먼저 모든 후보를 가져온 뒤 already-scored 를 제외.
    const { data: all, error } = await q
    if (error) throw error
    const goodsNos = (all ?? []).map((r) => r.goods_no)
    if (!goodsNos.length) return []
    const { data: scored } = await sb
      .from('jimscanner_ggsan_listing_quality')
      .select('goods_no, scorer_version')
      .in('goods_no', goodsNos)
    const scoredSet = new Set((scored ?? []).filter((r) => r.scorer_version === SCORER_VERSION).map((r) => r.goods_no))
    return (all ?? []).filter((r) => !scoredSet.has(r.goods_no))
  }

  const { data, error } = await q
  if (error) throw error
  return data ?? []
}

async function upsertScores(rows) {
  if (!rows.length) return 0
  const payload = rows.map((r) => {
    const t = scoreTitle(r.title)
    const i = scoreImage(r.image_url)
    return {
      goods_no: r.goods_no,
      title_score: Number(t.score.toFixed(2)),
      image_score: Number(i.score.toFixed(2)),
      issues: [...t.issues, ...i.issues],
      scorer_version: SCORER_VERSION,
    }
  })

  // chunk upsert (Supabase 한 번에 너무 큰 페이로드 회피)
  const CHUNK = 200
  let written = 0
  for (let i = 0; i < payload.length; i += CHUNK) {
    const slice = payload.slice(i, i + CHUNK)
    const { error } = await sb
      .from('jimscanner_ggsan_listing_quality')
      .upsert(slice, { onConflict: 'goods_no' })
    if (error) throw error
    written += slice.length
  }
  return written
}

async function main() {
  console.log(`[listing-quality] scorer=${SCORER_VERSION} limit=${LIMIT} force=${FORCE}`)
  const targets = await fetchTargets()
  console.log(`[listing-quality] targets=${targets.length}`)
  if (!targets.length) {
    console.log('[listing-quality] nothing to score')
    return
  }
  const written = await upsertScores(targets)
  console.log(`[listing-quality] upserted=${written}`)
}

main().catch((e) => {
  console.error('[listing-quality] fatal:', e)
  process.exit(1)
})
