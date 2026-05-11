import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import type { ForwarderReview, ForwarderReviewSummary, ReviewTone } from '@/types'
import ForwarderReviewsClient from './ForwarderReviewsClient'

export const dynamic = 'force-dynamic'

type Search = {
  forwarder?: string
  country?: string
  tone?: string
  hidden?: string
}

const COUNTRY_NAME: Record<string, string> = { US: '미국', JP: '일본', CN: '중국' }

export default async function AdminForwarderReviewsPage({
  searchParams,
}: {
  searchParams: Promise<Search>
}) {
  const sp = await searchParams
  const forwarderFilter = sp.forwarder?.trim() || null
  const countryFilter = ['US', 'JP', 'CN'].includes(sp.country ?? '')
    ? (sp.country as 'US' | 'JP' | 'CN')
    : null
  const toneFilter = ['긍정', '중립', '부정', '혼재'].includes(sp.tone ?? '')
    ? (sp.tone as ReviewTone)
    : null
  const showHidden = sp.hidden === '1'

  const admin = createAdminClient()
  const a = admin as unknown as { from: (t: string) => ReturnType<typeof admin.from> }

  // 활성 배대지 목록 (필터·드롭다운용)
  const { data: forwardersRaw } = await admin
    .from('forwarders')
    .select('id, name, slug')
    .eq('is_active', true)
    .order('name')
  const forwarders = (forwardersRaw ?? []) as { id: string; name: string; slug: string }[]
  const fwdById = new Map(forwarders.map((f) => [f.id, f]))

  // summary 전체 (forwarder × country)
  const { data: summariesRaw } = await a
    .from('jimscanner_forwarder_review_summary')
    .select('*')
  const summaries = ((summariesRaw ?? []) as unknown as ForwarderReviewSummary[])

  // 후기 본문 — 필터 적용
  let reviewQuery = a
    .from('jimscanner_forwarder_reviews')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(500)

  if (forwarderFilter) reviewQuery = reviewQuery.eq('forwarder_id', forwarderFilter)
  if (countryFilter) reviewQuery = reviewQuery.eq('country', countryFilter)
  if (toneFilter) reviewQuery = reviewQuery.eq('tone', toneFilter)
  if (!showHidden) reviewQuery = reviewQuery.eq('is_hidden', false)

  const { data: reviewsRaw } = await reviewQuery
  const reviews = ((reviewsRaw ?? []) as unknown as ForwarderReview[])

  // 카운트 (헤더 숫자)
  const totalReviews = reviews.length
  const hiddenCount = reviews.filter((r) => r.is_hidden).length

  // 데이터 가용성 통계 (헤더 카드)
  const availabilityStats = {
    full: summaries.filter((s) => s.data_availability === 'full').length,
    limited: summaries.filter((s) => s.data_availability === 'limited').length,
    none: summaries.filter((s) => s.data_availability === 'none').length,
    sentimentPositive: summaries.filter((s) => s.overall_sentiment === '긍정 우세').length,
    sentimentNegative: summaries.filter((s) => s.overall_sentiment === '부정 우세').length,
  }

  return (
    <div className="p-6 max-w-[1280px] mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">배대지 후기 관리</h1>
        <p className="text-sm text-gray-500 mt-1">
          외부 블로그·커뮤니티에서 수집한 후기. 부적절한 후기는 숨김 처리할 수 있고, 수동 추가도 가능합니다.
        </p>
      </div>

      {/* 헤더 통계 카드 */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-6">
        <StatCard label="총 후기" value={totalReviews} />
        <StatCard label="숨김 처리" value={hiddenCount} tone="warning" />
        <StatCard label="긍정 우세 배대지" value={availabilityStats.sentimentPositive} tone="success" />
        <StatCard label="부정 우세 배대지" value={availabilityStats.sentimentNegative} tone="danger" />
        <StatCard
          label="후기 부족"
          value={`${availabilityStats.limited}+${availabilityStats.none}`}
          tone="muted"
        />
      </div>

      {/* 필터 */}
      <form className="bg-white border rounded-lg p-4 mb-4 flex flex-wrap items-end gap-3" method="GET">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-500">배대지</label>
          <select
            name="forwarder"
            defaultValue={forwarderFilter ?? ''}
            className="border rounded px-2 py-1 text-sm"
          >
            <option value="">전체</option>
            {forwarders.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-500">국가</label>
          <select
            name="country"
            defaultValue={countryFilter ?? ''}
            className="border rounded px-2 py-1 text-sm"
          >
            <option value="">전체</option>
            <option value="US">미국</option>
            <option value="JP">일본</option>
            <option value="CN">중국</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-500">Tone</label>
          <select
            name="tone"
            defaultValue={toneFilter ?? ''}
            className="border rounded px-2 py-1 text-sm"
          >
            <option value="">전체</option>
            <option value="긍정">긍정</option>
            <option value="중립">중립</option>
            <option value="부정">부정</option>
            <option value="혼재">혼재</option>
          </select>
        </div>
        <label className="flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            name="hidden"
            value="1"
            defaultChecked={showHidden}
          />
          숨김 포함
        </label>
        <button
          type="submit"
          className="bg-blue-600 text-white text-sm px-3 py-1.5 rounded hover:bg-blue-700"
        >
          필터 적용
        </button>
        <Link
          href="/admin/forwarder-reviews"
          className="text-sm text-gray-500 hover:text-gray-700 underline-offset-2 hover:underline"
        >
          초기화
        </Link>
      </form>

      <ForwarderReviewsClient
        reviews={reviews.map((r) => ({
          ...r,
          forwarderName: fwdById.get(r.forwarder_id)?.name ?? '(삭제됨)',
          forwarderSlug: fwdById.get(r.forwarder_id)?.slug ?? null,
          countryLabel: COUNTRY_NAME[r.country] ?? r.country,
        }))}
        forwarders={forwarders}
      />
    </div>
  )
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string
  value: number | string
  tone?: 'success' | 'warning' | 'danger' | 'muted'
}) {
  const toneClass =
    tone === 'success'
      ? 'text-green-700'
      : tone === 'warning'
      ? 'text-amber-700'
      : tone === 'danger'
      ? 'text-red-700'
      : tone === 'muted'
      ? 'text-gray-500'
      : 'text-gray-900'
  return (
    <div className="border rounded-lg p-3 bg-white">
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`text-xl font-bold mt-1 ${toneClass}`}>{value}</p>
    </div>
  )
}
