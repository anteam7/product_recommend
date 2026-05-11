import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import type { BlogGenerationPrompt } from '@/lib/blog-prompts'
import PromptListClient from './PromptListClient'

export const dynamic = 'force-dynamic'

type Row = Pick<
  BlogGenerationPrompt,
  | 'id'
  | 'version'
  | 'label'
  | 'is_active'
  | 'parent_version_id'
  | 'change_summary'
  | 'derived_from_review_ids'
  | 'char_count'
  | 'created_at'
  | 'created_by'
>

export default async function PromptsListPage() {
  const supabase = createAdminClient()
  const { data: prompts } = await supabase
    .from('jimscanner_blog_generation_prompts')
    .select(
      'id, version, label, is_active, parent_version_id, change_summary, derived_from_review_ids, char_count, created_at, created_by',
    )
    .order('version', { ascending: false })

  const list = (prompts ?? []) as Row[]
  const isEmpty = list.length === 0
  const activeRow = list.find((p) => p.is_active) ?? null

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <div className="text-xs text-gray-500 mb-1">
            <Link href="/admin/blog" className="hover:underline">
              ← 블로그 관리
            </Link>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">AI 글 생성 프롬프트</h1>
          <p className="text-sm text-gray-500 mt-1">
            새 글 생성 시 사용되는 system prompt 의 버전을 관리합니다. 정확히 한 버전만 active 입니다.
            큰 변경은 새 버전을 만들어 저장한 뒤 active 로 전환하세요.
          </p>
        </div>
        {!isEmpty && (
          <Link
            href="/admin/blog/prompts/improve"
            className="text-sm px-3 py-2 rounded-md bg-indigo-600 text-white hover:bg-indigo-700 shrink-0"
          >
            🔍 검토 결과로 보강 제안
          </Link>
        )}
      </div>

      {isEmpty ? (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-5 space-y-3">
          <div>
            <h2 className="text-sm font-bold text-amber-900">아직 시드되지 않았습니다</h2>
            <p className="text-xs text-amber-800 mt-1">
              현재 코드 기본값이 fallback 으로 사용 중입니다. 아래 버튼으로 v1 을 생성하면 DB 가 source of truth 가 됩니다.
              이후 수정·버전 관리는 모두 이 화면에서 진행됩니다.
            </p>
          </div>
          <PromptListClient prompts={[]} mode="seed" />
        </div>
      ) : (
        <>
          {activeRow && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex items-start justify-between gap-3">
              <div>
                <div className="text-xs uppercase tracking-wide text-blue-700 font-semibold">
                  현재 active
                </div>
                <div className="font-bold text-gray-900 mt-0.5">
                  v{activeRow.version} · {activeRow.label}
                </div>
                <div className="text-xs text-gray-600 mt-1">
                  {activeRow.char_count.toLocaleString()}자 ·{' '}
                  {new Date(activeRow.created_at).toLocaleString('ko-KR', {
                    dateStyle: 'short',
                    timeStyle: 'short',
                  })}
                </div>
              </div>
              <Link
                href={`/admin/blog/prompts/${activeRow.id}`}
                className="text-sm text-blue-600 hover:underline shrink-0 self-center"
              >
                편집 →
              </Link>
            </div>
          )}

          <PromptListClient prompts={list} mode="list" />
        </>
      )}
    </div>
  )
}
