import Link from 'next/link'
import Image from 'next/image'
import { Metadata } from 'next'
import { notFound } from 'next/navigation'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { supabase } from '@/lib/supabase'
import {
  type BlogPost,
  countWords,
  estimateReadingMinutes,
  formatPublishedDate,
  markdownLinksToHtml,
  stripLeadingH1,
} from '@/lib/blog'
import { Badge } from '@/components/ui/badge'
import BlogScrollTracker from '@/components/analytics/BlogScrollTracker'
import ServiceCTA from '@/components/layout/ServiceCTA'
import ReportButton from '@/components/reports/ReportButton'
import ResolutionBadge from '@/components/reports/ResolutionBadge'
import ShareMenu from '@/components/share/ShareMenu'

export const revalidate = 600

type Props = { params: Promise<{ slug: string }> }

// updated_at 이 published_at 대비 최소 24시간 이상 뒤여야 "업데이트 있음"으로 간주
function isMeaningfullyUpdated(publishedAt: string, updatedAt: string): boolean {
  const diff = new Date(updatedAt).getTime() - new Date(publishedAt).getTime()
  return diff > 24 * 60 * 60 * 1000
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params
  const { data } = await supabase
    .from('jimscanner_blog_posts')
    .select('*')
    .eq('slug', slug)
    .eq('status', 'published')
    .maybeSingle<BlogPost>()

  if (!data) return { title: '블로그 글을 찾을 수 없습니다' }

  const title = data.seo_title || data.title
  const description = data.seo_description || data.description || undefined
  const ogImage = data.og_image || data.cover_image_url || undefined
  return {
    title,
    description,
    alternates: { canonical: `https://jimscanner.co.kr/blog/${data.slug}` },
    openGraph: {
      title,
      description,
      url: `https://jimscanner.co.kr/blog/${data.slug}`,
      type: 'article',
      publishedTime: data.published_at ?? undefined,
      modifiedTime: data.updated_at,
      images: ogImage ? [{ url: ogImage }] : undefined,
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: ogImage ? [ogImage] : undefined,
    },
  }
}

export async function generateStaticParams() {
  const { data } = await supabase
    .from('jimscanner_blog_posts')
    .select('slug')
    .eq('status', 'published')
    .limit(50)
  return (data ?? []).map((p) => ({ slug: p.slug }))
}

export default async function BlogDetailPage({ params }: Props) {
  const { slug } = await params
  const { data } = await supabase
    .from('jimscanner_blog_posts')
    .select('*')
    .eq('slug', slug)
    .eq('status', 'published')
    .maybeSingle<BlogPost>()

  if (!data) notFound()
  const post = data

  const chars = countWords(post.content)
  const readingMinutes = estimateReadingMinutes(chars)

  // 관련 글: 같은 카테고리 3개
  const { data: relatedData } = await supabase
    .from('jimscanner_blog_posts')
    .select('slug, title, description, cover_image_url, category, published_at, content')
    .eq('status', 'published')
    .eq('category', post.category)
    .neq('slug', post.slug)
    .order('published_at', { ascending: false })
    .limit(3)
  const related = (relatedData ?? []) as Pick<BlogPost, 'slug' | 'title' | 'description' | 'cover_image_url' | 'category' | 'published_at' | 'content'>[]

  const blogPostingJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: post.title,
    description: post.description ?? undefined,
    image: post.cover_image_url ? [post.cover_image_url] : undefined,
    datePublished: post.published_at,
    dateModified: post.updated_at,
    author: { '@type': 'Organization', name: post.author },
    publisher: {
      '@type': 'Organization',
      name: '짐스캐너',
      logo: {
        '@type': 'ImageObject',
        url: 'https://jimscanner.co.kr/og-image.jpg',
      },
    },
    mainEntityOfPage: {
      '@type': 'WebPage',
      '@id': `https://jimscanner.co.kr/blog/${post.slug}`,
    },
    keywords: post.tags.join(', '),
    articleSection: post.category,
  }

  const breadcrumbJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: '홈', item: 'https://jimscanner.co.kr' },
      { '@type': 'ListItem', position: 2, name: '블로그', item: 'https://jimscanner.co.kr/blog' },
      { '@type': 'ListItem', position: 3, name: post.title, item: `https://jimscanner.co.kr/blog/${post.slug}` },
    ],
  }

  const faqJsonLd =
    post.faq.length > 0
      ? {
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          mainEntity: post.faq.map((item) => ({
            '@type': 'Question',
            name: item.question,
            acceptedAnswer: { '@type': 'Answer', text: markdownLinksToHtml(item.answer) },
          })),
        }
      : null

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(blogPostingJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd) }}
      />
      {faqJsonLd && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
        />
      )}

      <BlogScrollTracker slug={post.slug} title={post.title} />
      <article className="py-10 px-4">
        <div className="container mx-auto max-w-3xl">
          {/* Breadcrumb — JSON-LD 와 UI 양쪽에 일관된 navigation 제공 */}
          <nav aria-label="Breadcrumb" className="text-sm text-gray-500 mb-6">
            <ol className="flex items-center gap-2 flex-wrap">
              <li>
                <Link href="/" className="hover:text-blue-600">
                  홈
                </Link>
              </li>
              <li className="text-gray-400">›</li>
              <li>
                <Link href="/blog" className="hover:text-blue-600">
                  블로그
                </Link>
              </li>
              <li className="text-gray-400">›</li>
              <li className="text-gray-700 truncate max-w-[180px] sm:max-w-sm" aria-current="page">
                {post.title}
              </li>
            </ol>
          </nav>

          <header className="mb-8">
            <span className="inline-block text-xs font-medium bg-blue-50 text-blue-700 px-2 py-0.5 rounded mb-4">
              {post.category}
            </span>
            <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 mb-4 leading-tight">
              {post.title}
            </h1>
            {post.description && (
              <p className="text-lg text-gray-600 leading-relaxed mb-4">{post.description}</p>
            )}
            <div className="flex items-center gap-3 text-sm text-gray-500 flex-wrap">
              <span>{post.author}</span>
              <span>·</span>
              {post.published_at && (
                <time dateTime={post.published_at}>
                  {formatPublishedDate(post.published_at)}
                </time>
              )}
              <span>·</span>
              <span>{readingMinutes}분 분량</span>
              {post.published_at && post.updated_at && isMeaningfullyUpdated(post.published_at, post.updated_at) && (
                <>
                  <span>·</span>
                  <time
                    dateTime={post.updated_at}
                    className="inline-flex items-center gap-1 text-xs bg-amber-50 text-amber-800 border border-amber-100 px-2 py-0.5 rounded"
                    title={`최근 업데이트: ${formatPublishedDate(post.updated_at)}`}
                  >
                    🔄 {formatPublishedDate(post.updated_at)} 업데이트
                  </time>
                </>
              )}
              <span className="ml-auto">
                <ShareMenu
                  title={post.title}
                  description={post.description ?? undefined}
                  imageUrl={post.cover_image_url ?? post.og_image ?? undefined}
                  size="sm"
                />
              </span>
            </div>
          </header>

          {post.cover_image_url && (
            <div className="relative w-full aspect-[16/9] rounded-xl overflow-hidden mb-8">
              <Image
                src={post.cover_image_url}
                alt={post.title}
                fill
                sizes="(min-width: 768px) 768px, 100vw"
                className="object-cover"
                priority
              />
            </div>
          )}

          <div className="prose prose-lg max-w-none prose-headings:text-gray-900 prose-a:text-blue-600 prose-a:no-underline hover:prose-a:underline prose-img:rounded-lg">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                // H1은 페이지 제목(title)이 이미 <h1>으로 렌더링되므로 본문 H1은 H2로 강등
                h1: (props) => <h2 {...props} />,
              }}
            >
              {stripLeadingH1(post.content)}
            </ReactMarkdown>
          </div>

          {post.tags.length > 0 && (
            <div className="flex gap-2 flex-wrap mt-10 pt-6 border-t">
              {post.tags.map((t) => (
                <span key={t} className="text-xs bg-gray-100 text-gray-700 px-2 py-1 rounded">
                  #{t}
                </span>
              ))}
            </div>
          )}

          <div className="mt-8 bg-gray-50 border rounded-lg p-4 flex items-center justify-between flex-wrap gap-3">
            <div className="text-sm text-gray-700">
              도움이 되셨다면 친구와 공유해 주세요 👍
            </div>
            <ShareMenu
              title={post.title}
              description={post.description ?? undefined}
              imageUrl={post.cover_image_url ?? post.og_image ?? undefined}
            />
          </div>

          <div className="mt-4 flex items-center justify-between flex-wrap gap-2">
            <ResolutionBadge targetType="blog_post" targetSlug={post.slug} />
            <ReportButton
              mode="inline"
              targetType="blog_post"
              targetSlug={post.slug}
              label="이 글의 오류 신고"
            />
          </div>

          <ServiceCTA variant="blog" />

          {post.faq.length > 0 && (
            <section className="mt-12">
              <h2 className="text-2xl font-bold text-gray-900 mb-4 pb-2 border-b">자주 묻는 질문</h2>
              <div className="space-y-3">
                {post.faq.map((item, i) => (
                  <div key={i} className="border rounded-lg p-4">
                    <p className="font-medium text-gray-900 mb-2">Q. {item.question}</p>
                    <div className="text-sm text-gray-700 leading-relaxed prose prose-sm max-w-none prose-p:my-1 prose-a:text-blue-600 prose-a:no-underline hover:prose-a:underline">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {`A. ${item.answer}`}
                      </ReactMarkdown>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {(() => {
            // Gemini Grounding 중간 리다이렉트 URL은 노출하지 않음
            const visibleSources = post.source_urls.filter(
              (u) => !u.includes('vertexaisearch.cloud.google.com'),
            )
            if (visibleSources.length === 0) return null
            return (
              <section className="mt-10 bg-gray-50 border rounded-lg p-4">
                <p className="text-xs font-semibold text-gray-700 mb-2">참고 자료</p>
                <ul className="text-xs text-gray-600 space-y-1">
                  {visibleSources.map((u, i) => (
                    <li key={i}>
                      <a
                        href={u}
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                        className="text-blue-600 hover:underline break-all"
                      >
                        {u}
                      </a>
                    </li>
                  ))}
                </ul>
              </section>
            )
          })()}

          {related.length > 0 && (
            <section className="mt-12">
              <h2 className="text-2xl font-bold text-gray-900 mb-4 pb-2 border-b">
                관련 글
              </h2>
              <div className="grid sm:grid-cols-3 gap-4">
                {related.map((r) => (
                  <Link
                    key={r.slug}
                    href={`/blog/${r.slug}`}
                    className="block border rounded-lg p-4 hover:border-blue-300 hover:shadow-sm transition-all"
                  >
                    <span className="text-xs text-blue-700">{r.category}</span>
                    <h3 className="font-semibold text-gray-900 mt-1 text-sm line-clamp-2">{r.title}</h3>
                    <p className="text-xs text-gray-500 mt-1">{formatPublishedDate(r.published_at)}</p>
                  </Link>
                ))}
              </div>
            </section>
          )}
        </div>
      </article>
    </>
  )
}
