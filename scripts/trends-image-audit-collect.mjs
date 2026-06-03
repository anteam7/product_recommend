// 대표이미지 재사용도(Image-Reuse) 레드오션 게이트 — 수집 스크립트 (로컬 WSL)
// ─────────────────────────────────────────────────────────────────────────
// 발굴 상품마다 경쟁 리스팅 썸네일 + ggsan/도매 원본 사진의 average-hash(pHash)를
// 산출해 동일·근사 사진 비율(reuse_ratio)과 시각적 군집 수(cluster_count)를 측정,
// jimscanner_trends_image_audit 에 적재한다.
//
//   sharp 8x8 그레이스케일 average-hash → 신규 의존성 없음 (next 가 sharp 동봉)
//
// 리스팅 썸네일 소스: 현재는 같은 product 의 jimscanner_trends_supplier 여러 행
// (도매처들이 stock 사진을 그대로 돌려쓰는지)을 프록시로 사용 + ggsan 원본.
// 쿠팡 상위 N개 검색 썸네일은 기존 scrape 인프라에 함수만 끼우면 확장 가능
//   (아래 collectListingUrls(product) 한 곳만 교체).
//
// 사용법:  node scripts/trends-image-audit-collect.mjs [limit]
// ─────────────────────────────────────────────────────────────────────────
import sharp from 'sharp'
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      let v = l.slice(i + 1).trim()
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      return [l.slice(0, i).trim(), v]
    })
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)

const HAMMING_NEAR = 8 // ≤8 bit 차이는 동일·근사로 간주 (64bit 중 ~12%)
const LIMIT = Number(process.argv[2] || 60)

// 8x8 그레이스케일 average-hash → 16-hex (64bit) 문자열
async function phash(buf) {
  const px = await sharp(buf).greyscale().resize(8, 8, { fit: 'fill' }).raw().toBuffer()
  let sum = 0
  for (let i = 0; i < 64; i++) sum += px[i]
  const avg = sum / 64
  let bits = ''
  for (let i = 0; i < 64; i++) bits += px[i] >= avg ? '1' : '0'
  let hex = ''
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16)
  return hex
}

function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return 64
  let d = 0
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16)
    while (x) { d += x & 1; x >>= 1 }
  }
  return d
}

async function fetchImage(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) })
    if (!r.ok) return null
    return Buffer.from(await r.arrayBuffer())
  } catch {
    return null
  }
}

// 그리디 군집: hamming≤NEAR 이면 같은 군집
function cluster(items) {
  const reps = [] // { phash, idx }
  for (const it of items) {
    let assigned = -1
    for (let c = 0; c < reps.length; c++) {
      if (hamming(it.phash, reps[c].phash) <= HAMMING_NEAR) { assigned = c; break }
    }
    if (assigned < 0) { assigned = reps.length; reps.push({ phash: it.phash }) }
    it.cluster = assigned
  }
  return reps.length
}

// 경쟁 리스팅 이미지 URL 수집 (확장 포인트). 현재는 도매 supplier 사진 프록시.
async function collectListingUrls(productId) {
  const { data } = await sb
    .from('jimscanner_trends_supplier')
    .select('supplier_source, url_image, collected_at')
    .eq('product_id', productId)
    .not('url_image', 'is', null)
    .order('collected_at', { ascending: false })
    .limit(20)
  return (data ?? []).map((r) => ({ url: r.url_image, source: r.supplier_source }))
}

async function main() {
  // 최근 본 product 우선
  const { data: products } = await sb
    .from('jimscanner_trends_products')
    .select('id, canonical_name')
    .order('last_seen_at', { ascending: false })
    .limit(LIMIT)

  let done = 0, skipped = 0
  for (const p of products ?? []) {
    const urls = await collectListingUrls(p.id)
    if (urls.length === 0) { skipped++; continue }

    const thumbs = []
    for (const u of urls) {
      const buf = await fetchImage(u.url)
      if (!buf) continue
      let h
      try { h = await phash(buf) } catch { continue }
      thumbs.push({ url: u.url, source: u.source, phash: h })
    }
    if (thumbs.length === 0) { skipped++; continue }

    // ggsan 원본을 supplier 기준점으로 (없으면 첫 썸네일)
    const supThumb = thumbs.find((t) => /ggsan/i.test(t.source || '')) || thumbs[0]
    const supplierPhash = supThumb.phash
    thumbs.forEach((t) => { t.is_supplier = t === supThumb })

    const clusterCount = cluster(thumbs)
    const near = thumbs.filter((t) => hamming(t.phash, supplierPhash) <= HAMMING_NEAR).length
    const reuseRatio = thumbs.length > 0 ? near / thumbs.length : null

    const row = {
      product_id: p.id,
      listing_phashes: thumbs.map((t) => t.phash),
      supplier_phash: supplierPhash,
      reuse_ratio: reuseRatio,
      cluster_count: clusterCount,
      listing_count: thumbs.length,
      thumbnails: thumbs.map((t) => ({ url: t.url, phash: t.phash, cluster: t.cluster, is_supplier: !!t.is_supplier })),
    }
    const { error } = await sb.from('jimscanner_trends_image_audit').insert(row)
    if (error) { console.log(`✗ ${p.canonical_name}: ${error.message}`); continue }
    done++
    console.log(`✓ ${p.canonical_name} — reuse ${(reuseRatio * 100).toFixed(0)}% · ${clusterCount} cluster / ${thumbs.length} img`)
  }
  console.log(`\n완료: ${done} 적재, ${skipped} 스킵 (이미지 없음)`)
  process.exit(0)
}

main()
