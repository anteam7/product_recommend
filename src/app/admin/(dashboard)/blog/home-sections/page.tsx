import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import { BLOG_CATEGORIES } from '@/lib/blog'
import HomeSectionsEditor, { type Section } from './HomeSectionsEditor'
import HeroPicksEditor, { type HeroPick, type PostOption } from './HeroPicksEditor'

export const dynamic = 'force-dynamic'

export default async function HomeSectionsPage() {
  const supabase = createAdminClient()

  const [
    { data: sections },
    { data: pinnedPosts },
    { data: heroPicks },
    { data: allPublished },
  ] = await Promise.all([
    supabase
      .from('jimscanner_blog_home_sections')
      .select('*')
      .order('display_order', { ascending: true }),
    supabase
      .from('jimscanner_blog_posts')
      .select('category, home_featured, status')
      .eq('home_featured', true)
      .eq('status', 'published'),
    supabase
      .from('jimscanner_home_hero_blog_picks')
      .select('*')
      .order('position', { ascending: true }),
    supabase
      .from('jimscanner_blog_posts')
      .select('slug, title, category')
      .eq('status', 'published')
      .order('published_at', { ascending: false }),
  ])

  const pinnedByCategory = new Map<string, number>()
  for (const p of pinnedPosts ?? []) {
    const k = (p as { category: string }).category
    pinnedByCategory.set(k, (pinnedByCategory.get(k) ?? 0) + 1)
  }

  const picksByPos = new Map<number, HeroPick>()
  for (const p of (heroPicks ?? []) as HeroPick[]) picksByPos.set(p.position, p)
  const mergedPicks: HeroPick[] = [1, 2, 3].map(
    (i) => picksByPos.get(i) ?? { position: i, blog_slug: null },
  )

  const postOptions: PostOption[] = ((allPublished ?? []) as PostOption[]).map((p) => ({
    slug: p.slug,
    title: p.title,
    category: p.category,
  }))

  // ensure all 5 categories have a row (in case DB seed didn't)
  const byCat = new Map<string, Section>()
  for (const s of (sections ?? []) as Section[]) byCat.set(s.category, s)
  const merged: Section[] = BLOG_CATEGORIES.map((c, idx) => {
    const existing = byCat.get(c)
    if (existing) return existing
    const layout: 'hero4' | 'row3' = idx % 2 === 0 ? 'hero4' : 'row3'
    return {
      category: c,
      active: true,
      layout,
      display_order: idx + 1,
    }
  }).sort((a, b) => a.display_order - b.display_order)

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">메인 블로그 섹션 관리</h1>
          <p className="text-sm text-gray-500 mt-1">
            메인 페이지 / 의 카테고리별 블로그 섹션 노출/레이아웃/순서. 섹션마다 노출되는 글은 각 카테고리에서 <span className="font-medium">📌 메인 노출</span> 토글된 글들입니다.
          </p>
        </div>
        <Link
          href="/admin/blog"
          className="text-sm px-3 py-2 rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50"
        >
          블로그 목록 →
        </Link>
      </div>

      <HeroPicksEditor initialPicks={mergedPicks} postOptions={postOptions} />

      <HomeSectionsEditor
        initialSections={merged}
        pinnedCounts={Object.fromEntries(pinnedByCategory)}
      />

      <div className="bg-blue-50 border border-blue-100 rounded-lg p-4 text-xs text-blue-900 space-y-1">
        <p className="font-medium">레이아웃 안내</p>
        <p>• <span className="font-mono">hero4</span> = 1 큰 카드 + 4 작은 카드 (총 5개)</p>
        <p>• <span className="font-mono">row3</span> = 1줄에 카드 3개</p>
        <p>핀된 글 수가 부족하면 자동으로 사이즈를 줄여 빈 칸 없이 표시됩니다.</p>
      </div>
    </div>
  )
}
