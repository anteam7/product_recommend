import type { Metadata } from 'next'
import Link from 'next/link'
import Image from 'next/image'
import RecommendApp from './RecommendApp'
import { supabase } from '@/lib/supabase'
import {
  type BlogPost,
  formatPublishedDate,
  estimateReadingMinutes,
  countWords,
} from '@/lib/blog'

const PAGE_URL = 'https://jimscanner.co.kr/recommend'

export const metadata: Metadata = {
  title: '해외직구 관부가세 계산기·배대지 추천 | 짐스캐너 직구 시뮬레이터',
  description:
    '나이키·리바이스·카하트 등 브랜드와 상품 카테고리를 선택하면 실제 통관 데이터로 무게를 추정하고, 상품가격까지 입력하면 관세·부가세·자가사용 한도 검사·간이세율 적용까지 자동 계산. 미국·일본·중국 30+개 배대지 최저가 즉시 비교. 무료.',
  keywords: [
    '해외직구',
    '관부가세 계산기',
    '직구 관세 계산',
    '간이세율',
    '면세한도',
    '미국 직구 200달러',
    '일본 직구 150달러',
    '배대지 비교',
    '배대지 추천',
    '직구 무게 추정',
    '나이키 직구',
    '카하트 직구',
    '리바이스 청바지',
    '영양제 직구 6병',
    '아이허브',
    '아마존 직구',
    '타오바오 직구',
    '짐패스',
    '몰테일',
    '아이포터',
  ],
  alternates: { canonical: PAGE_URL },
  openGraph: {
    title: '해외직구 시뮬레이터 — 무게·배대지·관부가세 한 번에 계산',
    description:
      '카테고리·브랜드 선택 + 상품가격 입력만으로 미국·일본·중국 직구의 예상 무게, 최저가 배대지, 관세·부가세까지 자동 계산. 실제 통관 데이터 기반.',
    url: PAGE_URL,
    type: 'website',
    siteName: '짐스캐너',
    locale: 'ko_KR',
  },
  twitter: {
    card: 'summary_large_image',
    title: '해외직구 시뮬레이터 — 무게·배대지·관부가세 한 번에',
    description:
      '카테고리·브랜드·상품가격 입력만으로 무게·배대지·관부가세를 한 번에 추정합니다.',
  },
  robots: { index: true, follow: true },
}

// 클라이언트 위주 페이지 — 카트는 sessionState. SSR 캐싱 의미 없음.
export const dynamic = 'force-dynamic'

const STRUCTURED_DATA = {
  '@context': 'https://schema.org',
  '@type': 'WebApplication',
  name: '짐스캐너 직구 시뮬레이터',
  url: PAGE_URL,
  applicationCategory: 'FinanceApplication',
  operatingSystem: 'Web',
  inLanguage: 'ko-KR',
  description:
    '해외직구 무게 추정, 배대지 가격 비교, 관세·부가세 계산을 한 번에 제공하는 무료 시뮬레이터.',
  offers: {
    '@type': 'Offer',
    price: '0',
    priceCurrency: 'KRW',
  },
  featureList: [
    '카테고리·브랜드별 무게 추정',
    '미국·일본·중국 30+ 배대지 가격 비교',
    '항공/항운 자동 분기',
    '관세·부가세·개별소비세 계산',
    '면세한도(한미 FTA $200 / 일반 $150) 자동 검사',
    '자가사용 한도(영양제 6병 등) 검사',
    '부가서비스 옵션 즉시 합산',
  ],
}

const FAQ_STRUCTURED = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: [
    {
      '@type': 'Question',
      name: '미국 직구 면세한도는 얼마인가요?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: '미국발 항공 특송(DHL/FedEx/UPS 등)으로 들어오는 자가사용 물품은 한미 FTA 적용으로 $200까지 면세입니다. 다만 영양제·의약품 등 목록통관 배제 품목은 국가 무관 $150 한도가 적용됩니다.',
      },
    },
    {
      '@type': 'Question',
      name: '일본·중국 직구 면세한도는?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: '일본·중국·기타 국가는 자가사용 $150까지 면세입니다.',
      },
    },
    {
      '@type': 'Question',
      name: '관부가세는 어떻게 계산하나요?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: '관세는 카테고리별 세율(의류·신발 13%, 시계·화장품·영양제·가구 8%, 컴퓨터부품·완구 0% 등)을 적용하고, 부가세는 (상품가 + 관세 + 개별소비세) × 10% 입니다. 시뮬레이터에서 카트 항목별 단가를 입력하면 자동 계산됩니다.',
      },
    },
    {
      '@type': 'Question',
      name: '영양제는 몇 개까지 면세인가요?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: '자가사용 6병까지 면세 통관 가능하며, 6병 초과 시 전체 가격에 대해 관부가세가 부과됩니다. 영양제·건강기능식품은 목록통관 배제라서 미국이라도 $150 면세한도가 적용됩니다.',
      },
    },
  ],
}

export default async function Page() {
  const { data } = await supabase
    .from('jimscanner_blog_posts')
    .select('*')
    .eq('status', 'published')
    .order('published_at', { ascending: false })
    .limit(3)
  const latestPosts = (data ?? []) as BlogPost[]

  return (
    <main className="container mx-auto max-w-6xl px-4 py-8">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(STRUCTURED_DATA) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(FAQ_STRUCTURED) }}
      />
      <header className="mb-6">
        <h1 className="text-2xl font-bold sm:text-3xl">
          해외직구 시뮬레이터 — 무게·배대지·관부가세 한 번에
        </h1>
        <p className="mt-2 text-sm text-gray-600 sm:text-base">
          카테고리·브랜드를 선택하면 실제 통관 데이터로 <strong>무게를 추정</strong>하고{' '}
          <strong>최저가 배대지</strong>를 추천합니다. 카트 항목에{' '}
          <strong className="rounded bg-blue-100 px-1.5 py-0.5 text-blue-800">
            상품 가격(USD)
          </strong>
          까지 입력하면 <strong>관세·부가세·면세한도 검사</strong>까지 자동으로 계산됩니다.
        </p>
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
          <li>✓ 미국·일본·중국 30+ 배대지 비교</li>
          <li>✓ 한미 FTA $200 / 일반 $150 면세한도 자동 적용</li>
          <li>✓ 의류·신발·영양제·시계 등 카테고리별 간이세율</li>
          <li>✓ 영양제 6병 등 자가사용 한도 검사</li>
        </ul>
      </header>
      <RecommendApp />

      {/* SEO 보조: 검색엔진이 페이지 주제를 파악하도록 본문에 키워드 포함된 안내 섹션 */}
      <section className="mt-12 space-y-6 border-t pt-8 text-sm text-gray-700">
        <h2 className="text-lg font-bold text-gray-900">자주 묻는 질문</h2>
        <div>
          <h3 className="font-semibold text-gray-900">미국 직구 면세한도는 얼마인가요?</h3>
          <p className="mt-1 text-gray-600">
            미국발 항공 특송(DHL/FedEx/UPS)으로 들어오는 자가사용 물품은 한미 FTA 적용으로{' '}
            <strong>$200까지 면세</strong>입니다. 다만 영양제·의약품 등 목록통관 배제 품목은 국가
            무관 $150 한도입니다.
          </p>
        </div>
        <div>
          <h3 className="font-semibold text-gray-900">일본·중국 직구 면세한도는?</h3>
          <p className="mt-1 text-gray-600">
            일본·중국·기타 국가는 자가사용 <strong>$150까지 면세</strong>입니다.
          </p>
        </div>
        <div>
          <h3 className="font-semibold text-gray-900">관부가세는 어떻게 계산되나요?</h3>
          <p className="mt-1 text-gray-600">
            관세 = 상품가 × 카테고리 세율 (의류·신발 13%, 화장품·영양제·시계·가구 8%,
            완구·컴퓨터부품 0% 등). 부가세 = (상품가 + 관세 + 개별소비세) × 10%. 시계 200만원 초과
            시 개별소비세 20% 추가 부과.
          </p>
        </div>
        <div>
          <h3 className="font-semibold text-gray-900">영양제는 몇 개까지 면세인가요?</h3>
          <p className="mt-1 text-gray-600">
            <strong>자가사용 6병까지 면세 통관</strong> 가능하며, 6병 초과 시 전체 가격에 관부가세가
            부과됩니다. 영양제·건강기능식품은 목록통관 배제라 미국이라도 $150 면세한도가
            적용됩니다.
          </p>
        </div>
        <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          ⚠️ 본 시뮬레이터의 무게·관부가세는 일반 가이드 기준 추정치입니다. 실제 무게는 제품 사이즈에
          따라 차이가 있을 수 있고, 실제 부과 세액은 통관 시 결정됩니다.
        </p>
      </section>

      {latestPosts.length > 0 && (
        <section className="mt-12 border-t pt-8">
          <div className="mb-6 flex items-end justify-between gap-4">
            <div>
              <h2 className="text-lg font-bold text-gray-900 sm:text-xl">최신 블로그</h2>
              <p className="mt-1 text-sm text-gray-600">
                해외직구·배대지 관련 최신 가이드와 인사이트
              </p>
            </div>
            <Link
              href="/blog"
              className="shrink-0 text-sm font-medium text-blue-600 hover:text-blue-700"
            >
              전체 보기 →
            </Link>
          </div>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {latestPosts.map((p) => {
              const chars = countWords(p.content)
              return (
                <Link
                  key={p.id}
                  href={`/blog/${p.slug}`}
                  className="group overflow-hidden rounded-xl border bg-white transition-all hover:border-blue-300 hover:shadow-md"
                >
                  {p.cover_image_url ? (
                    <div className="relative aspect-[16/9] w-full">
                      <Image
                        src={p.cover_image_url}
                        alt={p.title}
                        fill
                        sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
                        className="object-cover"
                      />
                    </div>
                  ) : (
                    <div className="flex aspect-[16/9] w-full items-center justify-center bg-gradient-to-br from-blue-50 via-sky-50 to-indigo-50 px-6">
                      <p className="line-clamp-3 text-center text-base font-semibold text-gray-700">
                        {p.title}
                      </p>
                    </div>
                  )}
                  <div className="space-y-2 p-4">
                    <span className="inline-block rounded bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
                      {p.category}
                    </span>
                    <h3 className="line-clamp-2 text-base font-bold leading-snug text-gray-900 group-hover:text-blue-600">
                      {p.title}
                    </h3>
                    {p.description && (
                      <p className="line-clamp-2 text-xs leading-relaxed text-gray-600">
                        {p.description}
                      </p>
                    )}
                    <div className="flex items-center justify-between text-[11px] text-gray-500">
                      <span>{formatPublishedDate(p.published_at)}</span>
                      <span>{estimateReadingMinutes(chars)}분 분량</span>
                    </div>
                  </div>
                </Link>
              )
            })}
          </div>
        </section>
      )}
    </main>
  )
}
