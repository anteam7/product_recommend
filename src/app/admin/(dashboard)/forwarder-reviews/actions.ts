'use server'

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/auth/admin-supabase'

// 신규 테이블이 generated supabase 타입에 등록 전 — `from(any)` 캐스트로 우회.
// SUPABASE_SERVICE_ROLE_KEY 사용하므로 RLS 우회됨.
function adminAny() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createAdminClient() as any
}

type ToggleHiddenInput = {
  reviewId: string
  isHidden: boolean
  forwarderSlug: string | null
}

export async function toggleReviewHidden(input: ToggleHiddenInput) {
  const { error } = await adminAny()
    .from('jimscanner_forwarder_reviews')
    .update({ is_hidden: input.isHidden })
    .eq('id', input.reviewId)

  if (error) return { ok: false, error: error.message }

  revalidatePath('/admin/forwarder-reviews')
  if (input.forwarderSlug) {
    revalidatePath(`/forwarders/${input.forwarderSlug}`, 'layout')
  }
  revalidatePath('/forwarders', 'layout')
  return { ok: true }
}

type AddReviewInput = {
  forwarderId: string
  country: 'US' | 'JP' | 'CN'
  forwarderSlug: string | null
  reviewDate: string | null
  url: string | null
  platform: string | null
  summary: string
  tone: '긍정' | '중립' | '부정' | '혼재'
  keywords: string[]
}

export async function addManualReview(input: AddReviewInput) {
  const summary = input.summary.trim()
  if (!summary) return { ok: false, error: 'summary 비어있음' }

  const { error } = await adminAny()
    .from('jimscanner_forwarder_reviews')
    .insert({
      forwarder_id: input.forwarderId,
      country: input.country,
      review_date: input.reviewDate,
      url: input.url,
      platform: input.platform,
      summary,
      tone: input.tone,
      keywords: input.keywords,
      source: 'manual',
    })

  if (error) return { ok: false, error: error.message }

  await refreshReviewSummaryCount(input.forwarderId, input.country)

  revalidatePath('/admin/forwarder-reviews')
  if (input.forwarderSlug) {
    revalidatePath(`/forwarders/${input.forwarderSlug}`, 'layout')
  }
  revalidatePath('/forwarders', 'layout')
  return { ok: true }
}

async function refreshReviewSummaryCount(forwarderId: string, country: string) {
  const a = adminAny()
  const { count } = await a
    .from('jimscanner_forwarder_reviews')
    .select('id', { count: 'exact', head: true })
    .eq('forwarder_id', forwarderId)
    .eq('country', country)
    .eq('is_hidden', false)
  if (count === null) return
  await a
    .from('jimscanner_forwarder_review_summary')
    .update({ review_count: count })
    .eq('forwarder_id', forwarderId)
    .eq('country', country)
}
