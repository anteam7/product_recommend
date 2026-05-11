import Link from 'next/link'
import Image from 'next/image'
import { Metadata } from 'next'
import { supabase } from '@/lib/supabase'
import {
  type BlogPost,
  type BlogCategory,
  BLOG_CATEGORIES,
  formatPublishedDate,
  estimateReadingMinutes,
  countWords,
} from '@/lib/blog'
import { Badge } from '@/components/ui/badge'

export const metadata: Metadata = {
  title: '블로그 · 해외직구·배대지 인사이트',
  description:
    '짐스캐너 에디터팀이 전하는 해외직구·배대지 최신 정보. 요금 비교, 통관, 환율, 꿀팁까지 실제 데이터 기반 가이드.',
  alternates: { canonical: 'https://jimscanner.co.kr/blog' },
  openGraph: {
    title: '짐스캐너 블로그',
    description: '해외직구·배대지 최신 정보와 실전 가이드',
    url: 'https://jimscanner.co.kr/blog',
  },
}

export const revalidate = 600

type Props = { searchParams: Promise<{ category?: string }> }

export default async function BlogListPage({ searchParams }: Props) {
  const params = await searchParams
  const selectedCategory = (BLOG_CATEGORIES as readonly string[]).includes(params.category ?? '')
    ? (params.category as BlogCategory)
    : null

  let query = supabase
    .from('jimscanner_blog_posts')
    .select('*')
    .eq('status', 'published')
    .order('published_at', { ascending: false })
    .limit(60)

  if (selectedCategory) query = query.eq('category', selectedCategory)

  const { data } = await query
  const posts = (data ?? []) as BlogPost[]

  return (
    <div className="py-12 px-4">
      <div className="container mx-auto max-w-5xl">
        <div className="mb-10">
          <Badge className="mb-3">블로그</Badge>
          <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-3">
            해외직구·배대지 인사이트
          </h1>
          <p className="text-base text-gray-600 leading-relaxed max-w-3xl">
            요금 비교, 통관, 환율, 꿀팁까지 — 짐스캐너 에디터팀이 실제 데이터를 기반으로 전하는
            해외직구 가이드입니다.
          </p>
        </div>

        <nav className="flex gap-2 flex-wrap mb-10">
          <Link
            href="/blog"
            className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
              !selectedCategory ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            전체
          </Link>
          {BLOG_CATEGORIES.map((c) => (
            <Link
              key={c}
              href={`/blog?category=${encodeURIComponent(c)}`}
              className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
                selectedCategory === c
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {c}
            </Link>
          ))}
        </nav>

        {posts.length === 0 ? (
          <div className="bg-white border rounded-xl p-12 text-center text-gray-500">
            아직 발행된 글이 없습니다.
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {posts.map((p, idx) => {
              const chars = countWords(p.content)
              return (
                <Link
                  key={p.id}
                  href={`/blog/${p.slug}`}
                  className="group bg-white border rounded-xl overflow-hidden hover:border-blue-300 hover:shadow-md transition-all"
                >
                  {p.cover_image_url ? (
                    <div className="relative w-full aspect-[16/9]">
                      <Image
                        src={p.cover_image_url}
                        alt={p.title}
                        fill
                        sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
                        className="object-cover"
                        priority={idx < 3}
                      />
                    </div>
                  ) : (
                    <div className="w-full aspect-[16/9] bg-gradient-to-br from-blue-50 via-sky-50 to-indigo-50 flex items-center justify-center px-6">
                      <p className="text-base font-semibold text-gray-700 text-center line-clamp-3">
                        {p.title}
                      </p>
                    </div>
                  )}
                  <div className="p-5 space-y-3">
                    <span className="inline-block text-xs font-medium bg-blue-50 text-blue-700 px-2 py-0.5 rounded">
                      {p.category}
                    </span>
                    <h2 className="font-bold text-gray-900 text-lg leading-snug group-hover:text-blue-600 line-clamp-2">
                      {p.title}
                    </h2>
                    {p.description && (
                      <p className="text-sm text-gray-600 line-clamp-3 leading-relaxed">
                        {p.description}
                      </p>
                    )}
                    <div className="flex items-center justify-between text-xs text-gray-500">
                      <span>{formatPublishedDate(p.published_at)}</span>
                      <span>{estimateReadingMinutes(chars)}분 분량</span>
                    </div>
                  </div>
                </Link>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
