import { createAdminClient } from '@/lib/auth/admin-supabase'
import { GOV_NEWS_QUERIES } from '@/lib/market-keywords'

/**
 * 시그널 데이터를 LLM 컨텍스트 텍스트(+ UI 용 raw)로 정제.
 * suggest-keywords / 글감 추천 / 시장 시그널 페이지의 추천 패널에서 공유.
 */

type RawRow = {
  source: string
  title: string | null
  source_url: string | null
  query: string | null
  metadata: Record<string, unknown> | null
  captured_at: string
}

export type GovItem = {
  source: string
  title: string
  url: string | null
  query: string | null
  captured_at: string
}

export type QueryFreq = { query: string; count: number }
export type WordFreq = { word: string; count: number }
export type DealItem = { title: string; site_label: string | null; url: string | null }
export type BlogQuery = { query: string; count: number }

export type SignalContext = {
  text: string
  raw: {
    gov: GovItem[]
    top_suggest_queries: QueryFreq[]
    top_suggestion_words: WordFreq[]
    deals: DealItem[]
    blog_queries: BlogQuery[]
  }
  meta: {
    days: number
    fetched_at: string
    counts: Record<string, number>
  }
}

const STOPWORDS = new Set([
  '직구', '해외', '구매', '추천', '후기', '관세', '배대지', '사이트',
  '방법', '가격', '비교', '미국', '일본', '중국', '유럽',
])

/** 자동완성 텍스트에서 의미 있는 단어 추출. 한글 2자+ / 영문 3자+. */
function extractWords(s: string): string[] {
  if (!s) return []
  const tokens = s
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0)
  return tokens.filter((w) => {
    if (STOPWORDS.has(w)) return false
    if (/^\d+$/.test(w)) return false
    const ko = /[ㄱ-힝]/.test(w)
    if (ko) return w.length >= 2
    return w.length >= 3
  })
}

export async function buildMarketSignalContext(opts?: {
  days?: number
  limit?: number
}): Promise<SignalContext> {
  const days = opts?.days ?? 7
  const limit = opts?.limit ?? 12
  const since = new Date(Date.now() - days * 86400_000).toISOString()
  const admin = createAdminClient()

  const { data } = await admin
    .from('jimscanner_market_raw')
    .select('source, title, source_url, query, metadata, captured_at')
    .gte('captured_at', since)
    .order('captured_at', { ascending: false })
    .limit(5000)
  const rows = (data ?? []) as RawRow[]

  // 1) 정부 공지 — kca_press 전부 + naver_news 의 query 가 GOV_NEWS_QUERIES 에 속한 것
  const govSet = new Set<string>(GOV_NEWS_QUERIES)
  const gov: GovItem[] = []
  const govSeen = new Set<string>()
  for (const r of rows) {
    const isGov =
      r.source === 'kca_press' ||
      (r.source === 'naver_news' && r.query && govSet.has(r.query))
    if (!isGov || !r.title) continue
    const dedup = `${r.source}::${r.title}`
    if (govSeen.has(dedup)) continue
    govSeen.add(dedup)
    gov.push({
      source: r.source,
      title: r.title,
      url: r.source_url,
      query: r.query,
      captured_at: r.captured_at,
    })
    if (gov.length >= limit) break
  }

  // 2) 인기 자동완성 query (seed 별 빈도)
  const queryFreq = new Map<string, number>()
  for (const r of rows) {
    if (r.source !== 'google_suggest' || !r.query) continue
    queryFreq.set(r.query, (queryFreq.get(r.query) ?? 0) + 1)
  }
  const top_suggest_queries = [...queryFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([query, count]) => ({ query, count }))

  // 3) 자동완성 텍스트의 단어 빈도 (의미 있는 단어만)
  const wordFreq = new Map<string, number>()
  for (const r of rows) {
    if (r.source !== 'google_suggest' || !r.title) continue
    for (const w of extractWords(r.title)) {
      wordFreq.set(w, (wordFreq.get(w) ?? 0) + 1)
    }
  }
  const top_suggestion_words = [...wordFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([word, count]) => ({ word, count }))

  // 4) 최근 핫딜 (퀘이사존)
  const deals: DealItem[] = rows
    .filter((r) => r.source === 'quasarzone_sale' && r.title)
    .slice(0, limit)
    .map((r) => ({
      title: r.title as string,
      site_label: (r.metadata as { site_label?: string } | null)?.site_label ?? null,
      url: r.source_url,
    }))

  // 5) 최근 블로그 후기 query 빈도 (naver_blog)
  const blogFreq = new Map<string, number>()
  for (const r of rows) {
    if (r.source !== 'naver_blog' || !r.query) continue
    blogFreq.set(r.query, (blogFreq.get(r.query) ?? 0) + 1)
  }
  const blog_queries = [...blogFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([query, count]) => ({ query, count }))

  // 텍스트 직렬화 (LLM 입력용)
  const lines: string[] = []
  lines.push(`# 짐스캐너 시장 시그널 (최근 ${days}일)`)
  lines.push('')

  if (gov.length > 0) {
    lines.push('## 🏛️ 정부 공지·보도 (글감 직결)')
    for (const g of gov) {
      const tag = g.source === 'kca_press' ? '[소비자원]' : `[정부 키워드: ${g.query ?? ''}]`
      lines.push(`- ${tag} ${g.title}`)
    }
    lines.push('')
  }

  if (top_suggest_queries.length > 0) {
    lines.push('## 🔎 자동완성이 풍부한 시드 query (TOP)')
    for (const q of top_suggest_queries) lines.push(`- ${q.query} (자동완성 ${q.count}개)`)
    lines.push('')
  }

  if (top_suggestion_words.length > 0) {
    lines.push('## 🧩 자동완성에 자주 등장한 키워드 단어')
    lines.push(top_suggestion_words.map((w) => `${w.word}×${w.count}`).join(' · '))
    lines.push('')
  }

  if (deals.length > 0) {
    lines.push('## ⚡ 최근 핫딜 (퀘이사존, 사이트 라벨로 카테고리 신호)')
    for (const d of deals) {
      const lbl = d.site_label ? `[${d.site_label}] ` : ''
      lines.push(`- ${lbl}${d.title}`)
    }
    lines.push('')
  }

  if (blog_queries.length > 0) {
    lines.push('## 📓 네이버 블로그에서 활발한 직구 후기 query')
    for (const b of blog_queries) lines.push(`- ${b.query} (글 ${b.count}개)`)
    lines.push('')
  }

  return {
    text: lines.join('\n'),
    raw: { gov, top_suggest_queries, top_suggestion_words, deals, blog_queries },
    meta: {
      days,
      fetched_at: new Date().toISOString(),
      counts: {
        rows_total: rows.length,
        gov: gov.length,
        suggest_queries: top_suggest_queries.length,
        deals: deals.length,
      },
    },
  }
}

/** 24h 내 새로 들어온 정부 공지 수 — 배지 표시용. */
export async function countNewGovItemsLast24h(): Promise<number> {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString()
  const admin = createAdminClient()

  const { count: kcaCount } = await admin
    .from('jimscanner_market_raw')
    .select('id', { count: 'exact', head: true })
    .eq('source', 'kca_press')
    .gte('captured_at', since)

  const { data: govNews } = await admin
    .from('jimscanner_market_raw')
    .select('id, query')
    .eq('source', 'naver_news')
    .gte('captured_at', since)
    .in('query', [...GOV_NEWS_QUERIES])

  return (kcaCount ?? 0) + (govNews?.length ?? 0)
}
