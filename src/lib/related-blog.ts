import { supabase } from '@/lib/supabase'

export type RelatedBlog = {
  slug: string
  title: string
  description: string | null
  cover_image_url: string | null
  category: string
  published_at: string | null
}

type BlogForMatch = RelatedBlog & {
  tags: string[] | null
  target_keywords: string[] | null
}

const COUNTRY_KO: Record<string, string[]> = {
  US: ['미국', 'us', 'usa'],
  JP: ['일본', 'jp'],
  CN: ['중국', 'cn'],
}

function corpus(post: BlogForMatch): string {
  return [
    ...(post.tags ?? []),
    ...(post.target_keywords ?? []),
    post.title,
  ]
    .join(' ')
    .toLowerCase()
}

function scoreFor(
  post: BlogForMatch,
  brandNeedles: string[],
  countryNeedles: string[],
): number {
  const text = corpus(post)
  let score = 0
  for (const n of brandNeedles) {
    if (n && text.includes(n.toLowerCase())) score += 10
  }
  for (const n of countryNeedles) {
    if (n && text.includes(n.toLowerCase())) score += 3
  }
  return score
}

async function fetchPublished(): Promise<BlogForMatch[]> {
  const { data } = await supabase
    .from('jimscanner_blog_posts')
    .select('slug, title, description, cover_image_url, category, published_at, tags, target_keywords')
    .eq('status', 'published')
    .order('published_at', { ascending: false })
    .limit(60)
  return (data ?? []) as BlogForMatch[]
}

function strip(post: BlogForMatch): RelatedBlog {
  // tags/target_keywords 는 매칭에만 쓰고 반환에선 제거
  const { tags: _t, target_keywords: _k, ...rest } = post
  void _t
  void _k
  return rest
}

/**
 * 포워더 상세 페이지에 붙일 관련 블로그 3개.
 * 1) 브랜드 이름·slug 매칭 우선, 2) 국가 매칭, 3) 부족하면 최신 published 로 채움.
 */
export async function getRelatedBlogsForForwarder(
  forwarder: { slug: string; name: string },
  countries: string[],
  limit = 3,
): Promise<RelatedBlog[]> {
  const posts = await fetchPublished()
  if (posts.length === 0) return []

  const countryNeedles = countries.flatMap((c) => COUNTRY_KO[c] ?? [c])
  const brandNeedles = [forwarder.name, forwarder.slug]

  const ranked = posts
    .map((p) => ({ p, s: scoreFor(p, brandNeedles, countryNeedles) }))
    .sort((a, b) => b.s - a.s)

  const picked: BlogForMatch[] = []
  const seen = new Set<string>()
  for (const { p, s } of ranked) {
    if (s <= 0) continue
    if (seen.has(p.slug)) continue
    picked.push(p)
    seen.add(p.slug)
    if (picked.length >= limit) break
  }

  // 부족하면 최신 published 로 채움 (최소 limit 개 보장)
  if (picked.length < limit) {
    for (const p of posts) {
      if (seen.has(p.slug)) continue
      picked.push(p)
      seen.add(p.slug)
      if (picked.length >= limit) break
    }
  }

  return picked.map(strip)
}

/**
 * /compare/[country] 페이지용. 해당 국가 키워드 매칭 → 부족하면 최신.
 */
export async function getRelatedBlogsForCountry(
  country: string | null,
  limit = 3,
): Promise<RelatedBlog[]> {
  const posts = await fetchPublished()
  if (posts.length === 0) return []

  const countryNeedles = country ? COUNTRY_KO[country] ?? [country] : []

  const ranked = posts
    .map((p) => ({ p, s: scoreFor(p, [], countryNeedles) }))
    .sort((a, b) => b.s - a.s)

  const picked: BlogForMatch[] = []
  const seen = new Set<string>()
  if (countryNeedles.length > 0) {
    for (const { p, s } of ranked) {
      if (s <= 0) continue
      if (seen.has(p.slug)) continue
      picked.push(p)
      seen.add(p.slug)
      if (picked.length >= limit) break
    }
  }

  if (picked.length < limit) {
    for (const p of posts) {
      if (seen.has(p.slug)) continue
      picked.push(p)
      seen.add(p.slug)
      if (picked.length >= limit) break
    }
  }

  return picked.map(strip)
}
