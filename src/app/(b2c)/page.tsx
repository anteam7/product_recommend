import type { Metadata } from 'next'
import Image from 'next/image'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import {
  type BlogPost,
  countWords,
  estimateReadingMinutes,
  formatPublishedDate,
} from '@/lib/blog'
import {
  type SaleEvent,
  saleEventPhase,
  daysUntil,
  countryLabel,
} from '@/lib/deals'
import HomeHeroLogo from '@/components/home/HomeHeroLogo'
import HomeHeroEntry from '@/components/home/HomeHeroEntry'
import HomeDealsCarousel, {
  type HomeDealItem,
} from '@/components/deals/HomeDealsCarousel'

const BASE_URL = 'https://jimscanner.co.kr'

export const metadata: Metadata = {
  title: { absolute: '짐스캐너 — 카테고리만 고르면 최저가 배대지가 보입니다' },
  description:
    '미국·일본·중국 30+ 배대지를 같은 조건으로 비교합니다. 카테고리만 고르면 무게가 자동 추정되고, 관·부가세까지 함께 계산됩니다.',
  alternates: { canonical: BASE_URL },
  openGraph: {
    title: '짐스캐너 — 카테고리만 고르면 최저가 배대지가 보입니다',
    description:
      '미국·일본·중국 30+ 배대지를 같은 조건으로 비교. 무게 자동 추정 + 관·부가세 계산까지.',
    url: BASE_URL,
  },
}

export const revalidate = 3600

type HomePostFields = Pick<
  BlogPost,
  | 'id'
  | 'slug'
  | 'title'
  | 'description'
  | 'category'
  | 'published_at'
  | 'content'
  | 'cover_image_url'
>

type HomeSection = {
  category: string
  active: boolean
  layout: 'hero4' | 'row3'
  display_order: number
}

async function getCuratedBlogPosts(): Promise<HomePostFields[]> {
  const curated = await supabase
    .from('jimscanner_blog_posts')
    .select('id, slug, title, description, category, published_at, content, cover_image_url')
    .eq('status', 'published')
    .eq('home_featured', true)
    .order('home_order', { ascending: true, nullsFirst: false })
    .order('published_at', { ascending: false })
    .limit(30)

  if (!curated.error && curated.data && curated.data.length > 0) {
    return curated.data as HomePostFields[]
  }

  const fallback = await supabase
    .from('jimscanner_blog_posts')
    .select('id, slug, title, description, category, published_at, content, cover_image_url')
    .eq('status', 'published')
    .order('published_at', { ascending: false })
    .limit(30)

  return (fallback.data ?? []) as HomePostFields[]
}

async function getHomeSections(): Promise<HomeSection[]> {
  const res = await supabase
    .from('jimscanner_blog_home_sections')
    .select('category, active, layout, display_order')
    .eq('active', true)
    .order('display_order', { ascending: true })

  if (res.error || !res.data) return []
  return res.data as HomeSection[]
}

async function getHeroBlogPicks(): Promise<HomePostFields[]> {
  const picks = await supabase
    .from('jimscanner_home_hero_blog_picks')
    .select('position, blog_slug')
    .order('position', { ascending: true })

  if (picks.error || !picks.data) return []

  const slugs = (picks.data as { position: number; blog_slug: string | null }[])
    .map((p) => p.blog_slug)
    .filter((s): s is string => !!s)

  if (slugs.length === 0) return []

  const posts = await supabase
    .from('jimscanner_blog_posts')
    .select('id, slug, title, description, category, published_at, content, cover_image_url')
    .eq('status', 'published')
    .in('slug', slugs)

  if (posts.error || !posts.data) return []

  const bySlug = new Map<string, HomePostFields>()
  for (const p of posts.data as HomePostFields[]) bySlug.set(p.slug, p)

  return slugs
    .map((s) => bySlug.get(s))
    .filter((p): p is HomePostFields => !!p)
}

type HomeExchangeRate = {
  currency: 'USD' | 'JPY' | 'CNY' | 'EUR'
  flag: string
  label: string
  unit: string
  scale: number
  current: number
  prev: number | null
  history: number[]
}

const EXCHANGE_META: Record<
  HomeExchangeRate['currency'],
  Pick<HomeExchangeRate, 'flag' | 'label' | 'unit' | 'scale'>
> = {
  USD: { flag: '🇺🇸', label: '미국 달러', unit: '1 USD', scale: 1 },
  JPY: { flag: '🇯🇵', label: '일본 엔', unit: '100 JPY', scale: 100 },
  CNY: { flag: '🇨🇳', label: '중국 위안', unit: '1 CNY', scale: 1 },
  EUR: { flag: '🇪🇺', label: '유로', unit: '1 EUR', scale: 1 },
}

async function getHomeExchangeRates(): Promise<{
  rates: HomeExchangeRate[]
  updatedAt: string | null
}> {
  const { data } = await supabase
    .from('jimscanner_exchange_rate_history')
    .select('currency, rate_krw, rate_date')
    .in('currency', ['USD', 'JPY', 'CNY', 'EUR'])
    .order('rate_date', { ascending: false })
    .limit(120)

  const HISTORY_LEN = 14
  const byCur: Record<HomeExchangeRate['currency'], { rate_krw: number; rate_date: string }[]> = {
    USD: [],
    JPY: [],
    CNY: [],
    EUR: [],
  }
  for (const row of (data ?? []) as { currency: string; rate_krw: number; rate_date: string }[]) {
    const c = row.currency as HomeExchangeRate['currency']
    if (byCur[c] && byCur[c].length < HISTORY_LEN) byCur[c].push(row)
  }

  const rates: HomeExchangeRate[] = (['USD', 'JPY', 'CNY', 'EUR'] as const)
    .map((c) => {
      const arr = byCur[c]
      const current = arr[0]?.rate_krw ?? 0
      const history = arr.map((r) => r.rate_krw).reverse()
      return {
        currency: c,
        ...EXCHANGE_META[c],
        current,
        prev: arr[1]?.rate_krw ?? null,
        history,
      }
    })
    .filter((r) => r.current > 0)

  let updatedAt: string | null = null
  for (const arr of Object.values(byCur)) {
    const d = arr[0]?.rate_date
    if (d && (!updatedAt || d > updatedAt)) updatedAt = d
  }
  return { rates, updatedAt }
}

function formatExchangeDate(iso: string): string {
  const [y, m, d] = iso.split('-')
  return `${y}.${m}.${d}`
}

function buildSparklinePoints(values: number[], width: number, height: number, padding = 2): string {
  if (values.length < 2) return ''
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const stepX = (width - padding * 2) / (values.length - 1)
  return values
    .map((v, i) => {
      const x = padding + i * stepX
      const y = height - padding - ((v - min) / range) * (height - padding * 2)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}

type HomeReviewedForwarder = {
  forwarder_id: string
  forwarder_name: string
  forwarder_slug: string
  country: 'US' | 'JP' | 'CN'
  review_count: number
  overall_sentiment: '긍정 우세' | '혼재' | '부정 우세' | '데이터 없음'
  notable_issues: string | null
}

type HomeReviewMetrics = {
  externalReviewCount: number
  forwarderCount: number
  positiveForwarderCount: number
}

async function getReviewMetrics(): Promise<HomeReviewMetrics> {
  const { data } = await (
    supabase as unknown as { from: (t: string) => ReturnType<typeof supabase.from> }
  )
    .from('jimscanner_forwarder_review_summary')
    .select('forwarder_id, review_count, overall_sentiment')

  const rows = (data ?? []) as unknown as Array<{
    forwarder_id: string
    review_count: number
    overall_sentiment: string | null
  }>
  let externalReviewCount = 0
  const forwarderIds = new Set<string>()
  let positiveForwarderCount = 0
  for (const r of rows) {
    externalReviewCount += r.review_count ?? 0
    forwarderIds.add(r.forwarder_id)
    if (r.overall_sentiment === '긍정 우세') positiveForwarderCount++
  }
  return {
    externalReviewCount,
    forwarderCount: forwarderIds.size,
    positiveForwarderCount,
  }
}

async function getTopReviewedForwarders(): Promise<HomeReviewedForwarder[]> {
  const { data } = await (
    supabase as unknown as { from: (t: string) => ReturnType<typeof supabase.from> }
  )
    .from('jimscanner_forwarder_review_summary')
    .select('forwarder_id, country, review_count, overall_sentiment, notable_issues')

  const rows = (data ?? []) as unknown as Array<{
    forwarder_id: string
    country: 'US' | 'JP' | 'CN'
    review_count: number
    overall_sentiment: HomeReviewedForwarder['overall_sentiment']
    notable_issues: string | null
  }>

  // 외부 후기 ≥3 + 긍정 우세 만 후보
  const candidates = rows.filter(
    (r) => r.review_count >= 3 && r.overall_sentiment === '긍정 우세',
  )

  // 배대지 이름 join
  const ids = [...new Set(candidates.map((r) => r.forwarder_id))]
  if (ids.length === 0) return []
  const { data: fwds } = await supabase
    .from('forwarders')
    .select('id, name, slug')
    .in('id', ids)
    .eq('is_active', true)
  const fwdMap = new Map<string, { name: string; slug: string }>()
  for (const f of (fwds ?? []) as { id: string; name: string; slug: string }[]) {
    fwdMap.set(f.id, { name: f.name, slug: f.slug })
  }

  // 후기 많은 순 정렬, 국가별 최대 2개씩 균등 분배 (총 6개)
  const sorted = [...candidates].sort((a, b) => b.review_count - a.review_count)
  const perCountry: Record<'US' | 'JP' | 'CN', number> = { US: 0, JP: 0, CN: 0 }
  const result: HomeReviewedForwarder[] = []
  for (const r of sorted) {
    const fwd = fwdMap.get(r.forwarder_id)
    if (!fwd) continue
    if (perCountry[r.country] >= 2) continue
    perCountry[r.country]++
    result.push({
      forwarder_id: r.forwarder_id,
      forwarder_name: fwd.name,
      forwarder_slug: fwd.slug,
      country: r.country,
      review_count: r.review_count,
      overall_sentiment: r.overall_sentiment,
      notable_issues: r.notable_issues,
    })
    if (result.length >= 6) break
  }
  return result
}

type CountrySamplePrices = {
  US: { kg1: number | null; kg5: number | null }
  JP: { kg1: number | null; kg5: number | null }
  CN: { kg1: number | null; kg5: number | null }
}

async function getCountrySampleRates(): Promise<CountrySamplePrices> {
  const { getCurrentRates, computeKrw } = await import('@/lib/current-rates')
  const [{ data }, currentRates] = await Promise.all([
    supabase
      .from('shipping_rates')
      .select('country, weight_min, weight_max, price_krw, price_usd, price_jpy, price_cny')
      .in('country', ['US', 'JP', 'CN'])
      .eq('grade_level', 1),
    getCurrentRates(),
  ])

  const computeMin = (country: 'US' | 'JP' | 'CN', kg: number) => {
    const candidates = (data ?? []).filter(
      (r) => r.country === country && r.weight_min <= kg && r.weight_max >= kg,
    )
    const prices = candidates
      .map((r) => computeKrw(r, currentRates))
      .filter((p): p is number => p !== null && p > 0)
    return prices.length > 0 ? Math.min(...prices) : null
  }

  return {
    US: { kg1: computeMin('US', 1), kg5: computeMin('US', 5) },
    JP: { kg1: computeMin('JP', 1), kg5: computeMin('JP', 5) },
    CN: { kg1: computeMin('CN', 1), kg5: computeMin('CN', 5) },
  }
}

async function getDealItems(): Promise<HomeDealItem[]> {
  const { data } = await supabase
    .from('jimscanner_sale_events')
    .select('*')
    .eq('status', 'active')
    .order('priority', { ascending: false })
    .order('start_at', { ascending: true, nullsFirst: false })
    .limit(20)

  const events = (data ?? []) as SaleEvent[]
  const now = new Date()

  const ongoing = events.filter((e) => saleEventPhase(e, now) === 'ongoing')
  const upcomingSoon = events
    .filter((e) => {
      if (saleEventPhase(e, now) !== 'upcoming') return false
      if (!e.start_at) return false
      const d = daysUntil(e.start_at, now)
      return d >= 0 && d <= 30
    })
    .sort((a, b) => daysUntil(a.start_at!, now) - daysUntil(b.start_at!, now))

  const merged: SaleEvent[] = [...ongoing, ...upcomingSoon].slice(0, 5)

  return merged.map((e) => {
    const isOngoing = saleEventPhase(e, now) === 'ongoing'
    const daysLabel = isOngoing
      ? e.end_at
        ? `종료까지 D-${Math.max(0, daysUntil(e.end_at, now))}`
        : '진행 중'
      : e.start_at
        ? `D-${Math.max(0, daysUntil(e.start_at, now))} 시작`
        : '예정'

    return {
      id: e.id,
      name: e.name,
      country: e.country,
      countryLabel: countryLabel(e.country),
      phase: isOngoing ? 'ongoing' : 'upcoming',
      badge: isOngoing ? '진행 중' : '예정',
      daysLabel,
      href: '/deals',
      description: e.description,
    }
  })
}

const FEATURE_CARDS = [
  {
    num: '01',
    title: '무게 자동 추정',
    body: '카테고리·브랜드만 고르면 실제 통관 데이터로 무게를 추정합니다.',
  },
  {
    num: '02',
    title: '관·부가세 자동 계산',
    body: '의류 13%, 화장품 8% 등 카테고리별 간이세율과 부가세 10%까지.',
  },
  {
    num: '03',
    title: '면세한도 검사',
    body: '한미 FTA $200, 일반 $150, 영양제 6병 한도까지 자동 적용.',
  },
]

type Tone = 'blue' | 'black'

const TONES: Record<
  Tone,
  {
    accentSky: string
    accentAmber: string
    accentEmerald: string
    heroNum: string
    ctaBg: string
    ctaHover: string
    cardCategory: string
  }
> = {
  // 기본 톤 — 페르소나 평가 결과 블루 우세 +13 (2026-05-02). 모든 강조 = blue-700/600 통일 (브랜드 일관). supertitle 색 분산 (sky/amber/emerald) 폐기.
  blue: {
    accentSky: 'text-blue-700',
    accentAmber: 'text-blue-700',
    accentEmerald: 'text-blue-700',
    heroNum: 'text-blue-700',
    ctaBg: 'bg-blue-600',
    ctaHover: 'hover:bg-blue-700',
    cardCategory: 'text-blue-700',
  },
  black: {
    accentSky: 'text-gray-900',
    accentAmber: 'text-gray-900',
    accentEmerald: 'text-gray-900',
    heroNum: 'text-gray-950',
    ctaBg: 'bg-black',
    ctaHover: 'hover:bg-gray-800',
    cardCategory: 'text-gray-700',
  },
}

function groupBySection(
  posts: HomePostFields[],
  sections: HomeSection[],
): { category: string; layout: 'hero4' | 'row3'; posts: HomePostFields[] }[] {
  const byCat = new Map<string, HomePostFields[]>()
  for (const p of posts) {
    if (!byCat.has(p.category)) byCat.set(p.category, [])
    byCat.get(p.category)!.push(p)
  }
  return sections
    .map((s) => {
      const list = byCat.get(s.category) ?? []
      return { category: s.category, layout: s.layout, posts: list }
    })
    .filter((g) => g.posts.length > 0)
}

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ tone?: string }>
}) {
  const { tone: toneParam } = await searchParams
  const tone: Tone = toneParam === 'black' ? 'black' : 'blue'
  const T = TONES[tone]

  const [blogPosts, dealItems, sections, heroPicks, exchange, reviewMetrics, topReviewedForwarders, countrySampleRates] = await Promise.all([
    getCuratedBlogPosts(),
    getDealItems(),
    getHomeSections(),
    getHeroBlogPicks(),
    getHomeExchangeRates(),
    getReviewMetrics(),
    getTopReviewedForwarders(),
    getCountrySampleRates(),
  ])
  const grouped = groupBySection(blogPosts, sections)
  const COUNTRY_FLAG: Record<'US' | 'JP' | 'CN', string> = { US: '🇺🇸', JP: '🇯🇵', CN: '🇨🇳' }
  const COUNTRY_NAME: Record<'US' | 'JP' | 'CN', string> = { US: '미국', JP: '일본', CN: '중국' }

  return (
    <div className="bg-white text-gray-900">
      {/* Section 1 — Hero: 짐스캐너 워드마크 + 운송수단 + 시뮬레이터 */}
      <section className="px-5 pb-12 pt-10 sm:px-8 sm:pb-16 sm:pt-14">
        <div className="mx-auto max-w-[1200px]">
          <HomeHeroLogo />
          <div className="mt-10">
            <HomeHeroEntry />
          </div>
        </div>
      </section>

      {/* Section 1a-1 — 시뮬레이터 안내 (품목별 관세 계산) */}
      <section className="border-t border-gray-100 px-5 py-14 sm:px-8 sm:py-16">
        <div className="mx-auto max-w-[1200px]">
          <header className="mx-auto mb-10 max-w-2xl text-center">
            <p className={`mb-3 text-[11px] font-semibold uppercase tracking-[0.16em] ${T.accentSky}`}>
              SIMULATOR
            </p>
            <h2 className="text-[28px] font-semibold leading-[1.18] tracking-tight text-gray-900 sm:text-[34px]">
              품목별 관세까지 한번에 계산하기
            </h2>
          </header>
          <ul className="mx-auto grid max-w-[1000px] gap-4 sm:grid-cols-3">
            {FEATURE_CARDS.map((f) => (
              <li
                key={f.num}
                className="rounded-2xl border border-slate-200 bg-white p-7 shadow-[0_1px_3px_rgba(15,23,42,0.04)]"
              >
                <p className={`text-[26px] font-bold leading-none tracking-tight ${T.heroNum}`}>
                  {f.num}
                </p>
                <p className="mt-4 text-[16px] font-semibold text-gray-900">{f.title}</p>
                <p className="mt-2 text-[13px] leading-6 text-gray-600">{f.body}</p>
              </li>
            ))}
          </ul>
          <div className="mt-10 flex justify-center">
            <Link
              href="/recommend"
              className={`inline-flex h-11 items-center rounded-full ${T.ctaBg} px-7 text-sm font-medium text-white transition-colors ${T.ctaHover}`}
            >
              시뮬레이터 시작하기 →
            </Link>
          </div>
        </div>
      </section>

      {/* Section 1a-2 — 후기 평가 좋은 배대지 TOP 6 */}
      {topReviewedForwarders.length > 0 && (
        <section className="border-t border-gray-100 px-5 py-14 sm:px-8 sm:py-16">
          <div className="mx-auto max-w-[1200px]">
            <header className="mb-8 flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-end">
              <div>
                <p className={`mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] ${T.accentEmerald}`}>
                  REVIEWS
                </p>
                <h2 className="text-[26px] font-semibold leading-[1.18] tracking-tight text-gray-900 sm:text-[32px]">
                  후기 평가 좋은 배대지.
                </h2>
                <p className="mt-2 text-[12px] text-gray-500">
                  외부 블로그·커뮤니티 후기 기준 · 자체 게시판 후기 제외
                </p>
              </div>
              <Link
                href="/forwarders"
                className="text-sm text-gray-600 underline-offset-4 hover:text-gray-900 hover:underline"
              >
                전체 배대지 →
              </Link>
            </header>
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {topReviewedForwarders.map((f) => (
                <li key={`${f.forwarder_id}-${f.country}`}>
                  <Link
                    href={`/forwarders/${f.forwarder_slug}`}
                    className="group flex h-full flex-col rounded-2xl border border-slate-200 bg-white p-5 transition-shadow hover:shadow-md"
                  >
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <span className="text-lg leading-none">{COUNTRY_FLAG[f.country]}</span>
                        <span className="text-[11px] text-gray-500">
                          {COUNTRY_NAME[f.country]} 배대지
                        </span>
                      </div>
                      <span className="inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded bg-green-50 text-green-700">
                        🟢 긍정 우세
                      </span>
                    </div>
                    <p className="text-[18px] font-semibold text-gray-900 group-hover:text-blue-700 mb-2">
                      {f.forwarder_name}
                    </p>
                    {f.notable_issues && (
                      <p className="text-[13px] leading-6 text-gray-600 line-clamp-3 flex-1">
                        {f.notable_issues}
                      </p>
                    )}
                    <p className="mt-3 text-[11px] text-gray-400">
                      외부 후기 {f.review_count}건 수집
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {/* Section 2 — Trust line */}
      <section className="border-t border-gray-100 bg-blue-50 px-5 py-16 sm:px-8 sm:py-20">
        <p className="mx-auto max-w-2xl text-center text-[20px] font-medium leading-[1.55] text-gray-600 sm:text-[22px]">
          순위는 가격·조건만으로 정해집니다.<br />
          <span className="text-gray-900">그래서 1위가 진짜 1위입니다.</span>
        </p>
        {reviewMetrics.externalReviewCount > 0 && (
          <p className="mx-auto mt-6 max-w-2xl text-center text-[13px] leading-[1.7] text-gray-500 sm:text-[14px]">
            외부 블로그·커뮤니티에서 수집한 배대지 사용자 후기{' '}
            <Link
              href="/forwarders"
              className="font-semibold text-blue-700 underline-offset-4 hover:underline"
            >
              {reviewMetrics.externalReviewCount}건
            </Link>
            을 배대지 페이지에 함께 보여드립니다. 자체 게시판 후기는 객관성을 위해 제외했습니다.
          </p>
        )}
      </section>

      {/* Section 4 — Deals carousel */}
      {dealItems.length > 0 && (
        <section className="border-t border-gray-100 bg-blue-50 px-5 py-16 sm:px-8 sm:py-20">
          <div className="mx-auto max-w-[1200px]">
            <header className="mb-8 flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-end">
              <div>
                <p className={`mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] ${T.accentAmber}`}>
                  DEALS
                </p>
                <h2 className="text-[26px] font-semibold leading-[1.18] tracking-tight text-gray-900 sm:text-[32px]">
                  곧 다가올 직구 타이밍.
                </h2>
              </div>
              <Link
                href="/deals"
                className="text-sm text-gray-600 underline-offset-4 hover:text-gray-900 hover:underline"
              >
                전체 일정 →
              </Link>
            </header>
            <HomeDealsCarousel items={dealItems} />
          </div>
        </section>
      )}

      {/* Section 4b — Exchange rates */}
      {exchange.rates.length > 0 && (
        <section className="border-t border-gray-100 px-5 py-16 sm:px-8 sm:py-20">
          <div className="mx-auto max-w-[1200px]">
            <header className="mb-8 flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-end">
              <div>
                <p className={`mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] ${T.accentSky}`}>
                  EXCHANGE RATES
                </p>
                <h2 className="text-[26px] font-semibold leading-[1.18] tracking-tight text-gray-900 sm:text-[32px]">
                  오늘의 환율.
                </h2>
                {exchange.updatedAt && (
                  <p className="mt-2 text-[12px] text-gray-500">
                    {formatExchangeDate(exchange.updatedAt)} 기준 · 매매기준율
                  </p>
                )}
              </div>
              <Link
                href="/exchange-rates"
                className="text-sm text-gray-600 underline-offset-4 hover:text-gray-900 hover:underline"
              >
                환율 동향 →
              </Link>
            </header>
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {exchange.rates.map((r) => {
                const display = r.current * r.scale
                const diff = r.prev != null ? r.current - r.prev : 0
                const diffPct = r.prev ? (diff / r.prev) * 100 : 0
                const up = diff > 0
                const trendUp = r.history.length >= 2 && r.history[r.history.length - 1] >= r.history[0]
                const sparkColor = diff === 0 ? '#94a3b8' : up ? '#dc2626' : '#2563eb'
                const sparkPoints = buildSparklinePoints(r.history, 200, 36)
                return (
                  <li
                    key={r.currency}
                    className="rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_1px_3px_rgba(15,23,42,0.04)]"
                  >
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-2">
                        <span className="text-xl leading-none">{r.flag}</span>
                        <span className="text-[13px] font-medium text-gray-700">{r.label}</span>
                      </span>
                      <span className="text-[11px] text-gray-400">{r.unit}</span>
                    </div>
                    <p className="mt-4 text-[24px] font-bold tracking-tight text-gray-900">
                      {display.toLocaleString('ko-KR', {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                      <span className="ml-1 text-[12px] font-normal text-gray-500">KRW</span>
                    </p>
                    {r.prev != null && (
                      <p
                        className={`mt-1 text-[12px] font-semibold ${
                          diff === 0 ? 'text-gray-500' : up ? 'text-red-600' : 'text-blue-600'
                        }`}
                      >
                        <span className="mr-1 text-[10px] font-normal text-gray-500">어제</span>
                        {diff === 0
                          ? '변동 없음'
                          : `${up ? '▲' : '▼'} ${Math.abs(diffPct).toFixed(2)}%`}
                      </p>
                    )}
                    {sparkPoints && (
                      <div className="mt-3">
                        <svg
                          viewBox="0 0 200 36"
                          preserveAspectRatio="none"
                          className="block h-9 w-full"
                          aria-label={`${r.label} 최근 ${r.history.length}영업일 추이`}
                        >
                          <polyline
                            points={sparkPoints}
                            fill="none"
                            stroke={sparkColor}
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                        <p className="mt-1 text-[10px] text-gray-400">
                          최근 {r.history.length}영업일{' '}
                          <span className={trendUp ? 'text-red-600' : 'text-blue-600'}>
                            {trendUp ? '상승' : '하락'} 추세
                          </span>
                        </p>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        </section>
      )}

      {/* Section 5 — Blog curation: 에디터 추천 + 카테고리별 그룹 */}
      {(grouped.length > 0 || heroPicks.length > 0) && (
        <section className="px-5 py-16 sm:px-8 sm:py-24">
          <div className="mx-auto max-w-[1200px]">
            <header className="mb-10 flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-end">
              <div>
                <p className={`mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] ${T.accentEmerald}`}>
                  BLOG
                </p>
                <h2 className="text-[26px] font-semibold leading-[1.18] tracking-tight text-gray-900 sm:text-[32px]">
                  매주, 한 가지 주제.
                </h2>
              </div>
              <Link
                href="/blog"
                className="text-sm text-gray-600 underline-offset-4 hover:text-gray-900 hover:underline"
              >
                전체 글 →
              </Link>
            </header>

            <div className="space-y-14">
              {heroPicks.length > 0 && (
                <div>
                  <div className="mb-5 border-b border-gray-100 pb-3">
                    <h3 className="text-[18px] font-semibold tracking-tight text-gray-900">
                      에디터 추천
                    </h3>
                  </div>
                  <BlogLayoutRow3 posts={heroPicks} cardCategoryClass={T.cardCategory} />
                </div>
              )}
              {grouped.map((group) => (
                <div key={group.category}>
                  <div className="mb-5 border-b border-gray-100 pb-3">
                    <h3 className="text-[18px] font-semibold tracking-tight text-gray-900">
                      {group.category}
                    </h3>
                  </div>
                  {group.layout === 'hero4' ? (
                    <BlogLayoutHero4 posts={group.posts} cardCategoryClass={T.cardCategory} />
                  ) : (
                    <BlogLayoutRow3 posts={group.posts} cardCategoryClass={T.cardCategory} />
                  )}
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Section 6 — Forwarders entry CTA + 운임표 thumbnail (P2/P9 신뢰 신호) */}
      <section className="border-t border-slate-100 bg-blue-50 px-5 py-20 sm:px-8 sm:py-24">
        <div className="mx-auto max-w-[1100px]">
          <div className="grid items-center gap-10 lg:grid-cols-[1fr_auto]">
            <div>
              <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-blue-700">
                FORWARDERS
              </p>
              <h2 className="text-[28px] font-semibold leading-[1.16] tracking-tight text-slate-900 sm:text-[36px]">
                30+ 배대지를<br />
                한 화면에서 비교합니다.
              </h2>
              <p className="mt-5 max-w-lg text-[14px] leading-7 text-slate-600">
                미국·일본·중국의 검증된 배송대행지를 모두 한 곳에. 요율표·검수 정책·창고 위치까지 배대지 페이지에서 확인하세요.
              </p>
            </div>
            <div className="flex flex-col gap-5">
              {/* 미니 운임표 thumbnail — 3국가 × 1kg/5kg 최저가 */}
              <CountryRateThumbnail rates={countrySampleRates} />
              <Link
                href="/forwarders"
                className="inline-flex h-12 items-center justify-center rounded-full bg-blue-600 px-7 text-[14px] font-semibold text-white transition-colors hover:bg-blue-700"
              >
                배대지 목록 보기 →
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Section 7 — Closing */}
      <section className="px-5 py-24 text-center sm:px-8 sm:py-28">
        <p className="mb-5 text-[11px] font-semibold uppercase tracking-[0.2em] text-gray-400">
          JIMSCANNER
        </p>
        <h2 className="text-[40px] font-semibold leading-[1.06] tracking-tight text-gray-900 sm:text-[56px]">
          계산해보면<br />
          알게 됩니다.
        </h2>
      </section>
    </div>
  )
}

function CountryRateThumbnail({ rates }: { rates: CountrySamplePrices }) {
  const ROWS: { code: 'US' | 'JP' | 'CN'; flag: string; name: string }[] = [
    { code: 'US', flag: '🇺🇸', name: '미국' },
    { code: 'JP', flag: '🇯🇵', name: '일본' },
    { code: 'CN', flag: '🇨🇳', name: '중국' },
  ]
  const fmt = (v: number | null) => (v === null ? '—' : `${v.toLocaleString()}원`)
  // 데이터가 모두 비어있으면 렌더 자체 생략
  const anyData = ROWS.some((r) => rates[r.code].kg1 !== null || rates[r.code].kg5 !== null)
  if (!anyData) return null
  return (
    <div className="rounded-2xl border border-blue-100 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.04)] sm:min-w-[320px]">
      <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-blue-700">
        예시 운임표
      </p>
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-[11px] text-gray-400">
            <th className="text-left font-normal pb-1.5">국가</th>
            <th className="text-right font-normal pb-1.5">1kg</th>
            <th className="text-right font-normal pb-1.5">5kg</th>
          </tr>
        </thead>
        <tbody className="text-gray-800">
          {ROWS.map((r) => (
            <tr key={r.code} className="border-t border-gray-50">
              <td className="py-1.5">
                <span className="mr-1.5">{r.flag}</span>
                <span className="text-gray-700">{r.name}</span>
              </td>
              <td className="py-1.5 text-right tabular-nums font-medium">{fmt(rates[r.code].kg1)}</td>
              <td className="py-1.5 text-right tabular-nums font-medium">{fmt(rates[r.code].kg5)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2.5 text-[10px] text-gray-400 leading-relaxed">
        30+ 배대지 최저가 · 1등급 기준 · 실시간 환율 환산
      </p>
    </div>
  )
}

function BlogLayoutHero4({
  posts,
  cardCategoryClass,
}: {
  posts: HomePostFields[]
  cardCategoryClass: string
}) {
  if (posts.length === 0) return null
  const [hero, ...rest] = posts
  const sides = rest.slice(0, 4)
  if (sides.length === 0) {
    return (
      <div className="mx-auto max-w-[760px]">
        <BlogHeroCard post={hero} cardCategoryClass={cardCategoryClass} />
      </div>
    )
  }
  const sideCols = sides.length === 1 ? 'grid-cols-1' : 'grid-cols-2'
  return (
    <div className="grid gap-5 lg:grid-cols-[1.5fr_1fr]">
      <BlogHeroCard post={hero} cardCategoryClass={cardCategoryClass} />
      <div className={`grid gap-4 ${sideCols}`}>
        {sides.map((p) => (
          <BlogSmallCard key={p.id} post={p} cardCategoryClass={cardCategoryClass} />
        ))}
      </div>
    </div>
  )
}

function BlogLayoutRow3({
  posts,
  cardCategoryClass,
}: {
  posts: HomePostFields[]
  cardCategoryClass: string
}) {
  const list = posts.slice(0, 3)
  if (list.length === 0) return null
  if (list.length === 1) {
    return (
      <div className="mx-auto max-w-[600px]">
        <BlogMediumCard post={list[0]} cardCategoryClass={cardCategoryClass} />
      </div>
    )
  }
  const cols = list.length === 2 ? 'sm:grid-cols-2' : 'sm:grid-cols-2 lg:grid-cols-3'
  return (
    <div className={`grid gap-5 ${cols}`}>
      {list.map((p) => (
        <BlogMediumCard key={p.id} post={p} cardCategoryClass={cardCategoryClass} />
      ))}
    </div>
  )
}

function BlogHeroCard({ post, cardCategoryClass }: { post: HomePostFields; cardCategoryClass: string }) {
  return (
    <Link
      href={`/blog/${post.slug}`}
      className="group block overflow-hidden rounded-2xl border border-slate-200 bg-white transition-shadow hover:shadow-md"
    >
      <div className="relative aspect-[16/10] bg-slate-100">
        {post.cover_image_url ? (
          <Image
            src={post.cover_image_url}
            alt={post.title}
            fill
            sizes="(min-width: 1024px) 50vw, 100vw"
            className="object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-slate-300">
            <ArticleMark />
          </div>
        )}
      </div>
      <div className="p-6">
        <p className={`mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] ${cardCategoryClass}`}>
          {post.category} · {estimateReadingMinutes(countWords(post.content))}분
        </p>
        <h4 className="text-[20px] font-semibold leading-[1.28] tracking-tight text-gray-900 group-hover:underline sm:text-[22px]">
          {post.title}
        </h4>
        {post.description && (
          <p className="mt-3 line-clamp-2 text-[13px] leading-6 text-gray-600">
            {post.description}
          </p>
        )}
        <p className="mt-4 text-[11px] text-gray-400">
          {formatPublishedDate(post.published_at)}
        </p>
      </div>
    </Link>
  )
}

function BlogMediumCard({ post, cardCategoryClass }: { post: HomePostFields; cardCategoryClass: string }) {
  return (
    <Link
      href={`/blog/${post.slug}`}
      className="group block overflow-hidden rounded-xl border border-slate-200 bg-white transition-shadow hover:shadow-sm"
    >
      <div className="relative aspect-[16/10] bg-slate-100">
        {post.cover_image_url ? (
          <Image
            src={post.cover_image_url}
            alt={post.title}
            fill
            sizes="(min-width: 1024px) 33vw, 50vw"
            className="object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-slate-300">
            <ArticleMark compact />
          </div>
        )}
      </div>
      <div className="p-5">
        <p className={`mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] ${cardCategoryClass}`}>
          {post.category} · {estimateReadingMinutes(countWords(post.content))}분
        </p>
        <h4 className="line-clamp-2 text-[15px] font-semibold leading-[1.32] tracking-tight text-gray-900 group-hover:underline">
          {post.title}
        </h4>
        <p className="mt-3 text-[11px] text-gray-400">
          {formatPublishedDate(post.published_at)}
        </p>
      </div>
    </Link>
  )
}

function BlogSmallCard({ post, cardCategoryClass }: { post: HomePostFields; cardCategoryClass: string }) {
  return (
    <Link
      href={`/blog/${post.slug}`}
      className="group block overflow-hidden rounded-xl border border-slate-200 bg-white transition-shadow hover:shadow-sm"
    >
      <div className="relative aspect-[4/3] bg-slate-100">
        {post.cover_image_url ? (
          <Image
            src={post.cover_image_url}
            alt={post.title}
            fill
            sizes="(min-width: 1024px) 25vw, 50vw"
            className="object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-slate-300">
            <ArticleMark compact />
          </div>
        )}
      </div>
      <div className="p-4">
        <p className={`mb-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] ${cardCategoryClass}`}>
          {post.category}
        </p>
        <h4 className="line-clamp-2 text-[13px] font-semibold leading-[1.32] tracking-tight text-gray-900 group-hover:underline">
          {post.title}
        </h4>
      </div>
    </Link>
  )
}

function ArticleMark({ compact = false }: { compact?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 120 80"
      className={compact ? 'h-12 w-16' : 'h-20 w-28'}
    >
      <rect x="18" y="16" width="84" height="48" rx="10" fill="white" opacity="0.7" />
      <path d="M34 31 H86" stroke="currentColor" strokeWidth="1" opacity="0.5" />
      <path d="M34 40 H74" stroke="currentColor" strokeWidth="1" opacity="0.4" />
      <path d="M34 49 H82" stroke="currentColor" strokeWidth="1" opacity="0.4" />
      <circle cx="88" cy="49" r="5" fill="currentColor" opacity="0.3" />
    </svg>
  )
}
