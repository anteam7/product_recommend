import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import type { BlogGenerationPrompt } from '@/lib/blog-prompts'
import PromptImproveClient from './PromptImproveClient'

export const dynamic = 'force-dynamic'

type ActiveLite = Pick<
  BlogGenerationPrompt,
  'id' | 'version' | 'label' | 'system_prompt' | 'char_count'
>

export default async function PromptImprovePage() {
  const supabase = createAdminClient()

  const { data: active } = await supabase
    .from('jimscanner_blog_generation_prompts')
    .select('id, version, label, system_prompt, char_count')
    .eq('is_active', true)
    .maybeSingle<ActiveLite>()

  // 수동 검토 관점 후보 (사용자가 정의했던 것 + 기본값)
  const { data: perspectiveRows } = await supabase
    .from('jimscanner_blog_review_perspectives')
    .select('name')
    .order('name')

  const perspectiveOptions = (perspectiveRows ?? []).map((r) => r.name as string)

  // 과거 누적 검토 수 (UI 에 컨텍스트로 표시)
  const { count: manualCount } = await supabase
    .from('jimscanner_blog_post_reviews')
    .select('id', { count: 'exact', head: true })

  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs text-gray-500 mb-1">
          <Link href="/admin/blog/prompts" className="hover:underline">
            ← 프롬프트 목록
          </Link>
        </div>
        <h1 className="text-2xl font-bold text-gray-900">검토 결과로 보강 제안</h1>
        <p className="text-sm text-gray-500 mt-1 max-w-3xl">
          누적된 검토 로그(수동 검토 + 파이프라인 자동 검토)를 집계해 현재 active 프롬프트의 보강안을 AI 가
          제안합니다. <strong>자동 반영은 하지 않으며</strong>, 사람이 검수한 뒤 새 버전으로 저장하는 단계까지가 한 흐름입니다.
        </p>
      </div>

      {!active ? (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-900">
          active 프롬프트가 없습니다. 먼저{' '}
          <Link href="/admin/blog/prompts" className="underline font-medium">
            프롬프트 목록
          </Link>{' '}
          에서 v1 을 시드하거나 한 버전을 active 로 전환하세요.
        </div>
      ) : (
        <PromptImproveClient
          active={active}
          perspectiveOptions={perspectiveOptions}
          totalManualReviews={manualCount ?? 0}
        />
      )}
    </div>
  )
}
