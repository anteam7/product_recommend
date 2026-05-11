'use client'

import { useState, useTransition } from 'react'
import type { ForwarderReview, ReviewTone } from '@/types'
import { addManualReview, toggleReviewHidden } from './actions'

type EnrichedReview = ForwarderReview & {
  forwarderName: string
  forwarderSlug: string | null
  countryLabel: string
}

interface Props {
  reviews: EnrichedReview[]
  forwarders: { id: string; name: string; slug: string }[]
}

const TONE_COLOR: Record<ReviewTone, string> = {
  긍정: 'bg-green-50 text-green-700',
  중립: 'bg-gray-100 text-gray-700',
  부정: 'bg-red-50 text-red-700',
  혼재: 'bg-amber-50 text-amber-700',
}

export default function ForwarderReviewsClient({ reviews, forwarders }: Props) {
  const [isPending, startTransition] = useTransition()
  const [showAddForm, setShowAddForm] = useState(false)

  // 신규 등록 폼 상태
  const [form, setForm] = useState({
    forwarderId: '',
    country: 'US' as 'US' | 'JP' | 'CN',
    reviewDate: '',
    url: '',
    platform: '',
    summary: '',
    tone: '긍정' as ReviewTone,
    keywords: '',
  })

  const handleToggleHidden = (review: EnrichedReview) => {
    if (isPending) return
    const next = !review.is_hidden
    startTransition(async () => {
      const res = await toggleReviewHidden({
        reviewId: review.id,
        isHidden: next,
        forwarderSlug: review.forwarderSlug,
      })
      if (!res.ok) alert(`실패: ${res.error}`)
    })
  }

  const handleAdd = () => {
    if (!form.forwarderId) {
      alert('배대지를 선택하세요')
      return
    }
    if (!form.summary.trim()) {
      alert('후기 요약을 입력하세요')
      return
    }
    const fwd = forwarders.find((f) => f.id === form.forwarderId)
    const keywords = form.keywords
      .split(/[,\s]+/)
      .map((k) => k.trim())
      .filter(Boolean)
    startTransition(async () => {
      const res = await addManualReview({
        forwarderId: form.forwarderId,
        country: form.country,
        forwarderSlug: fwd?.slug ?? null,
        reviewDate: form.reviewDate || null,
        url: form.url.trim() || null,
        platform: form.platform.trim() || null,
        summary: form.summary.trim(),
        tone: form.tone,
        keywords,
      })
      if (!res.ok) {
        alert(`실패: ${res.error}`)
        return
      }
      setShowAddForm(false)
      setForm({
        forwarderId: '',
        country: 'US',
        reviewDate: '',
        url: '',
        platform: '',
        summary: '',
        tone: '긍정',
        keywords: '',
      })
    })
  }

  return (
    <>
      {/* 수동 추가 트리거 */}
      <div className="flex items-center justify-between mb-3">
        <p className="text-sm text-gray-500">총 {reviews.length}개 후기</p>
        <button
          type="button"
          onClick={() => setShowAddForm(!showAddForm)}
          className="text-sm bg-gray-900 text-white px-3 py-1.5 rounded hover:bg-gray-700"
        >
          {showAddForm ? '취소' : '＋ 후기 직접 추가'}
        </button>
      </div>

      {/* 수동 추가 폼 */}
      {showAddForm && (
        <div className="border-2 border-blue-200 rounded-lg p-4 bg-blue-50/30 mb-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
            <div>
              <label className="text-xs text-gray-500 block mb-1">배대지 *</label>
              <select
                value={form.forwarderId}
                onChange={(e) => setForm({ ...form, forwarderId: e.target.value })}
                className="w-full border rounded px-2 py-1.5 text-sm"
              >
                <option value="">선택</option>
                {forwarders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">국가 *</label>
              <select
                value={form.country}
                onChange={(e) =>
                  setForm({ ...form, country: e.target.value as 'US' | 'JP' | 'CN' })
                }
                className="w-full border rounded px-2 py-1.5 text-sm"
              >
                <option value="US">미국</option>
                <option value="JP">일본</option>
                <option value="CN">중국</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">날짜 (YYYY-MM)</label>
              <input
                type="text"
                placeholder="2026-04"
                value={form.reviewDate}
                onChange={(e) => setForm({ ...form, reviewDate: e.target.value })}
                className="w-full border rounded px-2 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">Tone</label>
              <select
                value={form.tone}
                onChange={(e) => setForm({ ...form, tone: e.target.value as ReviewTone })}
                className="w-full border rounded px-2 py-1.5 text-sm"
              >
                <option value="긍정">긍정</option>
                <option value="중립">중립</option>
                <option value="부정">부정</option>
                <option value="혼재">혼재</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">플랫폼</label>
              <input
                type="text"
                placeholder="티스토리 블로그"
                value={form.platform}
                onChange={(e) => setForm({ ...form, platform: e.target.value })}
                className="w-full border rounded px-2 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">URL</label>
              <input
                type="text"
                placeholder="https://..."
                value={form.url}
                onChange={(e) => setForm({ ...form, url: e.target.value })}
                className="w-full border rounded px-2 py-1.5 text-sm"
              />
            </div>
          </div>
          <div className="mb-3">
            <label className="text-xs text-gray-500 block mb-1">요약 *</label>
            <textarea
              value={form.summary}
              onChange={(e) => setForm({ ...form, summary: e.target.value })}
              className="w-full border rounded px-2 py-1.5 text-sm"
              rows={3}
              placeholder="후기 핵심 내용 한두 줄"
            />
          </div>
          <div className="mb-3">
            <label className="text-xs text-gray-500 block mb-1">키워드 (쉼표/공백 구분)</label>
            <input
              type="text"
              value={form.keywords}
              onChange={(e) => setForm({ ...form, keywords: e.target.value })}
              className="w-full border rounded px-2 py-1.5 text-sm"
              placeholder="배송속도, 포장, 가격"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowAddForm(false)}
              className="text-sm px-3 py-1.5 rounded border hover:bg-gray-50"
            >
              취소
            </button>
            <button
              type="button"
              onClick={handleAdd}
              disabled={isPending}
              className="text-sm bg-blue-600 text-white px-3 py-1.5 rounded hover:bg-blue-700 disabled:opacity-50"
            >
              {isPending ? '저장 중...' : '저장'}
            </button>
          </div>
        </div>
      )}

      {/* 후기 테이블 */}
      <div className="bg-white border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              <th className="text-left px-3 py-2 font-semibold text-gray-700">배대지·국가</th>
              <th className="text-left px-3 py-2 font-semibold text-gray-700">Tone·날짜</th>
              <th className="text-left px-3 py-2 font-semibold text-gray-700 w-2/5">요약</th>
              <th className="text-left px-3 py-2 font-semibold text-gray-700">출처</th>
              <th className="text-center px-3 py-2 font-semibold text-gray-700">상태</th>
            </tr>
          </thead>
          <tbody>
            {reviews.length === 0 ? (
              <tr>
                <td colSpan={5} className="text-center py-8 text-gray-400 text-sm">
                  조건에 맞는 후기가 없습니다.
                </td>
              </tr>
            ) : (
              reviews.map((r) => (
                <tr
                  key={r.id}
                  className={`border-b last:border-0 ${r.is_hidden ? 'bg-gray-50 opacity-70' : 'hover:bg-gray-50/50'}`}
                >
                  <td className="px-3 py-2 align-top">
                    <p className="font-medium text-gray-900">{r.forwarderName}</p>
                    <p className="text-xs text-gray-500">{r.countryLabel}</p>
                  </td>
                  <td className="px-3 py-2 align-top">
                    <span
                      className={`inline-block text-[11px] font-medium px-1.5 py-0.5 rounded ${TONE_COLOR[r.tone]}`}
                    >
                      {r.tone}
                    </span>
                    <p className="text-xs text-gray-500 mt-1">{r.review_date ?? '—'}</p>
                  </td>
                  <td className="px-3 py-2 align-top">
                    <p className="text-gray-800 leading-relaxed">{r.summary}</p>
                    {r.keywords.length > 0 && (
                      <p className="text-[11px] text-gray-400 mt-1">
                        {r.keywords.map((k) => `#${k}`).join(' ')}
                      </p>
                    )}
                  </td>
                  <td className="px-3 py-2 align-top text-xs">
                    <p className="text-gray-600">{r.platform || '—'}</p>
                    {r.url && (
                      <a
                        href={r.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline break-all"
                      >
                        원문 ↗
                      </a>
                    )}
                    {r.source === 'manual' && (
                      <p className="text-[10px] text-blue-700 mt-0.5">수동 등록</p>
                    )}
                  </td>
                  <td className="px-3 py-2 align-top text-center">
                    <button
                      type="button"
                      onClick={() => handleToggleHidden(r)}
                      disabled={isPending}
                      className={`text-xs px-2 py-1 rounded border transition-colors disabled:opacity-50 ${
                        r.is_hidden
                          ? 'bg-amber-100 text-amber-800 border-amber-200 hover:bg-amber-200'
                          : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'
                      }`}
                    >
                      {r.is_hidden ? '숨김 (해제)' : '숨김 처리'}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  )
}
