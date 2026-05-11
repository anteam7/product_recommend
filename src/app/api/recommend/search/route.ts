// /api/recommend/search?q=... — taxonomy 자동완성
//
// 결과 형식:
//   - category 매칭 (예: "청바지" → 의류) → 그대로 노출
//   - brand/ip 매칭 (예: "나이키") → manifest 의 카테고리 분포 조회 후
//        "나이키 신발" / "나이키 의류" 처럼 brand_category 조합으로 펼쳐서 노출
//      (조합 표본 0이면 brand 단독으로 fallback)

import { NextResponse, type NextRequest } from 'next/server'
import { supabase } from '@/lib/supabase'
import type { SearchResult, Country } from '@/lib/recommend/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_RESULTS = 12
const MIN_BRAND_CAT_SAMPLE = 2 // brand+category 조합 최소 표본

type TaxonomyRow = {
  kind: string
  label_ko: string
  label_en: string | null
  category_tag: string | null
  brand_canonical: string | null
  default_country: Country | null
  icon_emoji: string | null
  aliases: string[] | null
  display_order: number | null
  is_featured: boolean | null
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const q = (url.searchParams.get('q') ?? '').trim()

  // 빈 쿼리 → featured 카테고리만 반환
  if (!q) {
    const { data, error } = await supabase
      .from('jimscanner_product_taxonomy')
      .select('kind, label_ko, label_en, category_tag, brand_canonical, default_country, icon_emoji, aliases, display_order, is_featured')
      .eq('is_active', true)
      .eq('is_featured', true)
      .order('display_order', { ascending: true })
      .limit(MAX_RESULTS)

    if (error) {
      return NextResponse.json({ error: error.message, results: [] }, { status: 500 })
    }
    return NextResponse.json({
      results: (data ?? []).map((r) => taxonomyToResult(r as TaxonomyRow)),
    })
  }

  if (q.length > 60) {
    return NextResponse.json({ error: '검색어가 너무 깁니다', results: [] }, { status: 400 })
  }

  const lower = q.toLowerCase()
  const ilikeAny = `%${q}%`

  const { data, error } = await supabase
    .from('jimscanner_product_taxonomy')
    .select('kind, label_ko, label_en, category_tag, brand_canonical, default_country, icon_emoji, aliases, display_order, is_featured')
    .eq('is_active', true)
    .or(
      `label_ko.ilike.${ilikeAny},label_en.ilike.${ilikeAny},aliases.cs.{${q}},aliases.cs.{${lower}}`,
    )
    .limit(60)

  if (error) {
    return NextResponse.json({ error: error.message, results: [] }, { status: 500 })
  }

  const taxonomyRows = (data ?? []) as TaxonomyRow[]

  // ─── 카테고리 매칭 시: 그 카테고리의 sub_keyword 행을 추가로 가져옴 ───
  // 예: "의류" 검색 → CLOTHES 매칭 → sub_keyword (자켓·청바지·티셔츠 등) 펼침
  const matchedCategoryTags = taxonomyRows
    .filter((r) => r.kind === 'category' && r.category_tag)
    .map((r) => r.category_tag as string)
  if (matchedCategoryTags.length > 0) {
    const { data: subRows } = await supabase
      .from('jimscanner_product_taxonomy')
      .select('kind, label_ko, label_en, category_tag, brand_canonical, default_country, icon_emoji, aliases, display_order, is_featured')
      .eq('kind', 'sub_keyword')
      .eq('is_active', true)
      .in('category_tag', matchedCategoryTags)
    for (const sr of subRows ?? []) {
      // 중복 방지 (이미 q와 직접 매칭된 sub_keyword는 그대로 유지)
      if (taxonomyRows.some((r) => r.kind === 'sub_keyword' && r.label_ko === sr.label_ko))
        continue
      taxonomyRows.push(sr as TaxonomyRow)
    }
  }

  // ─── brand/ip/sub_keyword 행에 대해 매니페스트 분포 조회 ───
  const brandRows = taxonomyRows.filter(
    (r) => (r.kind === 'brand' || r.kind === 'ip' || r.kind === 'sub_keyword') && r.brand_canonical,
  )
  const brandList = brandRows
    .map((r) => r.brand_canonical)
    .filter((b): b is string => !!b)

  // jimscanner_category_weights 에서 brand 매칭된 집계만 가져옴
  // (이미 recompute 단계에서 product_name_en/brand_raw ILIKE 매칭으로 만들어진 행)
  type CatBreakdown = {
    brand: string
    category_tag: string
    sample_n: number
    weight_median_kg: number
  }
  const breakdown: CatBreakdown[] = []
  if (brandList.length > 0) {
    const { data: cwData } = await supabase
      .from('jimscanner_category_weights')
      .select('brand, category_tag, sample_n, weight_median_kg')
      .in('brand', brandList)
      .is('source_country', null)
      .is('shipping_mode', null)
      .gte('sample_n', MIN_BRAND_CAT_SAMPLE)
      .order('sample_n', { ascending: false })
    for (const r of cwData ?? []) {
      if (r.brand && r.category_tag) {
        breakdown.push({
          brand: String(r.brand),
          category_tag: String(r.category_tag),
          sample_n: Number(r.sample_n),
          weight_median_kg: Number(r.weight_median_kg),
        })
      }
    }
  }

  // 카테고리 한국어 라벨 (brand_category 결과용)
  const categoriesNeeded = Array.from(new Set(breakdown.map((b) => b.category_tag)))
  const catLabelMap = new Map<string, { label_ko: string; icon_emoji: string | null; default_country: Country | null }>()
  if (categoriesNeeded.length > 0) {
    const { data: catRows } = await supabase
      .from('jimscanner_product_taxonomy')
      .select('category_tag, label_ko, icon_emoji, default_country')
      .eq('kind', 'category')
      .in('category_tag', categoriesNeeded)
      .eq('is_active', true)
    for (const r of catRows ?? []) {
      catLabelMap.set(String(r.category_tag), {
        label_ko: String(r.label_ko),
        icon_emoji: (r.icon_emoji as string | null) ?? null,
        default_country: (r.default_country as Country | null) ?? null,
      })
    }
  }

  // ─── 결과 조립 ───
  type Scored = { result: SearchResult; score: number }
  const out: Scored[] = []

  for (const r of taxonomyRows) {
    const labelKo = String(r.label_ko ?? '')
    const labelEn = String(r.label_en ?? '')
    const aliases: string[] = Array.isArray(r.aliases) ? r.aliases : []

    let baseScore = 0
    if (labelKo === q || labelEn.toLowerCase() === lower) baseScore += 1000
    else if (aliases.some((a) => a.toLowerCase() === lower)) baseScore += 900
    else if (labelKo.startsWith(q) || labelEn.toLowerCase().startsWith(lower)) baseScore += 500
    else if (aliases.some((a) => a.toLowerCase().startsWith(lower))) baseScore += 400
    else baseScore += 100
    if (r.is_featured) baseScore += 50
    baseScore -= Number(r.display_order ?? 100)

    if ((r.kind === 'brand' || r.kind === 'ip') && r.brand_canonical) {
      const myBreakdown = breakdown.filter((b) => b.brand === r.brand_canonical)
      if (myBreakdown.length > 0) {
        // 브랜드 + 카테고리 조합으로 펼쳐서 노출 (brand 단독은 숨김)
        for (const b of myBreakdown) {
          const cat = catLabelMap.get(b.category_tag)
          out.push({
            result: {
              kind: 'brand_category',
              label_ko: cat ? `${labelKo} · ${cat.label_ko}` : `${labelKo} · ${b.category_tag}`,
              label_en: labelEn || null,
              category_tag: b.category_tag,
              brand_canonical: r.brand_canonical,
              default_country: cat?.default_country ?? r.default_country,
              icon_emoji: r.icon_emoji ?? cat?.icon_emoji ?? null,
              sample_n: b.sample_n,
              weight_median_kg: b.weight_median_kg,
            },
            score: baseScore + Math.min(b.sample_n * 5, 100), // 표본 많은 조합 우선
          })
        }
      } else {
        // 매니페스트 표본 없는 브랜드/IP → 단독으로 노출 (default_country만 추정)
        out.push({
          result: {
            ...taxonomyToResult(r),
            sample_n: 0,
          },
          score: baseScore - 200, // 표본 없는 항목은 후순위
        })
      }
    } else if (r.kind === 'sub_keyword' && r.brand_canonical && r.category_tag) {
      // sub_keyword: 부모 카테고리 + sub 무게 룩업
      const sub = breakdown.find(
        (b) => b.brand === r.brand_canonical && b.category_tag === r.category_tag,
      )
      if (sub && sub.sample_n >= 2) {
        out.push({
          result: {
            kind: 'brand_category', // UI에서는 brand_category와 동일 처리 (라벨 자체에 정보)
            label_ko: labelKo,
            label_en: labelEn || null,
            category_tag: r.category_tag,
            brand_canonical: r.brand_canonical,
            default_country: r.default_country,
            icon_emoji: r.icon_emoji,
            sample_n: sub.sample_n,
            weight_median_kg: sub.weight_median_kg,
          },
          score: baseScore + Math.min(sub.sample_n * 5, 100),
        })
      }
      // 표본 없으면 노출 안 함 (sub는 추정 의미 약하므로 cut-off)
    } else {
      // category 등
      out.push({ result: taxonomyToResult(r), score: baseScore })
    }
  }

  const ranked = out
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RESULTS)
    .map((x) => x.result)

  return NextResponse.json({ results: ranked })
}

function taxonomyToResult(r: TaxonomyRow): SearchResult {
  return {
    kind: r.kind as SearchResult['kind'],
    label_ko: String(r.label_ko ?? ''),
    label_en: r.label_en ?? null,
    category_tag: r.category_tag ?? null,
    brand_canonical: r.brand_canonical ?? null,
    default_country: r.default_country ?? null,
    icon_emoji: r.icon_emoji ?? null,
    sample_n: null,
    weight_median_kg: null,
  }
}
