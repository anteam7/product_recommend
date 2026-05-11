import Link from 'next/link'
import type { RelatedBlog } from '@/lib/related-blog'

type Props = {
  posts: RelatedBlog[]
  title?: string
  subtitle?: string
}

export default function RelatedPostsBox({
  posts,
  title = '📘 관련 가이드 · 실전 팁',
  subtitle = '짐스캐너 블로그의 실제 운영 경험 글',
}: Props) {
  if (posts.length === 0) return null

  return (
    <section className="bg-white border rounded-lg p-5 space-y-3">
      <header>
        <h3 className="text-sm font-bold text-gray-900">{title}</h3>
        {subtitle && <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>}
      </header>

      <ul className="grid gap-3 sm:grid-cols-3">
        {posts.map((p) => (
          <li key={p.slug}>
            <Link
              href={`/blog/${p.slug}`}
              className="group block border rounded-md overflow-hidden hover:border-blue-300 transition"
            >
              {p.cover_image_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={p.cover_image_url}
                  alt={p.title}
                  className="w-full aspect-[16/9] object-cover"
                  loading="lazy"
                />
              ) : (
                <div className="w-full aspect-[16/9] bg-gradient-to-br from-gray-100 to-gray-200 flex items-center justify-center text-xs text-gray-400">
                  📄 {p.category}
                </div>
              )}
              <div className="p-3 space-y-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 font-medium">
                    {p.category}
                  </span>
                </div>
                <h4 className="text-sm font-semibold text-gray-900 line-clamp-2 group-hover:text-blue-600">
                  {p.title}
                </h4>
                {p.description && (
                  <p className="text-xs text-gray-500 line-clamp-2">{p.description}</p>
                )}
              </div>
            </Link>
          </li>
        ))}
      </ul>

      <div className="text-right">
        <Link
          href="/blog"
          className="text-xs text-blue-600 hover:underline font-medium"
        >
          전체 블로그 보기 →
        </Link>
      </div>
    </section>
  )
}
