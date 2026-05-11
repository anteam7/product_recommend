import { Metadata } from 'next'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import {
  type SaleEvent,
  saleEventPhase,
  daysUntil,
  countryLabel,
  COMMON_COUNTRIES,
  parseMonthParam,
  formatMonthParam,
  compareLinkFor,
} from '@/lib/deals'
import CalendarView from './CalendarView'
import ReportButton from '@/components/reports/ReportButton'
import ResolutionBadge from '@/components/reports/ResolutionBadge'

const BASE_URL = 'https://jimscanner.co.kr'

export const metadata: Metadata = {
  title: '해외직구 세일 일정 2026 · 블랙프라이데이 · 광군제 · 프라임데이 | 짐스캐너',
  description:
    '아마존 프라임데이, 블랙프라이데이, 광군제, 라쿠텐 슈퍼세일 등 해외 쇼핑 세일 일정을 한눈에. 국가별 추천 배대지와 관세 주의사항까지.',
  alternates: { canonical: `${BASE_URL}/deals` },
  openGraph: {
    title: '해외직구 세일 캘린더 · 짐스캐너',
    description: '미국·일본·중국·유럽 주요 세일 일정과 배대지 추천.',
    url: `${BASE_URL}/deals`,
  },
}

export const revalidate = 600

type GroupKey = 'ongoing' | 'upcoming' | 'past' | 'undated'
const GROUP_LABEL: Record<GroupKey, { title: string; desc: string; color: string }> = {
  ongoing: {
    title: '🔥 진행 중',
    desc: '지금 바로 쇼핑 가능한 세일',
    color: 'bg-red-50 border-red-100',
  },
  upcoming: {
    title: '📅 예정',
    desc: '곧 시작하는 세일 · 미리 장바구니 준비',
    color: 'bg-blue-50 border-blue-100',
  },
  undated: {
    title: '📌 시기 미확정',
    desc: '매년 반복되지만 올해 날짜 미정',
    color: 'bg-gray-50 border-gray-100',
  },
  past: {
    title: '최근 종료',
    desc: '최근 끝난 세일 (참고용)',
    color: 'bg-gray-50 border-gray-100',
  },
}

type Search = { view?: string; month?: string }

export default async function DealsPage({
  searchParams,
}: {
  searchParams: Promise<Search>
}) {
  const sp = await searchParams
  const view = sp.view === 'calendar' ? 'calendar' : 'cards'
  const { year: calYear, month: calMonth } = parseMonthParam(sp.month)
  const currentMonthParam = formatMonthParam(calYear, calMonth)

  const { data } = await supabase
    .from('jimscanner_sale_events')
    .select('*')
    .eq('status', 'active')
    .order('priority', { ascending: false })
    .order('start_at', { ascending: true, nullsFirst: false })

  const events = (data ?? []) as SaleEvent[]
  const now = new Date()

  const grouped: Record<GroupKey, SaleEvent[]> = {
    ongoing: [],
    upcoming: [],
    undated: [],
    past: [],
  }
  for (const e of events) {
    const phase = saleEventPhase(e, now)
    if (phase === 'past') {
      // 끝난 지 14일 이상 지나면 숨김
      if (e.end_at) {
        const d = daysUntil(e.end_at, now)
        if (d < -14) continue
      }
    }
    grouped[phase].push(e)
  }

  const order: GroupKey[] = ['ongoing', 'upcoming', 'undated', 'past']

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: '해외직구 세일 일정',
    itemListElement: events.slice(0, 20).map((e, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      item: {
        '@type': 'Event',
        name: e.name,
        startDate: e.start_at ?? undefined,
        endDate: e.end_at ?? undefined,
        eventAttendanceMode: 'https://schema.org/OnlineEventAttendanceMode',
        eventStatus: 'https://schema.org/EventScheduled',
        location: {
          '@type': 'VirtualLocation',
          url: e.external_url ?? `${BASE_URL}/deals`,
        },
        description: e.description ?? undefined,
      },
    })),
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 space-y-8">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <header className="space-y-2">
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">
          해외직구 세일 일정
        </h1>
        <p className="text-sm text-gray-600">
          아마존 프라임데이·블랙프라이데이·광군제·라쿠텐 슈퍼세일 등 한국 직구족이 주시하는 해외 쇼핑 이벤트.
          국가별 추천 배대지와 관세·수수료 주의사항까지 한 페이지에서 확인하세요.
        </p>
        <div className="flex flex-wrap gap-1.5 text-xs pt-1">
          {COMMON_COUNTRIES.map((c) => (
            <span key={c.code} className="px-2 py-0.5 bg-white border rounded-full text-gray-600">
              {c.flag} {c.label}
            </span>
          ))}
        </div>

        {/* 뷰 토글 */}
        <div className="inline-flex rounded-lg border overflow-hidden text-sm mt-2">
          <Link
            href="/deals"
            className={`px-4 py-1.5 font-medium ${
              view === 'cards' ? 'bg-blue-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'
            }`}
          >
            카드
          </Link>
          <Link
            href={`/deals?view=calendar&month=${currentMonthParam}`}
            className={`px-4 py-1.5 font-medium border-l ${
              view === 'calendar' ? 'bg-blue-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50'
            }`}
          >
            달력
          </Link>
        </div>
      </header>

      {view === 'calendar' ? (
        <CalendarView events={events} year={calYear} month={calMonth} />
      ) : events.length === 0 ? (
        <div className="bg-white border rounded-lg p-10 text-center text-gray-500">
          아직 등록된 세일 이벤트가 없습니다.
        </div>
      ) : (
        order
          .filter((g) => grouped[g].length > 0)
          .map((g) => (
            <section key={g} className="space-y-3">
              <div className={`rounded-lg border px-4 py-3 ${GROUP_LABEL[g].color}`}>
                <h2 className="text-lg font-bold text-gray-900">{GROUP_LABEL[g].title}</h2>
                <p className="text-xs text-gray-600 mt-0.5">{GROUP_LABEL[g].desc}</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {grouped[g].map((e) => (
                  <DealCard key={e.id} event={e} now={now} phase={g} />
                ))}
              </div>
            </section>
          ))
      )}

      <div className="bg-blue-50 border border-blue-100 rounded-lg p-5 text-sm text-blue-900">
        <p className="font-semibold">💡 세일 기간엔 배대지 선택이 더 중요해집니다</p>
        <p className="mt-1 text-blue-800">
          세일 트래픽이 몰리면 배대지 센터의 입고·출고가 평소보다 늦어집니다. 미국 직구라면 오리건(무세)·뉴저지 센터,
          일본은 도쿄권, 중국은 이우·광저우 센터를 가진 배대지가 상대적으로 빠릅니다.{' '}
          <Link href="/compare" className="underline font-medium">
            지금 본인 무게로 배송비 비교 →
          </Link>
        </p>
      </div>
    </div>
  )
}

function DealCard({
  event,
  now,
  phase,
}: {
  event: SaleEvent
  now: Date
  phase: GroupKey
}) {
  const dayInfo =
    phase === 'upcoming' && event.start_at
      ? `D-${Math.max(0, daysUntil(event.start_at, now))}`
      : phase === 'ongoing' && event.end_at
        ? `종료까지 D-${Math.max(0, daysUntil(event.end_at, now))}`
        : phase === 'past' && event.end_at
          ? `${Math.abs(daysUntil(event.end_at, now))}일 전 종료`
          : null

  return (
    <article className="bg-white border rounded-lg p-4 space-y-2 hover:border-blue-300 transition">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-semibold text-gray-900 truncate">{event.name}</h3>
          <div className="text-xs text-gray-500 mt-0.5">
            {countryLabel(event.country)}
            {event.start_at && (
              <span className="ml-2">
                {event.start_at}
                {event.end_at && event.end_at !== event.start_at && ` ~ ${event.end_at}`}
              </span>
            )}
          </div>
        </div>
        {dayInfo && (
          <span
            className={`shrink-0 text-xs font-semibold px-2 py-0.5 rounded ${
              phase === 'ongoing'
                ? 'bg-red-100 text-red-700'
                : phase === 'upcoming'
                  ? 'bg-blue-100 text-blue-700'
                  : 'bg-gray-100 text-gray-500'
            }`}
          >
            {dayInfo}
          </span>
        )}
      </div>

      {event.description && (
        <p className="text-sm text-gray-700 leading-relaxed">{event.description}</p>
      )}

      {event.categories.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {event.categories.map((c, i) => (
            <span
              key={i}
              className="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600"
            >
              {c}
            </span>
          ))}
        </div>
      )}

      {(event.recommended_forwarders.length > 0 || event.related_blog_tags.length > 0) && (
        <div className="pt-1 border-t text-xs space-y-1">
          {event.recommended_forwarders.length > 0 && (
            <div>
              <span className="text-gray-500">추천 배대지: </span>
              {event.recommended_forwarders.slice(0, 4).map((slug, i) => (
                <span key={slug}>
                  {i > 0 && <span className="text-gray-400">, </span>}
                  <Link href={`/forwarders/${slug}`} className="text-blue-600 hover:underline">
                    {slug}
                  </Link>
                </span>
              ))}
            </div>
          )}
          {event.related_blog_tags.length > 0 && (
            <div>
              <span className="text-gray-500">관련 글: </span>
              {event.related_blog_tags.slice(0, 4).map((tag, i) => (
                <span key={tag}>
                  {i > 0 && <span className="text-gray-400">, </span>}
                  <Link
                    href={`/blog?tag=${encodeURIComponent(tag)}`}
                    className="text-blue-600 hover:underline"
                  >
                    #{tag}
                  </Link>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        {(() => {
          const cl = compareLinkFor(event.country)
          return (
            <Link
              href={cl.href}
              className="text-xs text-blue-600 hover:underline font-medium"
            >
              {cl.label}
            </Link>
          )
        })()}
        {event.external_url && (
          <a
            href={event.external_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-gray-500 hover:underline ml-auto"
          >
            공식 페이지 ↗
          </a>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 pt-1 border-t">
        <ResolutionBadge targetType="deal" targetId={event.id} />
        <ReportButton
          mode="inline"
          targetType="deal"
          targetId={event.id}
          label="오류 신고"
          className="inline-flex items-center gap-1 text-[11px] text-gray-400 hover:text-red-600 transition-colors ml-auto"
        />
      </div>
    </article>
  )
}
