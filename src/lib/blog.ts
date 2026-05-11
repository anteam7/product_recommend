export type BlogStatus = 'draft' | 'published'

export const BLOG_CATEGORIES = ['가이드', '추천', '비교', '팁', '뉴스'] as const
export type BlogCategory = (typeof BLOG_CATEGORIES)[number]

export type PipelineStatus =
  | 'manual'
  | 'draft'
  | 'reviewed'
  | 'needs_revision'
  | 'pending_approval'
  | 'published'
  | 'rejected'

export const PIPELINE_STATUS_LABEL: Record<PipelineStatus, { label: string; color: string }> = {
  manual:           { label: '수동',       color: 'bg-gray-100 text-gray-700' },
  draft:            { label: '초안',       color: 'bg-slate-100 text-slate-700' },
  reviewed:         { label: '검토 완료',   color: 'bg-indigo-100 text-indigo-700' },
  needs_revision:   { label: '개선 필요',   color: 'bg-amber-100 text-amber-700' },
  pending_approval: { label: '승인 대기',   color: 'bg-blue-100 text-blue-700' },
  published:        { label: '게시됨',     color: 'bg-green-100 text-green-700' },
  rejected:         { label: '거부',       color: 'bg-red-100 text-red-700' },
}

export type FaqItem = {
  question: string
  answer: string
}

export type ReviewScores = {
  seo: number
  traffic_potential: number
  ctr_potential: number
  facts: number
  human_likeness: number
  total: number
}

export type ReviewEntry = {
  tick_at: string
  revision_count_at_review: number
  overall: 'approve' | 'needs_revision' | 'reject'
  scores?: ReviewScores
  seo?: { issues?: string[]; suggestions?: string[] }
  traffic_potential?: {
    target_keywords?: string[]
    estimated_monthly_volume_tier?: 'low' | 'medium' | 'high'
    cannibalization_risk?: 'none' | 'low' | 'medium' | 'high'
    issues?: string[]
    suggestions?: string[]
  }
  ctr_potential?: {
    title_review?: string
    excerpt_review?: string
    suggestions?: string[]
  }
  facts?: {
    verified_claims?: string[]
    incorrect_claims?: { quote: string; correct_value: string }[]
    suggestions?: string[]
  }
  human_likeness?: {
    ai_patterns_found?: string[]
    suggestions?: string[]
  }
  one_line_summary?: string
  error?: string
}

export type BlogPost = {
  id: string
  slug: string
  title: string
  description: string | null
  content: string
  cover_image_url: string | null
  category: BlogCategory
  tags: string[]
  target_keywords: string[]
  faq: FaqItem[]
  status: BlogStatus
  source_urls: string[]
  seo_title: string | null
  seo_description: string | null
  og_image: string | null
  author: string
  published_at: string | null
  created_at: string
  updated_at: string
  created_by: string | null
  reviewed_by: string | null
  view_count: number
  // 파이프라인 확장 필드
  pipeline_status?: PipelineStatus
  revision_count?: number
  auto_generated?: boolean
  topic_category?: string | null
  topic_keywords?: string[] | null
  review_history?: ReviewEntry[]
  last_pipeline_tick_at?: string | null
  home_featured?: boolean
  home_order?: number | null
}

export type BlogPostInput = Omit<
  Partial<BlogPost>,
  'id' | 'created_at' | 'updated_at' | 'published_at'
>

export function slugify(title: string): string {
  const koRomanize = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9가-힣\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  return koRomanize.slice(0, 80) || `post-${Date.now()}`
}

export function countWords(markdown: string): number {
  return markdown.replace(/[#*_`>\[\]\(\)!-]/g, '').replace(/\s+/g, ' ').trim().length
}

/**
 * Markdown 본문의 맨 앞에 있는 H1 제목을 제거.
 * 페이지는 title 필드를 <h1>으로 렌더링하므로 본문 첫 H1은 시각적 중복.
 */
export function stripLeadingH1(markdown: string): string {
  return markdown.replace(/^#\s+[^\n]+\n+/, '')
}

/**
 * 마크다운 링크 `[text](url)` 만 `<a href="url">text</a>` 로 변환.
 * FAQ JSON-LD `acceptedAnswer.text` 에 사용. Google FAQ rich result 는 `<a>` 를 허용.
 * 텍스트 본문에는 ReactMarkdown 을 사용하므로 이 함수는 SEO/구조화 데이터 전용.
 */
export function markdownLinksToHtml(s: string): string {
  if (!s) return ''
  return s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text, url) => {
    const safeUrl = String(url).replace(/"/g, '&quot;').replace(/</g, '&lt;')
    const safeText = String(text).replace(/</g, '&lt;')
    return `<a href="${safeUrl}">${safeText}</a>`
  })
}

export const MIN_BLOG_CHARS = 1500

// ─────────────────────────────────────────────
// 수동 AI 검토 (에디터 트리거, 자유 관점, 자동 반영)
// ─────────────────────────────────────────────

export const DEFAULT_REVIEW_PERSPECTIVES = [
  'AI 문체',
  'SEO',
  '클릭 유도',
  '유입 잠재력',
  '팩트 검증',
] as const

// grounding이 기본으로 켜져야 하는 관점 (UI 자동 토글 + 서버 가드)
export const GROUNDING_PRESET_PERSPECTIVES: readonly string[] = ['팩트 검증']

export type ReviewFinding = {
  perspective: string
  issues: string[]
  suggestions: string[]
}

export type BlogPostReview = {
  id: string
  post_slug: string
  created_at: string
  created_by: string | null
  model: string | null
  perspectives: string[]
  findings: ReviewFinding[]
  summary: string | null
  title_before: string | null
  title_after: string | null
  description_before: string | null
  description_after: string | null
  content_before: string | null
  content_after: string | null
  applied: boolean
  reverted_at: string | null
  grounding_urls: string[]
}

export type ReviewPerspectivePreset = {
  id: string
  name: string
  created_at: string
  created_by: string | null
}

export function estimateReadingMinutes(chars: number): number {
  // 한국어: 평균 300자/분 기준
  return Math.max(1, Math.round(chars / 300))
}

export function formatPublishedDate(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('ko-KR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}
