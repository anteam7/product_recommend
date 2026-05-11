'use client'

import { useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  type BlogPost,
  type BlogCategory,
  type FaqItem,
  BLOG_CATEGORIES,
  countWords,
  MIN_BLOG_CHARS,
  stripLeadingH1,
} from '@/lib/blog'

type Tab = 'content' | 'meta' | 'faq' | 'preview'

export default function BlogEditor({ initial }: { initial: BlogPost }) {
  const router = useRouter()
  const [post, setPost] = useState<BlogPost>(initial)
  const [tab, setTab] = useState<Tab>('content')
  const [msg, setMsg] = useState<{ type: 'success' | 'error' | 'info'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const chars = useMemo(() => countWords(post.content), [post.content])
  const tooShort = chars < MIN_BLOG_CHARS

  function patch<K extends keyof BlogPost>(key: K, value: BlogPost[K]) {
    setPost((p) => ({ ...p, [key]: value }))
  }

  async function api(endpoint: string, body?: unknown) {
    const res = await fetch(`/api/admin/blog/${post.slug}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error ?? `${endpoint} 실패`)
    return data
  }

  async function handleSave() {
    setBusy(true)
    setMsg(null)
    try {
      const data = await api('save', {
        title: post.title,
        description: post.description,
        content: post.content,
        cover_image_url: post.cover_image_url,
        category: post.category,
        tags: post.tags,
        target_keywords: post.target_keywords,
        faq: post.faq,
        seo_title: post.seo_title,
        seo_description: post.seo_description,
        og_image: post.og_image,
        author: post.author,
        home_featured: post.home_featured ?? false,
        home_order: post.home_order ?? null,
      })
      setPost(data.post)
      setMsg({ type: 'success', text: '저장되었습니다' })
    } catch (err) {
      setMsg({ type: 'error', text: err instanceof Error ? err.message : '오류' })
    } finally {
      setBusy(false)
    }
  }

  async function handlePublish() {
    if (tooShort && !confirm(`본문이 ${chars}자입니다. 권장 ${MIN_BLOG_CHARS}자 미만인데 그대로 발행할까요?`)) return
    if (!confirm('발행하면 /blog에 즉시 노출됩니다. 진행할까요?')) return
    setBusy(true)
    setMsg(null)
    try {
      // 먼저 현재 편집 내용 저장
      await api('save', {
        title: post.title, description: post.description, content: post.content,
        cover_image_url: post.cover_image_url, category: post.category, tags: post.tags,
        target_keywords: post.target_keywords, faq: post.faq, seo_title: post.seo_title,
        seo_description: post.seo_description, og_image: post.og_image, author: post.author,
        home_featured: post.home_featured ?? false, home_order: post.home_order ?? null,
      })
      const data = await api('publish')
      setPost(data.post)
      setMsg({ type: 'success', text: '발행 완료 — /blog에 반영되었습니다' })
      router.refresh()
    } catch (err) {
      setMsg({ type: 'error', text: err instanceof Error ? err.message : '오류' })
    } finally {
      setBusy(false)
    }
  }

  async function handleUnpublish() {
    if (!confirm('발행을 취소합니다. 프론트에서 숨겨집니다.')) return
    setBusy(true)
    try {
      await api('unpublish')
      setPost((p) => ({ ...p, status: 'draft', published_at: null }))
      setMsg({ type: 'info', text: '발행 취소됨' })
      router.refresh()
    } catch (err) {
      setMsg({ type: 'error', text: err instanceof Error ? err.message : '오류' })
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete() {
    if (!confirm('이 글을 영구 삭제합니다. 되돌릴 수 없습니다.')) return
    setBusy(true)
    try {
      await api('delete')
      router.push('/admin/blog')
    } catch (err) {
      setMsg({ type: 'error', text: err instanceof Error ? err.message : '오류' })
      setBusy(false)
    }
  }

  async function handleRevalidate() {
    setBusy(true)
    setMsg(null)
    try {
      await api('revalidate')
      setMsg({ type: 'success', text: '프론트 캐시 재검증 요청 보냄 — 몇 초 후 /blog 에서 최신 내용 확인' })
    } catch (err) {
      setMsg({ type: 'error', text: err instanceof Error ? err.message : '오류' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* 상단 바 */}
      <div className="bg-white border rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-3 flex-wrap">
            <Badge className={post.status === 'published' ? 'bg-green-600' : 'bg-amber-500'}>
              {post.status === 'published' ? '발행됨' : '드래프트'}
            </Badge>
            <span className={`text-sm ${tooShort ? 'text-amber-600' : 'text-gray-600'}`}>
              {chars.toLocaleString()}자 {tooShort && `· 최소 ${MIN_BLOG_CHARS}자 권장`}
            </span>
            {post.target_keywords.length > 0 && (
              <span className="text-xs text-gray-500">
                🎯 {post.target_keywords.join(', ')}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="outline" size="sm" onClick={handleSave} disabled={busy}>
              저장
            </Button>
            {post.status === 'published' ? (
              <Button size="sm" className="bg-red-600 hover:bg-red-700" onClick={handleUnpublish} disabled={busy}>
                발행 취소
              </Button>
            ) : (
              <Button size="sm" className="bg-green-600 hover:bg-green-700" onClick={handlePublish} disabled={busy}>
                발행
              </Button>
            )}
            {post.status === 'published' && (
              <Button variant="outline" size="sm" onClick={handleRevalidate} disabled={busy} title="Vercel Edge Cache 강제 재검증">
                🔄 캐시 갱신
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={handleDelete} disabled={busy} className="text-red-600">
              삭제
            </Button>
          </div>
        </div>

        <Input
          value={post.title}
          onChange={(e) => patch('title', e.target.value)}
          placeholder="제목"
          className="text-lg font-bold"
        />
        <div className="grid sm:grid-cols-3 gap-2">
          <Input
            value={post.slug}
            disabled
            className="font-mono text-xs text-gray-500"
          />
          <select
            value={post.category}
            onChange={(e) => patch('category', e.target.value as BlogCategory)}
            className="border rounded-md px-3 py-2 text-sm"
          >
            {BLOG_CATEGORIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <Input
            value={post.author}
            onChange={(e) => patch('author', e.target.value)}
            placeholder="작성자"
          />
        </div>
      </div>

      {msg && (
        <div
          className={`rounded-md px-4 py-2 text-sm border ${
            msg.type === 'success'
              ? 'bg-green-50 border-green-100 text-green-700'
              : msg.type === 'error'
                ? 'bg-red-50 border-red-100 text-red-700'
                : 'bg-blue-50 border-blue-100 text-blue-700'
          }`}
        >
          {msg.text}
        </div>
      )}

      {/* 메인 페이지 큐레이션 */}
      <div className="bg-white border rounded-lg p-4 flex items-center gap-4 flex-wrap">
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={post.home_featured ?? false}
            onChange={(e) => patch('home_featured', e.target.checked)}
            className="h-4 w-4 cursor-pointer"
          />
          <span className="text-sm font-medium text-gray-900">📌 메인 노출</span>
        </label>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500">순서</span>
          <Input
            type="number"
            value={post.home_order ?? ''}
            onChange={(e) => {
              const v = e.target.value
              patch('home_order', v === '' ? null : Number(v))
            }}
            placeholder="자동"
            className="w-20 text-sm"
          />
          <span className="text-xs text-gray-400">작은 숫자가 위로</span>
        </div>
        <p className="text-xs text-gray-400 ml-auto">
          저장하면 메인 / 에 즉시 반영됩니다 (발행됨 + 메인 노출 모두일 때).
        </p>
      </div>

      {/* 탭 */}
      <div className="bg-white border rounded-lg p-1 flex gap-1">
        {(['content', 'meta', 'faq', 'preview'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 px-3 py-2 text-sm font-medium rounded transition-colors ${
              tab === t ? 'bg-blue-600 text-white' : 'text-gray-700 hover:bg-gray-100'
            }`}
          >
            {t === 'content' ? '본문' : t === 'meta' ? 'SEO' : t === 'faq' ? 'FAQ' : '미리보기'}
          </button>
        ))}
      </div>

      {tab === 'content' && (
        <div className="grid lg:grid-cols-2 gap-4">
          <div className="bg-white border rounded-lg p-3">
            <p className="text-xs text-gray-500 mb-2">Markdown 본문</p>
            <textarea
              value={post.content}
              onChange={(e) => patch('content', e.target.value)}
              className="w-full h-[70vh] font-mono text-sm p-2 outline-none resize-none"
              placeholder={`# 제목\n\n## 소개\n\n본문을 마크다운으로 작성하세요...`}
            />
          </div>
          <div className="bg-white border rounded-lg p-4 overflow-auto h-[calc(70vh+2rem)]">
            <p className="text-xs text-gray-500 mb-2">실시간 미리보기</p>
            <MarkdownRender content={post.content} />
          </div>
        </div>
      )}

      {tab === 'meta' && (
        <div className="bg-white border rounded-lg p-5 space-y-4">
          <Field label="메타 설명 (description)" hint="검색 결과 스니펫에 표시 · 150자 이내 권장">
            <textarea
              rows={2}
              value={post.description ?? ''}
              onChange={(e) => patch('description', e.target.value)}
              className="w-full border rounded-md p-2 text-sm"
            />
          </Field>
          <Field label="커버 이미지" hint="OG 이미지 및 목록 카드 썸네일로 사용. AI 재생성 가능.">
            <CoverField
              slug={post.slug}
              coverUrl={post.cover_image_url}
              onChange={(url) => patch('cover_image_url', url)}
            />
          </Field>
          <Field label="태그" hint="쉼표로 구분">
            <Input
              value={post.tags.join(', ')}
              onChange={(e) => patch('tags', e.target.value.split(',').map((t) => t.trim()).filter(Boolean))}
            />
          </Field>
          <Field label="타겟 키워드" hint="SEO 추적용, 쉼표로 구분">
            <Input
              value={post.target_keywords.join(', ')}
              onChange={(e) =>
                patch('target_keywords', e.target.value.split(',').map((t) => t.trim()).filter(Boolean))
              }
            />
          </Field>
          <Field label="참고 URL (AI grounding 출처)" hint="AI 초안 생성 시 참조한 웹 문서">
            {post.source_urls.length === 0 ? (
              <span className="text-xs text-gray-400">없음</span>
            ) : (
              <ul className="text-xs space-y-1">
                {post.source_urls.map((u, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-gray-400">{i + 1}.</span>
                    <a href={u} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline break-all">
                      {u}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </Field>
        </div>
      )}

      {tab === 'faq' && (
        <div className="bg-white border rounded-lg p-5 space-y-3">
          <FaqRegenerateButton
            slug={post.slug}
            onReplace={(newFaq) => patch('faq', newFaq)}
          />
          {post.faq.map((item, i) => (
            <div key={i} className="border rounded-md p-3 space-y-2">
              <Input
                value={item.question}
                onChange={(e) => {
                  const next = [...post.faq]
                  next[i] = { ...item, question: e.target.value }
                  patch('faq', next)
                }}
                placeholder="질문"
              />
              <textarea
                rows={3}
                value={item.answer}
                onChange={(e) => {
                  const next = [...post.faq]
                  next[i] = { ...item, answer: e.target.value }
                  patch('faq', next)
                }}
                placeholder="답변"
                className="w-full border rounded-md p-2 text-sm"
              />
              <button
                onClick={() => {
                  if (!confirm(`Q&A "${item.question || '(제목 없음)'}" 를 삭제합니다. 저장 후엔 되돌릴 수 없습니다.`)) return
                  patch('faq', post.faq.filter((_, j) => j !== i))
                }}
                className="text-xs text-red-600 hover:underline"
              >
                삭제
              </button>
            </div>
          ))}
          <button
            onClick={() => patch('faq', [...post.faq, { question: '', answer: '' } as FaqItem])}
            className="text-sm text-blue-600 hover:underline"
          >
            + Q&A 추가
          </button>
        </div>
      )}

      {tab === 'preview' && (
        <div className="bg-white border rounded-lg p-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">{post.title}</h1>
          <p className="text-sm text-gray-500 mb-6">
            {post.category} · {post.author}
          </p>
          {post.cover_image_url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={post.cover_image_url} alt={post.title} className="w-full rounded-lg mb-6" />
          )}
          <MarkdownRender content={post.content} />
        </div>
      )}
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium text-gray-700">{label}</label>
      {hint && <p className="text-xs text-gray-500">{hint}</p>}
      {children}
    </div>
  )
}

function FaqRegenerateButton({
  slug,
  onReplace,
}: {
  slug: string
  onReplace: (faq: FaqItem[]) => void
}) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  async function handleClick() {
    if (
      !confirm(
        '본문 톤에 맞춰 FAQ 5개를 AI로 재생성합니다. 기존 FAQ는 교체되며 본문·제목 등 다른 필드는 절대 변경되지 않습니다. 계속할까요?',
      )
    )
      return
    setBusy(true)
    setMsg('AI가 본문을 분석해 FAQ 재생성 중… (20~40초)')
    try {
      const res = await fetch(`/api/admin/blog/${slug}/regenerate-faq`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? '재생성 실패')
      onReplace(data.faq)
      setMsg(`✅ FAQ 5개 재생성 완료. 검토 후 저장 버튼을 눌러 확정하세요.`)
    } catch (err) {
      setMsg(`❌ ${err instanceof Error ? err.message : '오류'}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bg-blue-50 border border-blue-100 rounded-md p-3 mb-2 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-blue-900 leading-relaxed">
          본문의 톤을 그대로 유지한 FAQ 5개를 AI가 재생성합니다.
          <br />
          본문·제목·태그·커버 등 다른 필드는 건드리지 않습니다.
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={handleClick}
          disabled={busy}
          className="whitespace-nowrap"
        >
          {busy ? '생성 중…' : '✨ AI 재생성'}
        </Button>
      </div>
      {msg && <p className="text-xs text-blue-900">{msg}</p>}
    </div>
  )
}

function CoverField({
  slug,
  coverUrl,
  onChange,
}: {
  slug: string
  coverUrl: string | null
  onChange: (url: string | null) => void
}) {
  const [busy, setBusy] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  async function regenerate() {
    setBusy(true)
    setMsg('AI로 커버 이미지 생성 중… (10~30초)')
    try {
      const res = await fetch(`/api/admin/blog/${slug}/generate-cover`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: prompt.trim() || undefined }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? '생성 실패')
      onChange(data.publicUrl)
      setMsg(`✅ 생성 완료 — ${data.modelUsed} · ${data.sizeKB}KB`)
    } catch (err) {
      setMsg(`❌ ${err instanceof Error ? err.message : '오류'}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      {coverUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={coverUrl} alt="커버" className="w-full max-w-md rounded border" />
      )}

      <Input
        value={coverUrl ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
        placeholder="https://... (URL 직접 입력 가능)"
      />

      <div className="border rounded-md p-3 bg-gray-50 space-y-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="text-xs text-blue-600 hover:underline"
          >
            {open ? '커스텀 프롬프트 닫기' : '커스텀 프롬프트 입력 (선택)'}
          </button>
          <Button
            size="sm"
            variant="outline"
            onClick={regenerate}
            disabled={busy}
            className="text-xs"
          >
            {busy ? '생성 중…' : '✨ AI 커버 재생성'}
          </Button>
        </div>
        {open && (
          <textarea
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="비워두면 블로그 제목 기반 기본 스타일로 생성. 영어 권장."
            className="w-full border rounded-md p-2 text-xs font-mono"
          />
        )}
        {msg && <p className="text-xs text-gray-600">{msg}</p>}
      </div>
    </div>
  )
}

function MarkdownRender({ content }: { content: string }) {
  const cleaned = stripLeadingH1(content)
  return (
    <div className="prose prose-sm max-w-none prose-headings:text-gray-900 prose-a:text-blue-600 prose-a:no-underline hover:prose-a:underline">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: (props) => <h2 {...props} />,
        }}
      >
        {cleaned || '_본문이 비어 있습니다._'}
      </ReactMarkdown>
    </div>
  )
}
