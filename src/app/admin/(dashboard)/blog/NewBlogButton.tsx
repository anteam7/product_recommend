'use client'

import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { BLOG_CATEGORIES, type BlogCategory } from '@/lib/blog'

type Suggestion = {
  keyword: string
  category: BlogCategory
  angle: string
  reason: string
}

type SuggestResponse = {
  distribution: Record<BlogCategory, number>
  totalPublished: number
  recommendedCategory: BlogCategory
  suggestions: Suggestion[]
  model: string
  groundingUrls: string[]
}

export default function NewBlogButton() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [category, setCategory] = useState<BlogCategory>('가이드')
  const [angle, setAngle] = useState('')
  const [error, setError] = useState<string | null>(null)

  // 시장 시그널 페이지의 추천 카드에서 query 로 들어오면 자동으로 다이얼로그 열고 값 채움
  useEffect(() => {
    const k = searchParams.get('suggest_keyword')
    if (!k) return
    const c = searchParams.get('suggest_category')
    const a = searchParams.get('suggest_angle')
    setKeyword(k)
    if (c && (BLOG_CATEGORIES as readonly string[]).includes(c)) {
      setCategory(c as BlogCategory)
    }
    if (a) setAngle(a)
    setOpen(true)
    // URL 정리 — 새로고침해도 다이얼로그가 또 안 뜨게
    router.replace('/admin/blog')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [suggesting, setSuggesting] = useState(false)
  const [suggestError, setSuggestError] = useState<string | null>(null)
  const [suggestData, setSuggestData] = useState<SuggestResponse | null>(null)
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null)

  async function fetchSuggestions() {
    setSuggesting(true)
    setSuggestError(null)
    try {
      const res = await fetch('/api/admin/blog/suggest-keywords', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? '추천 실패')
      setSuggestData(data as SuggestResponse)
      setSelectedIdx(null)
    } catch (err) {
      setSuggestError(err instanceof Error ? err.message : '오류')
    } finally {
      setSuggesting(false)
    }
  }

  function pickSuggestion(idx: number) {
    if (!suggestData) return
    const s = suggestData.suggestions[idx]
    if (!s) return
    setKeyword(s.keyword)
    setCategory(s.category)
    setAngle(s.angle)
    setSelectedIdx(idx)
  }

  async function generate() {
    if (!keyword.trim()) {
      setError('타겟 키워드를 입력하세요.')
      return
    }
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/blog/generate-draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyword: keyword.trim(), category, angle: angle.trim() || null }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? '생성 실패')
      router.push(`/admin/blog/${data.post.slug}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : '오류')
      setLoading(false)
    }
  }

  async function createBlank() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/blog/generate-draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blank: true, category }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? '생성 실패')
      router.push(`/admin/blog/${data.post.slug}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : '오류')
      setLoading(false)
    }
  }

  function resetAndClose() {
    setOpen(false)
    setKeyword('')
    setAngle('')
    setCategory('가이드')
    setError(null)
    setSuggestData(null)
    setSuggestError(null)
    setSelectedIdx(null)
  }

  return (
    <>
      <Button onClick={() => setOpen(true)} className="bg-blue-600 hover:bg-blue-700">
        새 글 작성
      </Button>

      {open && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-lg w-full max-w-2xl p-6 space-y-4 my-8">
            <div>
              <h2 className="text-lg font-bold text-gray-900">새 블로그 글 작성</h2>
              <p className="text-sm text-gray-500 mt-1">
                AI 초안은 Gemini가 웹검색(Google Search Grounding)과 짐스캐너 DB를 결합해 생성합니다.
              </p>
            </div>

            {/* 키워드 추천 블록 */}
            <div className="border border-indigo-100 bg-indigo-50/40 rounded-md p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold text-indigo-900">🎯 타겟 키워드 추천</div>
                  <div className="text-xs text-indigo-700/80">
                    기존 카테고리 분포 + 현재 시즌·트렌드를 반영해 Gemini가 5개를 제안합니다.
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={fetchSuggestions}
                  disabled={suggesting || loading}
                  className="shrink-0 border-indigo-300 text-indigo-700 hover:bg-indigo-100"
                >
                  {suggesting ? '추천 중… (15~30초)' : suggestData ? '다시 추천' : '추천받기'}
                </Button>
              </div>

              {suggestError && (
                <div className="text-xs text-red-700 bg-red-50 border border-red-100 rounded px-2 py-1.5">
                  {suggestError}
                </div>
              )}

              {suggestData && (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-gray-600">
                    <span className="font-medium text-gray-700">
                      게시 {suggestData.totalPublished}편 분포:
                    </span>
                    {BLOG_CATEGORIES.map((c) => {
                      const n = suggestData.distribution[c] ?? 0
                      const isRec = c === suggestData.recommendedCategory
                      return (
                        <span
                          key={c}
                          className={
                            isRec
                              ? 'px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-medium'
                              : 'px-1.5 py-0.5 rounded bg-white border text-gray-600'
                          }
                          title={isRec ? '부족한 카테고리 (우선 보강)' : undefined}
                        >
                          {c} {n}
                          {isRec && ' ⬆'}
                        </span>
                      )
                    })}
                  </div>

                  <ul className="space-y-1.5">
                    {suggestData.suggestions.map((s, i) => {
                      const active = selectedIdx === i
                      return (
                        <li key={i}>
                          <button
                            type="button"
                            onClick={() => pickSuggestion(i)}
                            disabled={loading}
                            className={`w-full text-left rounded-md border px-3 py-2 transition ${
                              active
                                ? 'border-blue-500 bg-blue-50 ring-1 ring-blue-400'
                                : 'border-gray-200 bg-white hover:border-indigo-300 hover:bg-indigo-50/60'
                            }`}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="font-medium text-sm text-gray-900">{s.keyword}</div>
                              <span className="shrink-0 text-[10px] bg-gray-100 text-gray-700 px-1.5 py-0.5 rounded">
                                {s.category}
                              </span>
                            </div>
                            {s.angle && (
                              <div className="text-xs text-gray-700 mt-0.5">앵글: {s.angle}</div>
                            )}
                            {s.reason && (
                              <div className="text-[11px] text-gray-500 mt-0.5">💡 {s.reason}</div>
                            )}
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-gray-700">타겟 키워드 *</label>
              <Input
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="예: 미국 배대지 추천 2026"
                disabled={loading}
              />
              <p className="text-xs text-gray-500">
                SEO 상 노리는 키워드. Gemini가 이 키워드 중심으로 글을 구성합니다.
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-gray-700">앵글 (선택)</label>
              <Input
                value={angle}
                onChange={(e) => setAngle(e.target.value)}
                placeholder="예: 초보자 관점, 최저가 비교, 오리건 센터 중심 등"
                disabled={loading}
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-gray-700">카테고리</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as BlogCategory)}
                disabled={loading}
                className="w-full border rounded-md px-3 py-2 text-sm"
              >
                {BLOG_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>

            {error && (
              <div className="text-sm text-red-700 bg-red-50 border border-red-100 rounded-md px-3 py-2">
                {error}
              </div>
            )}

            <div className="flex justify-between gap-2 pt-2">
              <Button variant="outline" size="sm" onClick={createBlank} disabled={loading}>
                빈 글로 시작
              </Button>
              <div className="flex gap-2">
                <Button variant="outline" onClick={resetAndClose} disabled={loading}>
                  취소
                </Button>
                <Button onClick={generate} disabled={loading} className="bg-blue-600 hover:bg-blue-700">
                  {loading ? '생성 중… (30~60초)' : '✨ AI 초안 생성'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
