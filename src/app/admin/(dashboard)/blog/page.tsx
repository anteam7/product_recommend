import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import {
  BLOG_CATEGORIES,
  type BlogCategory,
  type BlogPost,
  countWords,
  MIN_BLOG_CHARS,
  PIPELINE_STATUS_LABEL,
  type PipelineStatus,
} from '@/lib/blog'
import { Badge } from '@/components/ui/badge'
import NewBlogButton from './NewBlogButton'

export const dynamic = 'force-dynamic'

const FILTER_ORDER: { key: 'all' | 'auto' | 'home' | PipelineStatus; label: string }[] = [
  { key: 'all', label: '전체' },
  { key: 'home', label: '📌 메인 노출' },
  { key: 'auto', label: '자동 생성' },
  { key: 'draft', label: '초안' },
  { key: 'needs_revision', label: '개선 필요' },
  { key: 'pending_approval', label: '승인 대기' },
  { key: 'published', label: '게시됨' },
  { key: 'rejected', label: '거부' },
]

export default async function BlogListPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>
}) {
  const { filter } = await searchParams
  const activeFilter = (filter ?? 'all') as 'all' | 'auto' | 'home' | PipelineStatus

  const supabase = createAdminClient()
  const { data: posts } = await supabase
    .from('jimscanner_blog_posts')
    .select('*')
    .order('updated_at', { ascending: false })

  const list = (posts ?? []) as BlogPost[]

  const filtered = list.filter((p) => {
    if (activeFilter === 'all') return true
    if (activeFilter === 'auto') return p.auto_generated === true
    if (activeFilter === 'home') return p.home_featured === true
    return p.pipeline_status === activeFilter
  })

  const publishedCount = list.filter((p) => p.status === 'published').length
  const draftCount = list.filter((p) => p.status === 'draft').length
  const autoCount = list.filter((p) => p.auto_generated === true).length
  const homeCount = list.filter((p) => p.home_featured === true).length
  const pendingApprovalCount = list.filter(
    (p) => p.pipeline_status === 'pending_approval',
  ).length

  const publishedList = list.filter((p) => p.status === 'published')
  const categoryDistribution: { category: BlogCategory; count: number; pct: number }[] =
    BLOG_CATEGORIES.map((category) => {
      const count = publishedList.filter((p) => p.category === category).length
      const pct = publishedList.length > 0 ? (count / publishedList.length) * 100 : 0
      return { category, count, pct }
    }).sort((a, b) => b.count - a.count)
  const categoryBarColor: Record<BlogCategory, string> = {
    가이드: 'bg-blue-500',
    추천: 'bg-emerald-500',
    비교: 'bg-amber-500',
    팁: 'bg-violet-500',
    뉴스: 'bg-rose-500',
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">블로그 관리</h1>
          <p className="text-sm text-gray-500 mt-1">
            자동 파이프라인 + 수동 작성 모두 이곳에 누적됩니다. 게시 전 반드시 검토·편집 후 공개하세요.
            최소 {MIN_BLOG_CHARS.toLocaleString()}자 권장.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/admin/blog/home-sections"
            className="text-sm px-3 py-2 rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50"
          >
            🏠 메인 섹션 관리
          </Link>
          <Link
            href="/admin/blog/prompts"
            className="text-sm px-3 py-2 rounded-md border border-gray-300 text-gray-700 hover:bg-gray-50"
          >
            ⚙️ 프롬프트 관리
          </Link>
          <NewBlogButton />
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-white border rounded-lg p-4">
          <p className="text-xs text-gray-500">전체</p>
          <p className="text-2xl font-bold text-gray-900">{list.length}</p>
        </div>
        <div className="bg-white border rounded-lg p-4">
          <p className="text-xs text-gray-500">게시됨</p>
          <p className="text-2xl font-bold text-green-600">{publishedCount}</p>
        </div>
        <div className="bg-white border rounded-lg p-4">
          <p className="text-xs text-gray-500">승인 대기 (자동)</p>
          <p className="text-2xl font-bold text-blue-600">{pendingApprovalCount}</p>
        </div>
        <div className="bg-white border rounded-lg p-4">
          <p className="text-xs text-gray-500">자동 생성 총</p>
          <p className="text-2xl font-bold text-indigo-600">{autoCount}</p>
        </div>
      </div>

      {/* 게시된 글 카테고리 분포 */}
      <div className="bg-white border rounded-lg p-4">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-sm font-semibold text-gray-900">📊 게시된 글 카테고리 분포</h2>
          <span className="text-xs text-gray-500">총 {publishedList.length}개 게시됨</span>
        </div>
        {publishedList.length === 0 ? (
          <p className="text-xs text-gray-500">아직 게시된 글이 없습니다.</p>
        ) : (
          <div className="space-y-2">
            {categoryDistribution.map(({ category, count, pct }) => (
              <div key={category} className="flex items-center gap-3">
                <span className="w-12 shrink-0 text-xs font-medium text-gray-700">{category}</span>
                <div className="flex-1 h-2.5 bg-gray-100 rounded-full overflow-hidden">
                  <div
                    className={`h-full ${categoryBarColor[category]} transition-all`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="w-20 shrink-0 text-right text-xs font-mono text-gray-700">
                  {count}개 · {pct.toFixed(0)}%
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 필터 탭 */}
      <div className="flex flex-wrap gap-1 border-b">
        {FILTER_ORDER.map((f) => {
          const count =
            f.key === 'all'
              ? list.length
              : f.key === 'auto'
                ? autoCount
                : f.key === 'home'
                  ? homeCount
                  : list.filter((p) => p.pipeline_status === f.key).length
          const active = activeFilter === f.key
          return (
            <Link
              key={f.key}
              href={f.key === 'all' ? '/admin/blog' : `/admin/blog?filter=${f.key}`}
              className={`px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-colors ${
                active
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-600 hover:text-gray-900'
              }`}
            >
              {f.label}
              <span className="ml-1 text-[10px] text-gray-400">{count}</span>
            </Link>
          )
        })}
      </div>

      {filtered.length === 0 ? (
        <div className="bg-white border rounded-lg p-10 text-center text-sm text-gray-500">
          {activeFilter === 'all'
            ? '아직 작성된 글이 없습니다. 상단의 "새 글 작성" 버튼으로 시작하세요.'
            : `해당 필터에 맞는 글이 없습니다.`}
        </div>
      ) : (
        <div className="bg-white border rounded-lg overflow-x-auto">
          <table className="w-full text-sm min-w-[860px]">
            <thead className="bg-gray-50 border-b">
              <tr>
                <th className="text-left px-4 py-2 text-xs font-semibold text-gray-600 uppercase">제목</th>
                <th className="text-left px-4 py-2 text-xs font-semibold text-gray-600 uppercase">카테고리</th>
                <th className="text-left px-4 py-2 text-xs font-semibold text-gray-600 uppercase">파이프라인</th>
                <th className="text-left px-4 py-2 text-xs font-semibold text-gray-600 uppercase">공개</th>
                <th className="text-center px-4 py-2 text-xs font-semibold text-gray-600 uppercase">메인</th>
                <th className="text-right px-4 py-2 text-xs font-semibold text-gray-600 uppercase">길이</th>
                <th className="text-left px-4 py-2 text-xs font-semibold text-gray-600 uppercase">업데이트</th>
                <th className="text-right px-4 py-2 text-xs font-semibold text-gray-600 uppercase"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((p) => {
                const chars = countWords(p.content)
                const tooShort = chars < MIN_BLOG_CHARS
                const pipeline = p.pipeline_status ?? 'manual'
                const pipelineMeta = PIPELINE_STATUS_LABEL[pipeline]
                return (
                  <tr key={p.id} className="border-b last:border-b-0 hover:bg-gray-50/50">
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-1.5">
                        {p.auto_generated && (
                          <span
                            title="자동 생성"
                            className="text-[10px] px-1 py-0.5 rounded bg-indigo-100 text-indigo-700 font-medium shrink-0"
                          >
                            🤖
                          </span>
                        )}
                        <div className="font-medium text-gray-900 line-clamp-1">
                          {p.title || '(제목 없음)'}
                        </div>
                      </div>
                      <div className="text-xs text-gray-500 font-mono mt-0.5">{p.slug}</div>
                    </td>
                    <td className="px-4 py-2">
                      <span className="text-xs bg-gray-100 px-2 py-0.5 rounded">{p.category}</span>
                      {p.topic_category && p.topic_category !== p.category && (
                        <span className="text-[10px] text-gray-400 ml-1">({p.topic_category})</span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <span
                        className={`text-xs px-2 py-0.5 rounded font-medium ${pipelineMeta.color}`}
                      >
                        {pipelineMeta.label}
                      </span>
                      {(p.revision_count ?? 0) > 0 && (
                        <span className="text-[10px] text-gray-500 ml-1 font-mono">
                          rev {p.revision_count}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <Badge className={p.status === 'published' ? 'bg-green-600' : 'bg-amber-500'}>
                        {p.status === 'published' ? '게시됨' : '드래프트'}
                      </Badge>
                    </td>
                    <td className="px-4 py-2 text-center">
                      {p.home_featured ? (
                        <span
                          title={p.home_order != null ? `메인 노출 · 순서 ${p.home_order}` : '메인 노출 · 순서 자동'}
                          className="inline-flex items-center gap-1 rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-700"
                        >
                          📌
                          {p.home_order != null && (
                            <span className="font-mono text-[10px]">{p.home_order}</span>
                          )}
                        </span>
                      ) : (
                        <span className="text-gray-300">·</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-xs">
                      <span className={tooShort ? 'text-amber-600' : 'text-gray-900'}>
                        {chars.toLocaleString()}자
                      </span>
                    </td>
                    <td className="px-4 py-2 text-xs text-gray-500 whitespace-nowrap">
                      {new Date(p.updated_at).toLocaleDateString('ko-KR', {
                        year: '2-digit',
                        month: '2-digit',
                        day: '2-digit',
                      })}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Link
                        href={`/admin/blog/${p.slug}`}
                        className="text-xs text-blue-600 hover:underline font-medium"
                      >
                        편집 →
                      </Link>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
