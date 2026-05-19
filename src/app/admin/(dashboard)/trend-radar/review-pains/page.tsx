import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface PainRow {
  id: string
  keyword: string
  product_ref: string | null
  product_title: string | null
  source: string
  pain_topic: string
  pain_label: string | null
  frequency: number
  repr_quote: string | null
  confidence: number | string
  ggsan_match_goods_no: string | null
  observed_at: string
}

interface GgsanRow {
  goods_no: string
  title: string
  price_krw: number | null
  detail_url: string | null
}

const TOPIC_LABEL: Record<string, string> = {
  quality: '품질',
  size: '사이즈',
  durability: '내구성',
  packaging: '포장',
  usability: '사용감',
  smell: '냄새',
  taste: '맛',
  price: '가격',
  shipping: '배송',
  effect: '효과',
  etc: '기타',
}

const TOPIC_ORDER = [
  'quality',
  'size',
  'durability',
  'packaging',
  'usability',
  'smell',
  'taste',
  'effect',
  'price',
  'shipping',
  'etc',
]

async function fetchData() {
  const sb = createAdminClient()

  // 신규 테이블 — types/supabase.ts 가 재생성되기 전까지 as any 캐스팅.
  const { data: pains } = await (sb as any)
    .from('jimscanner_review_pains')
    .select(
      'id, keyword, product_ref, product_title, source, pain_topic, pain_label, frequency, repr_quote, confidence, ggsan_match_goods_no, observed_at',
    )
    .order('frequency', { ascending: false })
    .limit(2000)

  const rows = (pains ?? []) as PainRow[]

  const ggsanNos = Array.from(
    new Set(rows.map((r) => r.ggsan_match_goods_no).filter((v): v is string => !!v)),
  )

  let ggsanById = new Map<string, GgsanRow>()
  if (ggsanNos.length > 0) {
    const { data: ggsan } = await sb
      .from('jimscanner_ggsan_products')
      .select('goods_no, title, price_krw, detail_url')
      .in('goods_no', ggsanNos)
    ggsanById = new Map(((ggsan ?? []) as GgsanRow[]).map((g) => [g.goods_no, g]))
  }

  return { rows, ggsanById }
}

interface MatrixCell {
  keyword: string
  pain_topic: string
  frequency: number
  product_count: number
  repr_quote: string | null
  pain_label: string | null
  ggsan_match_goods_no: string | null
  confidence_avg: number
}

function buildMatrix(rows: PainRow[]): {
  matrix: Map<string, Map<string, MatrixCell>>
  keywords: string[]
  topics: string[]
} {
  const matrix = new Map<string, Map<string, MatrixCell>>()
  const keywordFreq = new Map<string, number>()
  const topicSet = new Set<string>()

  for (const r of rows) {
    topicSet.add(r.pain_topic)
    keywordFreq.set(r.keyword, (keywordFreq.get(r.keyword) ?? 0) + r.frequency)

    if (!matrix.has(r.keyword)) matrix.set(r.keyword, new Map())
    const row = matrix.get(r.keyword)!
    const conf = typeof r.confidence === 'string' ? parseFloat(r.confidence) : r.confidence
    const existing = row.get(r.pain_topic)
    if (existing) {
      existing.frequency += r.frequency
      existing.product_count += r.product_ref ? 1 : 0
      existing.confidence_avg =
        (existing.confidence_avg + (Number.isFinite(conf) ? conf : 0)) / 2
      if (!existing.repr_quote && r.repr_quote) existing.repr_quote = r.repr_quote
      if (!existing.pain_label && r.pain_label) existing.pain_label = r.pain_label
      if (!existing.ggsan_match_goods_no && r.ggsan_match_goods_no) {
        existing.ggsan_match_goods_no = r.ggsan_match_goods_no
      }
    } else {
      row.set(r.pain_topic, {
        keyword: r.keyword,
        pain_topic: r.pain_topic,
        frequency: r.frequency,
        product_count: r.product_ref ? 1 : 0,
        repr_quote: r.repr_quote,
        pain_label: r.pain_label,
        ggsan_match_goods_no: r.ggsan_match_goods_no,
        confidence_avg: Number.isFinite(conf) ? conf : 0,
      })
    }
  }

  const keywords = Array.from(keywordFreq.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k)
    .slice(0, 30)

  const topics = TOPIC_ORDER.filter((t) => topicSet.has(t))
  for (const t of topicSet) if (!topics.includes(t)) topics.push(t)

  return { matrix, keywords, topics }
}

function cellColor(freq: number, maxFreq: number): string {
  if (freq <= 0 || maxFreq <= 0) return 'bg-gray-50 text-gray-300'
  const ratio = Math.min(1, freq / maxFreq)
  if (ratio >= 0.8) return 'bg-red-600 text-white'
  if (ratio >= 0.6) return 'bg-red-500 text-white'
  if (ratio >= 0.4) return 'bg-orange-400 text-white'
  if (ratio >= 0.2) return 'bg-yellow-300 text-gray-900'
  return 'bg-yellow-100 text-gray-700'
}

export default async function ReviewPainsPage() {
  const { rows, ggsanById } = await fetchData()
  const { matrix, keywords, topics } = buildMatrix(rows)

  let maxFreq = 0
  for (const row of matrix.values()) {
    for (const c of row.values()) if (c.frequency > maxFreq) maxFreq = c.frequency
  }

  // '검색량 상위 + 동일 페인 ≥ 3건' = 핀 후보
  const PIN_THRESHOLD = 3
  const pinCandidates: MatrixCell[] = []
  for (const kw of keywords) {
    const row = matrix.get(kw)
    if (!row) continue
    for (const c of row.values()) {
      if (c.frequency >= PIN_THRESHOLD) pinCandidates.push(c)
    }
  }
  pinCandidates.sort((a, b) => b.frequency - a.frequency)

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">리뷰 페인포인트 매트릭스</h1>
          <p className="text-sm text-gray-500 mt-1">
            상위 키워드 × 부정 토픽 빈도. 셀이 진할수록 같은 불만이 반복되는 곳 — 차별화 진입 기회.
            <br />
            데이터 출처: 네이버 스토어 / 쿠팡 / 올리브영 리뷰 (LLM 토픽 추출, 일 1회 갱신).
          </p>
        </div>
        <Link
          href="/admin/trend-radar"
          className="text-sm text-gray-700 hover:text-black underline"
        >
          ← 대시보드
        </Link>
      </header>

      {rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          <p className="text-base font-medium">리뷰 페인 데이터 없음</p>
          <p className="text-sm mt-2">
            <code className="px-1 py-0.5 bg-gray-100 rounded">
              node --env-file=.env.local scripts/mine-review-pains.mjs
            </code>{' '}
            을 먼저 실행해 토픽을 추출하라.
            <br />
            (DDL: <code>supabase/trends_v4_review_pains.sql</code>)
          </p>
        </div>
      ) : (
        <>
          {pinCandidates.length > 0 && (
            <section className="rounded border border-red-200 bg-red-50 p-4">
              <h2 className="text-sm font-semibold text-red-800">
                🚨 핀 후보 — 검색량 상위 + 동일 페인 ≥ {PIN_THRESHOLD}건 ({pinCandidates.length})
              </h2>
              <p className="text-xs text-red-700 mt-1">
                각 항목은 '차별화 포인트' 메모 후보. 핀 등록 시 자동 첨부 (다음 PR).
              </p>
              <ul className="mt-3 space-y-2">
                {pinCandidates.slice(0, 10).map((c, idx) => {
                  const ggsan = c.ggsan_match_goods_no
                    ? ggsanById.get(c.ggsan_match_goods_no)
                    : null
                  return (
                    <li
                      key={`${c.keyword}::${c.pain_topic}::${idx}`}
                      className="rounded bg-white border border-red-100 px-3 py-2 text-sm"
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <span className="font-semibold">{c.keyword}</span>
                          <span className="mx-2 text-gray-300">|</span>
                          <span className="text-gray-700">
                            {TOPIC_LABEL[c.pain_topic] ?? c.pain_topic}
                          </span>
                          {c.pain_label && (
                            <span className="ml-2 text-xs text-gray-500">— {c.pain_label}</span>
                          )}
                        </div>
                        <div className="text-xs font-mono text-red-700">
                          freq {c.frequency} · n={c.product_count}
                        </div>
                      </div>
                      {c.repr_quote && (
                        <blockquote className="mt-1 text-xs text-gray-600 italic border-l-2 border-red-200 pl-2">
                          "{c.repr_quote}"
                        </blockquote>
                      )}
                      {ggsan && (
                        <div className="mt-1 text-xs text-blue-700">
                          ggsan 매칭:{' '}
                          {ggsan.detail_url ? (
                            <a
                              href={ggsan.detail_url}
                              target="_blank"
                              rel="noreferrer"
                              className="underline"
                            >
                              {ggsan.title}
                            </a>
                          ) : (
                            ggsan.title
                          )}
                          {ggsan.price_krw != null && (
                            <span className="ml-2 text-gray-500">
                              ₩{ggsan.price_krw.toLocaleString()}
                            </span>
                          )}
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            </section>
          )}

          <section>
            <h2 className="text-sm font-semibold text-gray-700 mb-2">
              매트릭스 ({keywords.length} 키워드 × {topics.length} 토픽)
            </h2>
            <div className="overflow-x-auto rounded border border-gray-200">
              <table className="w-full text-xs">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium text-gray-700 sticky left-0 bg-gray-50">
                      키워드
                    </th>
                    {topics.map((t) => (
                      <th
                        key={t}
                        className="px-2 py-2 text-center font-medium text-gray-700"
                        title={t}
                      >
                        {TOPIC_LABEL[t] ?? t}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {keywords.map((kw) => {
                    const row = matrix.get(kw)
                    return (
                      <tr key={kw} className="border-t border-gray-100">
                        <td className="px-3 py-1.5 font-medium text-gray-800 sticky left-0 bg-white">
                          {kw}
                        </td>
                        {topics.map((t) => {
                          const cell = row?.get(t)
                          const freq = cell?.frequency ?? 0
                          const title = cell
                            ? `${kw} · ${TOPIC_LABEL[t] ?? t}\nfreq=${freq} · n=${cell.product_count}${
                                cell.repr_quote ? `\n"${cell.repr_quote.slice(0, 120)}"` : ''
                              }`
                            : '—'
                          return (
                            <td
                              key={t}
                              className={`px-2 py-1.5 text-center font-mono ${cellColor(freq, maxFreq)}`}
                              title={title}
                            >
                              {freq > 0 ? freq : ''}
                            </td>
                          )
                        })}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-gray-500">
              셀 hover → 대표 인용문 미리보기. (셀 클릭 → 상세 패널은 다음 PR.)
            </p>
          </section>
        </>
      )}
    </div>
  )
}
