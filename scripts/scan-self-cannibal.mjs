#!/usr/bin/env node
/**
 * 자기 발행 SKU 카니발리제이션 스캔 (일배치)
 *
 * 1) jimscanner_coupang_listings 에서 SELLING/APPROVED 상태인 SKU 조회
 * 2) 각 SKU 의 registered_title 에서 핵심 키워드 top-N 추출
 *    - 2~4 토큰의 한국어 단어 시퀀스 (멜라토닌, 수면 영양제, 락토페린 등)
 * 3) 동일 핵심 키워드를 공유하는 SKU 쌍을 detect
 *    - --mode=serp (옵션): 실제 쿠팡 SERP top-20 안에 자기 SKU 가 2개 이상 노출되는 키워드만 적재
 *    - --mode=token (기본): 토큰 공유만으로 잠식 추정 (빠르고 외부 호출 없음)
 * 4) jimscanner_self_cannibal_overlap 에 upsert
 *
 * 사용법:
 *   node scripts/scan-self-cannibal.mjs              # token mode (default)
 *   node scripts/scan-self-cannibal.mjs --mode=serp  # serp mode (느림, 쿠팡 검색 호출)
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function loadEnv() {
  try {
    return Object.fromEntries(
      readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8')
        .split(/\r?\n/)
        .filter((l) => l && !l.startsWith('#') && l.includes('='))
        .map((l) => {
          const i = l.indexOf('=')
          let v = l.slice(i + 1).trim()
          if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
          return [l.slice(0, i).trim(), v]
        }),
    )
  } catch {
    return process.env
  }
}

const env = { ...process.env, ...loadEnv() }
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL
const KEY = env.SUPABASE_SERVICE_ROLE_KEY
if (!URL_ || !KEY) {
  console.error('missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}
const sb = createClient(URL_, KEY, { auth: { persistSession: false } })

const args = process.argv.slice(2)
const mode = (args.find((a) => a.startsWith('--mode='))?.split('=')[1] ?? 'token').toLowerCase()
const TOP_N_KEYWORDS = 6
const MIN_TOKEN_LEN = 2

// 흔한 노이즈/조사/단위
const STOPWORDS = new Set([
  '정', '포', '개', '캡슐', '환', '병', '구', '팩', '박스',
  'mg', 'kg', 'g', 'ml', 'l',
  '대용량', '소용량', '국내산', '수입산',
  '무료배송', '쿠팡', '특가', '할인', '세일',
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '10',
])

function extractKeywords(title) {
  if (!title) return []
  // 한글/영문/숫자 단어만 남기고 split
  const cleaned = title
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .toLowerCase()
  const tokens = cleaned
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= MIN_TOKEN_LEN && !STOPWORDS.has(t) && !/^\d+$/.test(t))

  // unigram + bigram (2~4 토큰까지 확장은 비용 대비 효과 적어 unigram + bigram 만)
  const kws = new Set()
  for (const t of tokens) kws.add(t)
  for (let i = 0; i < tokens.length - 1; i++) {
    kws.add(`${tokens[i]} ${tokens[i + 1]}`)
  }
  // bigram 우선, 길이 긴 것 우선
  return [...kws].sort((a, b) => b.length - a.length).slice(0, TOP_N_KEYWORDS)
}

async function fetchListings() {
  const { data, error } = await sb
    .from('jimscanner_coupang_listings')
    .select('id, registered_title, status, displayable, product_id')
    .in('status', ['SELLING', 'APPROVED', 'PENDING_APPROVAL'])
  if (error) throw new Error(error.message)
  return data ?? []
}

async function searchCoupangSerp(keyword) {
  // 쿠팡 SERP top-20 productId 추출 (--mode=serp 시에만 호출)
  const url = `https://www.coupang.com/np/search?component=&q=${encodeURIComponent(keyword)}&channel=user&listSize=20`
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'ko-KR,ko;q=0.9',
      },
    })
    if (!res.ok) return []
    const html = await res.text()
    const ids = []
    const re = /data-product-id="(\d+)"/g
    let m
    while ((m = re.exec(html)) !== null) {
      ids.push(m[1])
      if (ids.length >= 20) break
    }
    return ids
  } catch (e) {
    console.warn(`  SERP fetch failed for "${keyword}":`, e.message)
    return []
  }
}

function buildKeywordIndex(listings) {
  // keyword → [{ listing_id, product_id }]
  const idx = new Map()
  for (const l of listings) {
    const kws = extractKeywords(l.registered_title || '')
    for (const kw of kws) {
      const arr = idx.get(kw) ?? []
      arr.push({ listing_id: l.id, product_id: l.product_id })
      idx.set(kw, arr)
    }
  }
  return idx
}

async function main() {
  console.log(`[self-cannibal] mode=${mode}`)
  const listings = await fetchListings()
  console.log(`[self-cannibal] fetched ${listings.length} active listings`)

  const idx = buildKeywordIndex(listings)
  console.log(`[self-cannibal] extracted ${idx.size} distinct keywords`)

  const overlaps = []

  for (const [kw, owners] of idx) {
    if (owners.length < 2) continue
    if (kw.length < 3) continue // 너무 짧은 unigram (가, 나 같은 노이즈) 제외

    if (mode === 'serp') {
      const top20 = await searchCoupangSerp(kw)
      if (top20.length === 0) continue
      const ourPresence = owners
        .map((o) => ({ ...o, rank: o.product_id ? top20.indexOf(String(o.product_id)) : -1 }))
        .filter((o) => o.rank >= 0)
      if (ourPresence.length < 2) continue
      // pairwise overlap
      for (let i = 0; i < ourPresence.length; i++) {
        for (let j = i + 1; j < ourPresence.length; j++) {
          const a = ourPresence[i]
          const b = ourPresence[j]
          const gap = Math.abs(a.rank - b.rank)
          // share_loss: 두 SKU 모두 top 10 안에 있으면 0.6+, 더 가까울수록 큼
          const closenessBonus = gap <= 3 ? 0.3 : gap <= 7 ? 0.15 : 0.05
          const topBoost = Math.min(a.rank, b.rank) < 10 ? 0.4 : 0.2
          const shareLoss = Math.min(1, closenessBonus + topBoost)
          overlaps.push({
            listing_id: a.listing_id,
            competing_listing_id: b.listing_id,
            shared_keyword: kw,
            listing_rank: a.rank + 1,
            competing_rank: b.rank + 1,
            rank_gap: gap,
            estimated_share_loss: shareLoss,
            detection_method: 'serp',
          })
        }
      }
      await new Promise((r) => setTimeout(r, 350))
    } else {
      // token mode — SERP 검증 없음, 토큰 공유만으로 추정
      for (let i = 0; i < owners.length; i++) {
        for (let j = i + 1; j < owners.length; j++) {
          // 키워드 길이가 길수록 (bigram > unigram) 잠식 가능성 높음
          const shareLoss = kw.includes(' ') ? 0.45 : 0.25
          overlaps.push({
            listing_id: owners[i].listing_id,
            competing_listing_id: owners[j].listing_id,
            shared_keyword: kw,
            listing_rank: null,
            competing_rank: null,
            rank_gap: null,
            estimated_share_loss: shareLoss,
            detection_method: 'token',
          })
        }
      }
    }
  }

  console.log(`[self-cannibal] detected ${overlaps.length} overlap pairs`)

  if (overlaps.length === 0) {
    console.log('[self-cannibal] nothing to upsert')
    return
  }

  // 이번 스캔 전체 덮어쓰기 (오래된 결과 제거)
  await sb.from('jimscanner_self_cannibal_overlap').delete().neq('id', '00000000-0000-0000-0000-000000000000')

  // batch upsert
  const BATCH = 500
  for (let i = 0; i < overlaps.length; i += BATCH) {
    const chunk = overlaps.slice(i, i + BATCH)
    const { error } = await sb.from('jimscanner_self_cannibal_overlap').insert(chunk)
    if (error) {
      console.error(`  insert error at batch ${i}:`, error.message)
    } else {
      console.log(`  upserted ${chunk.length} (${i + chunk.length}/${overlaps.length})`)
    }
  }

  console.log('[self-cannibal] done')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
