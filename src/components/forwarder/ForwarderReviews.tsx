'use client'

import { useMemo, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import type {
  Country,
  ForwarderReview,
  ForwarderReviewSummary,
  ReviewTone,
} from '@/types'

interface CountrySection {
  country: Country
  summary: ForwarderReviewSummary | null
  reviews: ForwarderReview[]
}

interface Props {
  forwarderName: string
  forwarderWebsite: string | null
  forwarderOfficialReviewsUrl: string | null
  collectedAt: string | null
  byCountry: CountrySection[]
}

const TONE_STYLE: Record<ReviewTone, { bg: string; text: string; emoji: string; label: string }> = {
  긍정: { bg: 'bg-green-50', text: 'text-green-700', emoji: '🟢', label: '긍정' },
  중립: { bg: 'bg-gray-100', text: 'text-gray-700', emoji: '⚪️', label: '중립' },
  부정: { bg: 'bg-red-50', text: 'text-red-700', emoji: '🔴', label: '부정' },
  혼재: { bg: 'bg-amber-50', text: 'text-amber-700', emoji: '🟡', label: '혼재' },
}

const SENTIMENT_STYLE: Record<string, { bg: string; text: string; border: string; emoji: string; short: string }> = {
  '긍정 우세': { bg: 'bg-green-100', text: 'text-green-800', border: 'border-green-200', emoji: '🟢', short: '긍정' },
  '혼재': { bg: 'bg-amber-100', text: 'text-amber-800', border: 'border-amber-200', emoji: '🟡', short: '혼재' },
  '부정 우세': { bg: 'bg-red-100', text: 'text-red-800', border: 'border-red-200', emoji: '🔴', short: '부정' },
  '데이터 없음': { bg: 'bg-gray-100', text: 'text-gray-600', border: 'border-gray-200', emoji: '⚪️', short: '후기 부족' },
}

const COUNTRY_NAME: Record<Country, string> = { US: '미국', JP: '일본', CN: '중국' }
const COUNTRY_FLAG: Record<Country, string> = { US: '🇺🇸', JP: '🇯🇵', CN: '🇨🇳' }
const COUNTRY_ORDER: Country[] = ['US', 'JP', 'CN']

const INITIAL_VISIBLE = 3

function reviewYear(dateStr: string | null): number | null {
  if (!dateStr) return null
  const m = dateStr.match(/^(\d{4})/)
  return m ? Number(m[1]) : null
}

function isStaleNegative(review: ForwarderReview): boolean {
  if (review.tone !== '부정') return false
  const y = reviewYear(review.review_date)
  if (!y) return false
  const currentYear = new Date().getFullYear()
  return currentYear - y >= 2
}

export default function ForwarderReviews({
  forwarderName,
  forwarderWebsite,
  forwarderOfficialReviewsUrl,
  collectedAt,
  byCountry,
}: Props) {
  // 후기 또는 summary 가 있는 국가만 노출
  const sections = byCountry
    .filter((s) => s.summary || s.reviews.length > 0)
    .sort((a, b) => COUNTRY_ORDER.indexOf(a.country) - COUNTRY_ORDER.indexOf(b.country))

  if (sections.length === 0) return null

  const collectedDate = collectedAt ? collectedAt.split(' ')[0] : null
  const anyReviewsAcrossSections = sections.some((s) => s.reviews.length > 0)

  return (
    <Card className="mb-8 border-blue-100">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          사용자 후기
          <span className="text-xs font-normal text-gray-400">
            외부 블로그·커뮤니티 수집
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {sections.length === 1 ? (
          <CountryReviewBody
            section={sections[0]}
            forwarderName={forwarderName}
            forwarderWebsite={forwarderWebsite}
            forwarderOfficialReviewsUrl={forwarderOfficialReviewsUrl}
          />
        ) : (
          <Tabs defaultValue={sections[0].country}>
            <TabsList className="mb-4 h-auto flex-wrap gap-1">
              {sections.map((s) => {
                const sentiment = s.summary?.overall_sentiment || '데이터 없음'
                const style = SENTIMENT_STYLE[sentiment] || SENTIMENT_STYLE['데이터 없음']
                const count = s.reviews.length
                return (
                  <TabsTrigger key={s.country} value={s.country} className="text-sm">
                    <span className="mr-1.5">{COUNTRY_FLAG[s.country]}</span>
                    {COUNTRY_NAME[s.country]}
                    <span className="ml-1.5 text-xs text-gray-500">
                      {count > 0 ? `· ${count}건 ` : '· '}
                    </span>
                    <span className={`ml-0.5 text-[11px] ${style.text}`}>
                      {style.emoji} {style.short}
                    </span>
                  </TabsTrigger>
                )
              })}
            </TabsList>
            {sections.map((s) => (
              <TabsContent key={s.country} value={s.country}>
                <CountryReviewBody
                  section={s}
                  forwarderName={forwarderName}
                  forwarderWebsite={forwarderWebsite}
                  forwarderOfficialReviewsUrl={forwarderOfficialReviewsUrl}
                />
              </TabsContent>
            ))}
          </Tabs>
        )}

        {/* 외부 후기 일반적 편향 안내 — 한 카드에 한 번만 (탭 모두 적용) */}
        {anyReviewsAcrossSections && (
          <div className="mt-5 rounded-lg border border-amber-100 bg-amber-50/40 p-3 text-[12px] text-gray-700 leading-relaxed">
            <p className="font-medium text-amber-900 mb-1">📝 후기 해석 시 참고하세요</p>
            <p>
              외부 게시판에 글을 남기는 사용자는 부정적인 경험을 한 경우가 더 많은 편입니다.
              긍정적인 경험을 한 사용자는 따로 후기를 남기지 않는 경향이 있어,
              여기에 보이는 부정 후기 비율이 실제 만족도보다 높게 보일 수 있습니다.
            </p>
          </div>
        )}

        {/* 푸터: 출처 안내 (한 번만) */}
        <p className="text-[11px] text-gray-400 mt-4 leading-relaxed">
          짐스캐너가 외부 블로그·커뮤니티에서 수집·요약한 후기입니다
          {collectedDate && ` (${collectedDate} 기준)`}.
          배대지 자체 게시판 후기는 객관성을 위해 일부러 제외했습니다.
        </p>
      </CardContent>
    </Card>
  )
}

// ──────────────────────────────────────────────────────────────
// 국가 단위 본문 (단일 노출 또는 탭 컨텐츠로 사용)
// ──────────────────────────────────────────────────────────────
function CountryReviewBody({
  section,
  forwarderName,
  forwarderWebsite,
  forwarderOfficialReviewsUrl,
}: {
  section: CountrySection
  forwarderName: string
  forwarderWebsite: string | null
  forwarderOfficialReviewsUrl: string | null
}) {
  const { country, summary, reviews } = section
  const [toneFilter, setToneFilter] = useState<'all' | ReviewTone>('all')
  const [showAll, setShowAll] = useState(false)

  const countryName = COUNTRY_NAME[country] || country

  const topKeywords = useMemo(() => {
    const counts = new Map<string, number>()
    for (const r of reviews) {
      for (const k of r.keywords || []) counts.set(k, (counts.get(k) ?? 0) + 1)
    }
    return [...counts.entries()]
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([k]) => k)
  }, [reviews])

  const toneCounts = useMemo(() => {
    const c: Record<ReviewTone, number> = { 긍정: 0, 중립: 0, 부정: 0, 혼재: 0 }
    for (const r of reviews) c[r.tone] = (c[r.tone] ?? 0) + 1
    return c
  }, [reviews])

  const filtered = useMemo(() => {
    const list = toneFilter === 'all' ? reviews : reviews.filter((r) => r.tone === toneFilter)
    return [...list].sort((a, b) => {
      const ad = a.review_date ?? ''
      const bd = b.review_date ?? ''
      if (ad && bd) return bd.localeCompare(ad)
      if (ad) return -1
      if (bd) return 1
      return 0
    })
  }, [reviews, toneFilter])

  const visible = showAll ? filtered : filtered.slice(0, INITIAL_VISIBLE)

  const hasReviews = reviews.length > 0
  const sentiment = summary?.overall_sentiment || '데이터 없음'
  const sentimentStyle = SENTIMENT_STYLE[sentiment] || SENTIMENT_STYLE['데이터 없음']
  const hasPositiveExternal = reviews.some((r) => r.tone === '긍정')
  const officialReviewLink = forwarderOfficialReviewsUrl || forwarderWebsite
  const officialReviewLinkLabel = forwarderOfficialReviewsUrl ? '공식 후기 게시판' : '공식 사이트'
  const showOfficialReviewHint = hasReviews && !hasPositiveExternal && !!officialReviewLink

  return (
    <>
      {/* 국가별 sentiment 뱃지 + 카운트 */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <span
          className={`inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full border ${sentimentStyle.bg} ${sentimentStyle.text} ${sentimentStyle.border}`}
        >
          <span>{sentimentStyle.emoji}</span>
          {sentiment}
        </span>
        {hasReviews && (
          <span className="text-xs text-gray-500">
            외부 후기 <strong className="text-gray-800">{reviews.length}건</strong>
          </span>
        )}
      </div>

      {/* 한 줄 요약 */}
      {summary?.notable_issues && (
        <p className="text-sm text-gray-700 leading-relaxed mb-4">{summary.notable_issues}</p>
      )}

      {!hasReviews ? (
        <div className="text-sm text-gray-500 bg-gray-50 rounded-lg p-4 leading-relaxed">
          <p className="mb-1.5 font-medium text-gray-700">
            외부 블로그·커뮤니티에서 {forwarderName} {countryName} 배대지 후기를 찾기 어려웠습니다.
          </p>
          <p className="text-xs text-gray-500">
            ※ 짐스캐너는 객관성을 위해 배대지 자체 게시판의 후기는 일부러 수집하지 않습니다.
            {summary?.data_availability_note && (
              <>
                <br />
                세부 사유: {summary.data_availability_note}
              </>
            )}
          </p>
        </div>
      ) : (
        <>
          {/* 자주 언급되는 키워드 */}
          {topKeywords.length > 0 && (
            <div className="mb-4">
              <p className="text-xs text-gray-500 mb-1.5">자주 언급되는 키워드</p>
              <div className="flex flex-wrap gap-1.5">
                {topKeywords.map((k) => (
                  <Badge key={k} variant="outline" className="text-xs font-normal">
                    {k}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* tone 필터 */}
          <div className="flex flex-wrap gap-1.5 mb-4 border-b border-gray-100 pb-3">
            <ToneFilterButton
              active={toneFilter === 'all'}
              onClick={() => {
                setToneFilter('all')
                setShowAll(false)
              }}
              label={`전체 ${reviews.length}`}
            />
            {(['긍정', '중립', '부정', '혼재'] as ReviewTone[]).map((t) => {
              const n = toneCounts[t]
              if (n === 0) return null
              return (
                <ToneFilterButton
                  key={t}
                  active={toneFilter === t}
                  onClick={() => {
                    setToneFilter(t)
                    setShowAll(false)
                  }}
                  label={`${TONE_STYLE[t].emoji} ${t} ${n}`}
                />
              )
            })}
          </div>

          {/* 후기 리스트 */}
          <ul className="space-y-3">
            {visible.map((r) => {
              const t = TONE_STYLE[r.tone]
              const stale = isStaleNegative(r)
              return (
                <li
                  key={r.id}
                  className={`rounded-lg border p-3 ${stale ? 'border-gray-100 bg-gray-50/50 opacity-80' : 'border-gray-100'}`}
                >
                  <div className="flex flex-wrap items-center gap-2 mb-1.5 text-xs">
                    <span
                      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded ${t.bg} ${t.text} font-medium`}
                    >
                      <span>{t.emoji}</span>
                      {t.label}
                    </span>
                    {r.review_date && (
                      <span className="text-gray-500">
                        {r.review_date}
                        {stale && (
                          <span className="ml-1 text-gray-400">
                            ({reviewYear(r.review_date)}년 후기)
                          </span>
                        )}
                      </span>
                    )}
                    {r.platform && <span className="text-gray-400">· {r.platform}</span>}
                  </div>
                  <p className="text-sm text-gray-800 leading-relaxed mb-2">{r.summary}</p>
                  {r.keywords.length > 0 && (
                    <div className="flex flex-wrap gap-1 mb-2">
                      {r.keywords.map((k) => (
                        <span key={k} className="text-[11px] text-gray-500">
                          #{k}
                        </span>
                      ))}
                    </div>
                  )}
                  {r.url && (
                    <a
                      href={r.url}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
                    >
                      원문 보기 <span className="text-[10px]">↗</span>
                    </a>
                  )}
                </li>
              )
            })}
          </ul>

          {filtered.length > INITIAL_VISIBLE && (
            <div className="mt-3 text-center">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowAll(!showAll)}
                className="text-blue-600 hover:text-blue-700"
              >
                {showAll ? '접기' : `더 보기 (${filtered.length - INITIAL_VISIBLE}건)`}
              </Button>
            </div>
          )}

          {/* 외부 긍정 후기 0건 안내 — 공식 사이트로 우회 */}
          {showOfficialReviewHint && officialReviewLink && (
            <div className="mt-4 rounded-lg border border-blue-100 bg-blue-50/50 p-3 text-[12px] text-gray-700 leading-relaxed">
              💡 외부 채널의 긍정 후기가 부족합니다. {forwarderName}{' '}
              {forwarderOfficialReviewsUrl
                ? '공식 후기 게시판에서'
                : '공식 사이트의 후기 게시판에서'}{' '}
              긍정 후기를 직접 확인할 수 있습니다.{' '}
              <a
                href={officialReviewLink}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="text-blue-700 font-medium hover:underline whitespace-nowrap"
              >
                {officialReviewLinkLabel} ↗
              </a>
            </div>
          )}
        </>
      )}
    </>
  )
}

function ToneFilterButton({
  active,
  onClick,
  label,
}: {
  active: boolean
  onClick: () => void
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
        active
          ? 'bg-blue-600 text-white border-blue-600'
          : 'bg-white text-gray-600 border-gray-200 hover:border-blue-300 hover:text-blue-600'
      }`}
    >
      {label}
    </button>
  )
}
