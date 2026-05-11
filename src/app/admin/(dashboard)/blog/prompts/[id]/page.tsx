import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import type { BlogGenerationPrompt } from '@/lib/blog-prompts'
import PromptEditor from './PromptEditor'

export const dynamic = 'force-dynamic'

type ParentLite = {
  id: string
  version: number
  label: string
  system_prompt: string
}

export default async function PromptDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const supabase = createAdminClient()

  const { data: prompt } = await supabase
    .from('jimscanner_blog_generation_prompts')
    .select('*')
    .eq('id', id)
    .maybeSingle<BlogGenerationPrompt>()

  if (!prompt) notFound()

  let parent: ParentLite | null = null
  if (prompt.parent_version_id) {
    const { data: p } = await supabase
      .from('jimscanner_blog_generation_prompts')
      .select('id, version, label, system_prompt')
      .eq('id', prompt.parent_version_id)
      .maybeSingle<ParentLite>()
    parent = p ?? null
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="text-xs text-gray-500 mb-1">
          <Link href="/admin/blog/prompts" className="hover:underline">
            ← 프롬프트 목록
          </Link>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <h1 className="text-2xl font-bold text-gray-900">
            v{prompt.version} · {prompt.label}
          </h1>
          {prompt.is_active && (
            <span className="text-xs px-2 py-0.5 rounded bg-blue-100 text-blue-700 font-medium">
              active
            </span>
          )}
        </div>
        <p className="text-sm text-gray-500 mt-1">
          본문 수정은 새 버전 생성을 권장합니다 (히스토리 보존). 이 화면의 저장은 같은 버전 내에서 덮어쓰기입니다.
        </p>
      </div>

      <PromptEditor prompt={prompt} parent={parent} />
    </div>
  )
}
