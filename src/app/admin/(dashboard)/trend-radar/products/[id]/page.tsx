import type { ReactNode } from 'react'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface ProductRow {
  id: string
  canonical_name: string
  category_top: string
  category_mid: string | null
  brand: string | null
  description: string | null
  intent_label: string | null
  llm_classified_at: string | null
  llm_model: string | null
  alias_count: number
  first_seen_at: string
  last_seen_at: string
}
interface AliasRow {
  alias: string
  alias_type: string
  source: string | null
  confidence: number
  classified_by: string | null
  created_at: string
}
interface ScoreRow {
  trend_score: number
  commerce_score: number
  supplier_score: number
  competition_score: number
  final_score: number
  score_components: any
  computed_at: string
}
interface EvidenceRow {
  raw_id: string
  source: string
  source_url: string | null
  title: string | null
  query: string | null
  metadata: any
  captured_at: string
  matched_alias: string | null
  matched_keyword: string | null
  signal_type: string | null
  signal_category: string | null
}

const EVIDENCE_DAYS = 30

// 출처 코드 → 사람이 읽는 라벨
const SOURCE_LABELS: Record<string, string> = {
  clien_park: '클리앙 파크',
  naver_news: '네이버 뉴스',
  naver_blog: '네이버 블로그',
  google_suggest: '구글 자동완성',
  quasarzone_sale: '퀘이사존 핫딜',
  kca_press: 'KCA 보도자료',
  '82cook': '82cook',
  dcinside: '디시인사이드',
}
function sourceLabel(source: string) {
  return SOURCE_LABELS[source] ?? source
}

async function fetchProduct(id: string) {
  const sb = createAdminClient()
  const [prodRes, aliasRes, scoreRes, evidenceRes] = await Promise.all([
    sb.from('jimscanner_trends_products').select('*').eq('id', id).single(),
    sb
      .from('jimscanner_trends_aliases')
      .select('alias, alias_type, source, confidence, classified_by, created_at')
      .eq('product_id', id)
      .order('confidence', { ascending: false }),
    sb
      .from('jimscanner_trends_scores')
      .select('trend_score, commerce_score, supplier_score, competition_score, final_score, score_components, computed_at')
      .eq('product_id', id)
      .order('computed_at', { ascending: false })
      .limit(30),
    // 근거 원문 드릴다운: alias → market_signals.keywords → raw_ids[] → market_raw 원문
    sb.rpc('get_product_evidence' as never, { p_product_id: id, p_days: EVIDENCE_DAYS } as never),
  ])

  if (prodRes.error || !prodRes.data) return null

  return {
    product: prodRes.data as ProductRow,
    aliases: (aliasRes.data ?? []) as AliasRow[],
    scoreHistory: (scoreRes.data ?? []) as ScoreRow[],
    evidence: ((evidenceRes.data ?? []) as unknown as EvidenceRow[]) ?? [],
  }
}

export default async function ProductDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const data = await fetchProduct(id)
  if (!data) notFound()
  const { product, aliases, scoreHistory, evidence } = data
  const latest = scoreHistory[0]

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <Link href="/admin/trend-radar" className="text-sm text-gray-500 hover:text-black">
            ← 대시보드
          </Link>
          <h1 className="text-2xl font-bold mt-1">{product.canonical_name}</h1>
          <p className="text-sm text-gray-500 mt-1">
            {product.brand ? <span className="text-black font-medium">{product.brand}</span> : null}
            {product.brand ? ' · ' : ''}
            카테고리: {product.category_top}
            {product.category_mid ? ` / ${product.category_mid}` : ''} · alias {product.alias_count}건
          </p>
          {(product.intent_label || product.description) && (
            <div className="mt-2 flex items-center gap-2 flex-wrap">
              {product.intent_label && (
                <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-700 font-medium">
                  🏷 {product.intent_label}
                </span>
              )}
              {product.description && (
                <span className="text-sm text-gray-700">{product.description}</span>
              )}
            </div>
          )}
          {product.llm_classified_at && (
            <p className="text-[10px] text-gray-400 mt-1 font-mono">
              LLM 분류: {product.llm_classified_at.slice(0, 19).replace('T', ' ')}
              {product.llm_model ? ` · ${product.llm_model}` : ''}
            </p>
          )}
        </div>
      </header>

      {/* 4점수 카드 */}
      {latest && (
        <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <ScoreCard label="final" value={latest.final_score} bold />
          <ScoreCard label="trend" value={latest.trend_score} />
          <ScoreCard label="commerce" value={latest.commerce_score} />
          <ScoreCard label="supplier" value={latest.supplier_score} />
          <ScoreCard label="competition" value={latest.competition_score} />
        </section>
      )}

      {/* score 시계열 (최근 30 row) */}
      {scoreHistory.length > 1 && (
        <section>
          <h2 className="text-sm font-semibold mb-2">점수 추이 (최근 {scoreHistory.length}회 산출)</h2>
          <div className="rounded border border-gray-200 overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-gray-500">
                <tr>
                  <th className="px-3 py-2 text-left">computed_at</th>
                  <th className="px-3 py-2 text-right">final</th>
                  <th className="px-3 py-2 text-right">trend</th>
                  <th className="px-3 py-2 text-right">commerce</th>
                  <th className="px-3 py-2 text-right">supplier</th>
                  <th className="px-3 py-2 text-right">competition</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {scoreHistory.map((s, i) => (
                  <tr key={i}>
                    <td className="px-3 py-1 font-mono text-gray-600">{s.computed_at?.slice(5, 19)}</td>
                    <td className="px-3 py-1 text-right font-bold">{s.final_score}</td>
                    <td className="px-3 py-1 text-right">{s.trend_score}</td>
                    <td className="px-3 py-1 text-right">{s.commerce_score}</td>
                    <td className="px-3 py-1 text-right">{s.supplier_score}</td>
                    <td className="px-3 py-1 text-right">{s.competition_score}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* score breakdown */}
      {latest?.score_components && (
        <section>
          <h2 className="text-sm font-semibold mb-2">최신 score components</h2>
          <pre className="rounded border border-gray-200 p-3 text-xs overflow-x-auto bg-gray-50">
            {JSON.stringify(latest.score_components, null, 2)}
          </pre>
        </section>
      )}

      {/* 근거 원문 (Evidence) — 점수 → 실제 발화/기사 추적 */}
      <EvidencePanel evidence={evidence} />

      {/* aliases */}
      <section>
        <h2 className="text-sm font-semibold mb-2">매핑된 alias ({aliases.length})</h2>
        <div className="rounded border border-gray-200 divide-y divide-gray-100">
          {aliases.map((a, i) => (
            <div key={i} className="grid grid-cols-12 px-3 py-2 text-sm items-center">
              <div className="col-span-7">{a.alias}</div>
              <div className="col-span-2 text-xs text-gray-500">{a.source ?? '—'}</div>
              <div className="col-span-2 text-xs text-gray-500">{a.classified_by ?? '—'}</div>
              <div className="col-span-1 text-right text-xs font-mono text-gray-600">
                {a.confidence?.toFixed(2)}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="text-xs text-gray-500">
        first_seen: {product.first_seen_at} · last_seen: {product.last_seen_at}
      </section>
    </div>
  )
}

function ScoreCard({ label, value, bold }: { label: string; value: number; bold?: boolean }) {
  return (
    <div className="rounded border border-gray-200 p-3 text-center">
      <div className="text-xs text-gray-500 uppercase">{label}</div>
      <div className={`mt-1 ${bold ? 'text-3xl font-bold' : 'text-2xl text-gray-700'}`}>
        {value}
      </div>
    </div>
  )
}

function snippet(meta: any): string | null {
  if (!meta || typeof meta !== 'object') return null
  const raw =
    meta.description ?? meta.snippet ?? meta.content ?? meta.summary ?? meta.body ?? null
  if (!raw || typeof raw !== 'string') return null
  const clean = raw.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
  if (!clean) return null
  return clean.length > 220 ? clean.slice(0, 220) + '…' : clean
}

function EvidencePanel({ evidence }: { evidence: EvidenceRow[] }) {
  if (!evidence.length) {
    return (
      <section>
        <h2 className="text-sm font-semibold mb-2">근거 원문 (Evidence)</h2>
        <div className="rounded border border-dashed border-gray-200 p-6 text-center text-sm text-gray-400">
          최근 {EVIDENCE_DAYS}일간 이 상품의 alias 와 매칭되는 수집 원문이 없습니다.
          <br />
          <span className="text-xs">
            (alias → market_signals.keywords → market_raw 추적 결과 0건 — 점수가 과거 시그널 또는
            도매/경쟁 지표에만 기댄 상태일 수 있음)
          </span>
        </div>
      </section>
    )
  }

  // 근거 충실도: 원문 건수 · 고유 출처 수 · 최근성(최신 captured_at)
  const total = evidence.length
  const sources = Array.from(new Set(evidence.map((e) => e.source)))
  const latest = evidence.reduce<string | null>(
    (acc, e) => (acc && acc > e.captured_at ? acc : e.captured_at),
    null,
  )
  const ageDays =
    latest != null
      ? Math.max(0, Math.round((Date.now() - new Date(latest).getTime()) / 86_400_000))
      : null

  // 출처별 그룹핑 (각 그룹 내 시간 역순)
  const groups = new Map<string, EvidenceRow[]>()
  for (const e of evidence) {
    const arr = groups.get(e.source) ?? []
    arr.push(e)
    groups.set(e.source, arr)
  }
  const orderedGroups = Array.from(groups.entries()).sort((a, b) => b[1].length - a[1].length)

  return (
    <section>
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <h2 className="text-sm font-semibold">
          근거 원문 (Evidence) <span className="text-gray-400 font-normal">최근 {EVIDENCE_DAYS}일</span>
        </h2>
        <div className="flex items-center gap-1.5 flex-wrap">
          <Badge tone="blue">원문 {total}건</Badge>
          <Badge tone="violet">고유 출처 {sources.length}개</Badge>
          {ageDays != null && (
            <Badge tone={ageDays <= 3 ? 'green' : ageDays <= 14 ? 'amber' : 'gray'}>
              {ageDays === 0 ? '오늘' : `최근성 ${ageDays}일 전`}
            </Badge>
          )}
        </div>
      </div>

      <div className="space-y-4">
        {orderedGroups.map(([source, rows]) => (
          <div key={source}>
            <div className="text-xs font-medium text-gray-500 mb-1.5 flex items-center gap-1.5">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-gray-300" />
              {sourceLabel(source)}
              <span className="text-gray-300">·</span>
              <span className="text-gray-400">{rows.length}건</span>
            </div>
            <div className="rounded border border-gray-200 divide-y divide-gray-100">
              {rows.map((e) => {
                const snip = snippet(e.metadata)
                return (
                  <div key={e.raw_id} className="px-3 py-2.5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        {e.source_url ? (
                          <a
                            href={e.source_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sm font-medium text-blue-700 hover:underline break-words"
                          >
                            {e.title || e.source_url}
                          </a>
                        ) : (
                          <span className="text-sm font-medium text-gray-800 break-words">
                            {e.title || '(제목 없음)'}
                          </span>
                        )}
                        {snip && <p className="text-xs text-gray-600 mt-1 leading-relaxed">{snip}</p>}
                        <div className="mt-1 flex items-center gap-1.5 flex-wrap text-[10px]">
                          {e.matched_keyword && (
                            <span className="px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 font-mono">
                              🔑 {e.matched_keyword}
                            </span>
                          )}
                          {e.signal_type && (
                            <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">
                              {e.signal_type}
                            </span>
                          )}
                          {e.matched_alias && e.matched_alias !== e.matched_keyword && (
                            <span className="text-gray-400">← alias “{e.matched_alias}”</span>
                          )}
                        </div>
                      </div>
                      <time className="text-[10px] font-mono text-gray-400 whitespace-nowrap shrink-0">
                        {e.captured_at?.slice(0, 16).replace('T', ' ')}
                      </time>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function Badge({
  children,
  tone,
}: {
  children: ReactNode
  tone: 'blue' | 'violet' | 'green' | 'amber' | 'gray'
}) {
  const tones: Record<string, string> = {
    blue: 'bg-blue-50 text-blue-700',
    violet: 'bg-violet-50 text-violet-700',
    green: 'bg-green-50 text-green-700',
    amber: 'bg-amber-50 text-amber-700',
    gray: 'bg-gray-100 text-gray-500',
  }
  return (
    <span className={`text-[11px] px-2 py-0.5 rounded font-medium ${tones[tone]}`}>{children}</span>
  )
}
