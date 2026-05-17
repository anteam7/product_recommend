import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import OrphanRow, { type ProductOption } from './OrphanRow'

export const dynamic = 'force-dynamic'

interface OrphanRowData {
  keyword_norm: string
  keyword: string
  freq_7d: number
  freq_30d: number
  source_count: number
  sources: string[]
  last_seen_at: string
}

interface CoverageRow {
  day: string
  total_signals: number
  matched_signals: number
  orphan_signals: number
  coverage_pct: number
}

// 단순 1-shot 카테고리 추정 — LLM 호출 비용 없이 규칙 기반.
// 정확한 LLM 분류는 product 생성 시 운영자가 결정.
const CATEGORY_HINTS: { kw: RegExp; top: string }[] = [
  { kw: /(영양제|비타민|유산균|콜라겐|루테인|오메가|프로폴리스|멜라토닌|마그네슘|아연|글루코사민|단백질|보충제|효소|건강식품)/, top: 'health' },
  { kw: /(에센스|크림|토너|로션|마스크|세럼|선크림|쿠션|립스틱|아이라이너|마스카라|블러셔|향수|샴푸|린스|트리트먼트)/, top: 'beauty' },
  { kw: /(이어폰|헤드폰|키보드|마우스|모니터|충전기|배터리|보조배터리|케이블|허브|어댑터|스마트폰|아이패드|노트북|태블릿|usb|이어팟|airpod|iphone|galaxy|갤럭시|아이폰)/i, top: 'digital' },
  { kw: /(원피스|티셔츠|블라우스|니트|코트|패딩|점퍼|자켓|청바지|반바지|레깅스|운동화|스니커즈|샌들|구두|모자|가방|지갑|벨트|머플러|장갑)/, top: 'fashion' },
  { kw: /(라면|과자|초콜릿|커피|차|음료|와인|위스키|소스|간식|디저트|시리얼|단백질바|에너지바)/, top: 'food' },
  { kw: /(이유식|기저귀|분유|젖병|유모차|카시트|아기침대|아기띠|장난감|동화책)/, top: 'baby' },
  { kw: /(사료|간식|장난감|배변패드|모래|캣타워|강아지|고양이|반려동물|반려견|반려묘)/, top: 'pet' },
  { kw: /(요가|필라테스|러닝|덤벨|아령|매트|단백질|러닝화|등산|캠핑|텐트|배낭|자전거)/, top: 'sports' },
  { kw: /(수납|정리|행거|선반|커튼|쿠션|이불|베개|매트리스|책상|의자|식기|컵|냄비|프라이팬|청소기|공기청정기|가습기)/, top: 'living' },
]

function guessCategory(keyword: string): string | null {
  for (const h of CATEGORY_HINTS) {
    if (h.kw.test(keyword)) return h.top
  }
  return null
}

async function fetchData() {
  const sb = createAdminClient()
  // 새 뷰는 generated 타입에 없음 — `as any` 우회 (rpc_type_workaround 패턴).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sbAny = sb as any

  const [orphansRes, coverageRes, productsRes] = await Promise.all([
    sbAny
      .from('jimscanner_trends_orphan_queries')
      .select('keyword_norm, keyword, freq_7d, freq_30d, source_count, sources, last_seen_at')
      .order('freq_7d', { ascending: false })
      .order('freq_30d', { ascending: false })
      .limit(200),
    sbAny
      .from('jimscanner_trends_alias_coverage_daily')
      .select('day, total_signals, matched_signals, orphan_signals, coverage_pct')
      .order('day', { ascending: false })
      .limit(30),
    sb
      .from('jimscanner_trends_products')
      .select('id, canonical_name, category_top')
      .order('last_seen_at', { ascending: false })
      .limit(500),
  ])

  const orphans = (orphansRes.data ?? []) as OrphanRowData[]
  const coverage = ((coverageRes.data ?? []) as CoverageRow[]).slice().reverse() // 오름차순 (과거→현재)
  const products: ProductOption[] = (productsRes.data ?? []).map((p) => ({
    id: p.id,
    label: `${p.canonical_name} (${p.category_top})`,
  }))

  return { orphans, coverage, products, orphansErr: orphansRes.error?.message ?? null, coverageErr: coverageRes.error?.message ?? null }
}

function Sparkline({ data }: { data: CoverageRow[] }) {
  if (data.length === 0) {
    return <div className="text-xs text-gray-400">데이터 없음 — SQL 마이그레이션 미적용 가능성.</div>
  }
  const w = 600
  const h = 80
  const pad = 4
  const xs = data.map((_, i) => pad + (i * (w - 2 * pad)) / Math.max(1, data.length - 1))
  const ys = data.map((d) => h - pad - (Math.max(0, Math.min(100, Number(d.coverage_pct))) / 100) * (h - 2 * pad))
  const pts = xs.map((x, i) => `${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ')
  const last = data[data.length - 1]
  const first = data[0]
  return (
    <div>
      <svg width={w} height={h} className="block">
        {/* 50% / 100% 그리드 */}
        <line x1={pad} x2={w - pad} y1={h - pad} y2={h - pad} stroke="#e5e7eb" />
        <line x1={pad} x2={w - pad} y1={pad} y2={pad} stroke="#f3f4f6" />
        <line
          x1={pad}
          x2={w - pad}
          y1={h / 2}
          y2={h / 2}
          stroke="#f3f4f6"
          strokeDasharray="2 2"
        />
        <polyline fill="none" stroke="#2563eb" strokeWidth="1.5" points={pts} />
        {xs.map((x, i) => (
          <circle key={i} cx={x} cy={ys[i]} r="1.5" fill="#2563eb" />
        ))}
      </svg>
      <div className="flex justify-between text-xs text-gray-500 mt-1">
        <span>{first.day?.slice(5, 10)} · {first.coverage_pct}%</span>
        <span className="font-medium text-gray-700">
          오늘 {last.coverage_pct}% (matched {last.matched_signals}/{last.total_signals})
        </span>
      </div>
    </div>
  )
}

export default async function AliasGapPage() {
  const { orphans, coverage, products, orphansErr, coverageErr } = await fetchData()

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">Alias Gap Hunter</h1>
          <p className="text-sm text-gray-500 mt-1">
            매칭 실패 키워드 (orphan) — 1클릭으로 product 등록 또는 ignore.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      <section className="rounded border border-gray-200 p-4">
        <div className="text-sm font-semibold text-gray-800 mb-2">일별 Alias Coverage (최근 30d)</div>
        <Sparkline data={coverage} />
        {coverageErr && <div className="text-xs text-red-600 mt-2">coverage 뷰 에러: {coverageErr}</div>}
      </section>

      <section>
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="text-sm font-semibold text-gray-700">
            Orphan 키워드 ({orphans.length}건, 7d 빈도순)
          </h2>
          <div className="text-xs text-gray-500">
            매칭 안 된 시그널만 노출 — 모든 source 통합 (google_suggest · naver_* · daum_news · ppomppu 등)
          </div>
        </div>
        <div className="rounded border border-gray-200">
          <div className="grid grid-cols-12 items-center gap-2 px-4 py-2 bg-gray-50 text-xs font-medium text-gray-600 border-b border-gray-200">
            <div className="col-span-4">키워드 / 소스</div>
            <div className="col-span-1 text-right">7d</div>
            <div className="col-span-1 text-right">30d</div>
            <div className="col-span-1 text-right">소스#</div>
            <div className="col-span-2">최근</div>
            <div className="col-span-1">추정</div>
            <div className="col-span-2 text-right">액션</div>
          </div>
          {orphans.length === 0 ? (
            <div className="p-8 text-center text-sm text-gray-500">
              {orphansErr ? `에러: ${orphansErr}` : 'orphan 키워드 없음 (또는 SQL 마이그레이션 미적용).'}
            </div>
          ) : (
            orphans.map((o) => (
              <OrphanRow
                key={o.keyword_norm}
                keyword={o.keyword}
                freq7d={o.freq_7d}
                freq30d={o.freq_30d}
                sourceCount={o.source_count}
                sources={o.sources ?? []}
                lastSeenAt={o.last_seen_at}
                guessCategory={guessCategory(o.keyword)}
                products={products}
              />
            ))
          )}
        </div>
      </section>

      <section className="rounded border border-dashed border-gray-300 p-4 text-xs text-gray-500">
        <div className="font-medium text-gray-700 mb-1">운영 메모</div>
        <ul className="list-disc ml-4 space-y-1">
          <li>
            마이그레이션: <code>supabase/trends_orphan_queries.sql</code> 적용 후 본 페이지 동작.
          </li>
          <li>
            카테고리 추정은 규칙 기반 1-shot — 정확도가 낮으니 product 생성 시 운영자가 보정.
          </li>
          <li>
            ignore 한 키워드는 다음 집계에서 자동 제외 (jimscanner_trends_ignored_keywords).
          </li>
          <li>
            KPI 시계열: source=&apos;alias_coverage_audit&apos; 일일 cron 추가 시 trends_runs 에 누적.
          </li>
        </ul>
      </section>
    </div>
  )
}
