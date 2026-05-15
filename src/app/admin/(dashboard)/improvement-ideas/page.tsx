import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import IdeaCard, { type IdeaRow } from './IdeaCard'

export const dynamic = 'force-dynamic'

const PROJECT_FILTERS = [
  { value: 'all', label: '전체' },
  { value: 'product_recommend', label: 'product_recommend' },
  { value: 'jimscanner', label: 'jimscanner' },
] as const

const STATUS_FILTERS = [
  { value: 'all', label: '전체' },
  { value: 'proposed', label: '제안됨' },
  { value: 'in_progress', label: '진행중' },
  { value: 'done', label: '완료' },
  { value: 'rejected', label: '거절' },
  { value: 'duplicate', label: '중복' },
] as const

const CATEGORY_FILTERS = [
  { value: 'all', label: '전체' },
  { value: 'ux', label: 'UX' },
  { value: 'ops', label: '운영' },
  { value: 'monetization', label: '수익화' },
  { value: 'data_analysis', label: '데이터 분석' },
  { value: 'visualization', label: '시각화' },
  { value: 'product_discovery', label: '상품 발굴' },
  { value: 'infra', label: '인프라' },
  { value: 'other', label: '기타' },
] as const

// jimscanner_improvement_ideas 는 generated Database 타입에 아직 없어서 `as any` 우회
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sbLoose(): any {
  return createAdminClient()
}

async function fetchIdeas(filters: {
  project?: string
  status?: string
  category?: string
}): Promise<IdeaRow[]> {
  let q = sbLoose()
    .from('jimscanner_improvement_ideas')
    .select(
      'id, project, title, category, priority, description, rationale, referenced_files, dedup_signature, status, generated_at, cost_usd, input_tokens, output_tokens, num_turns, note, processing_started_at, implementation_branch, implementation_commit, implementation_error',
    )
    .order('generated_at', { ascending: false })
    .limit(300)

  if (filters.project && filters.project !== 'all') q = q.eq('project', filters.project)
  if (filters.status && filters.status !== 'all') q = q.eq('status', filters.status)
  if (filters.category && filters.category !== 'all') q = q.eq('category', filters.category)

  const { data, error } = await q
  if (error) {
    console.error('improvement-ideas fetch error:', error)
    return []
  }
  return (data ?? []) as IdeaRow[]
}

async function fetchCounts() {
  const { data } = await sbLoose()
    .from('jimscanner_improvement_ideas')
    .select('project, status')
    .limit(10000)
  const counts: Record<string, { total: number; open: number }> = {
    all: { total: 0, open: 0 },
    product_recommend: { total: 0, open: 0 },
    jimscanner: { total: 0, open: 0 },
  }
  for (const r of data ?? []) {
    const isOpen = r.status === 'proposed' || r.status === 'in_progress'
    counts.all.total++
    if (isOpen) counts.all.open++
    const p = counts[r.project as string]
    if (p) {
      p.total++
      if (isOpen) p.open++
    }
  }
  return counts
}

function makeHref(
  current: Record<string, string | undefined>,
  changes: Record<string, string>,
) {
  const merged = { ...current, ...changes }
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(merged)) {
    if (v && v !== 'all') params.set(k, v)
  }
  const qs = params.toString()
  return qs ? `/admin/improvement-ideas?${qs}` : '/admin/improvement-ideas'
}

export default async function ImprovementIdeasPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const project = typeof sp.project === 'string' ? sp.project : 'all'
  const status = typeof sp.status === 'string' ? sp.status : 'all'
  const category = typeof sp.category === 'string' ? sp.category : 'all'

  const [ideas, counts] = await Promise.all([
    fetchIdeas({ project, status, category }),
    fetchCounts(),
  ])

  const current = { project, status, category }

  return (
    <div className="space-y-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">💡 개선 제안</h1>
          <p className="text-sm text-gray-500 mt-1">
            매시간 Claude CLI 가 양쪽 admin 영역을 둘러보며 한 가지씩 개선안을 제안합니다.
          </p>
        </div>
        <div className="text-xs text-gray-500 text-right">
          <div>총 {counts.all.total}건 (열린 {counts.all.open}건)</div>
          <div className="mt-0.5">
            product_recommend {counts.product_recommend.total} · jimscanner {counts.jimscanner.total}
          </div>
        </div>
      </header>

      {/* Filter bars */}
      <div className="space-y-2">
        <FilterRow label="프로젝트" options={PROJECT_FILTERS} value={project} field="project" current={current} />
        <FilterRow label="상태" options={STATUS_FILTERS} value={status} field="status" current={current} />
        <FilterRow label="카테고리" options={CATEGORY_FILTERS} value={category} field="category" current={current} />
      </div>

      {/* Ideas list */}
      <div className="space-y-2">
        {ideas.length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-300 p-8 text-center text-sm text-gray-500">
            조건에 맞는 개선 제안이 없습니다.
            <div className="mt-2 text-xs text-gray-400">
              아직 스카우트가 한 번도 안 돌았다면 매시간 cron 이 발화한 뒤 채워집니다.
            </div>
          </div>
        ) : (
          ideas.map((idea) => <IdeaCard key={idea.id} idea={idea} />)
        )}
      </div>

      <section className="rounded border border-dashed border-gray-300 p-4 text-xs text-gray-500">
        <strong className="text-gray-700">운영:</strong> Windows Task Scheduler `jimscanner-improvement-scout`
        가 매시간 정각에 `scripts/improvement-scout-all.mjs` 를 실행. product_recommend cwd 와
        jimscanner cwd 둘 다 Claude CLI agentic 모드(Read/Grep/Glob, Edit 차단)로 스카우트.
        jimscanner 는 UX/운영/수익화 3축, product_recommend 는 트렌드 3축으로 분기된 프롬프트 사용.
        탐색 결과는 본 테이블 + `jimscanner_trends_runs (source=improvement_scout)` 에 적재.
      </section>
    </div>
  )
}

function FilterRow({
  label,
  options,
  value,
  field,
  current,
}: {
  label: string
  options: readonly { value: string; label: string }[]
  value: string
  field: string
  current: Record<string, string | undefined>
}) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-[11px] font-semibold text-gray-500 uppercase tracking-wider w-16">
        {label}
      </span>
      {options.map((o) => (
        <Link
          key={o.value}
          href={makeHref(current, { [field]: o.value })}
          className={`text-xs px-2.5 py-1 rounded-full transition-colors ${
            value === o.value
              ? 'bg-gray-900 text-white'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          {o.label}
        </Link>
      ))}
    </div>
  )
}
