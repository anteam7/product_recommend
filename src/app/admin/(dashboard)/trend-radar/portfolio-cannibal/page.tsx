import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'
import type { Tables } from '@/lib/supabase'
import CannibalHeatmap from './CannibalHeatmap'

export const dynamic = 'force-dynamic'

type PinRow = Tables<'jimscanner_trends_pins'>

interface PairRow {
  a_kw: string
  a_src: string
  b_kw: string
  b_src: string
  tj: number
  cov: number
  sov: number
  score: number
  reco: '유지' | '통합' | '회피'
}

interface RpcPair {
  pin_a_keyword: string
  pin_a_source: string
  pin_b_keyword: string
  pin_b_source: string
  token_jaccard: number
  category_overlap: number
  supplier_overlap: number
  cannibal_score: number
  recommendation: string
}

function tokenize(s: string): string[] {
  return Array.from(
    new Set(
      s
        .toLowerCase()
        .split(/[\s/,\-_]+/)
        .filter((t) => t.length >= 2),
    ),
  )
}

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const A = new Set(a)
  const B = new Set(b)
  let inter = 0
  for (const x of A) if (B.has(x)) inter++
  const union = new Set([...A, ...B]).size
  return union === 0 ? 0 : inter / union
}

function classify(score: number): '유지' | '통합' | '회피' {
  if (score >= 0.55) return '회피'
  if (score >= 0.3) return '통합'
  return '유지'
}

async function fetchData() {
  const sb = createAdminClient()

  const { data: pins } = await sb
    .from('jimscanner_trends_pins')
    .select('keyword, source, notes, pinned_at')
    .order('pinned_at', { ascending: false })

  const pinList = (pins ?? []) as PinRow[]

  // RPC 시도 — 적용 전이면 fallback.
  let rpcPairs: RpcPair[] | null = null
  try {
    const { data, error } = await (sb as any).rpc('jimscanner_pin_cannibal_pairs', {
      min_overlap: 0.1,
      days_window: 30,
    })
    if (!error && Array.isArray(data)) rpcPairs = data as RpcPair[]
  } catch {
    rpcPairs = null
  }

  if (rpcPairs && rpcPairs.length > 0) {
    const pairs: PairRow[] = rpcPairs.map((r) => ({
      a_kw: r.pin_a_keyword,
      a_src: r.pin_a_source,
      b_kw: r.pin_b_keyword,
      b_src: r.pin_b_source,
      tj: Number(r.token_jaccard) || 0,
      cov: Number(r.category_overlap) || 0,
      sov: Number(r.supplier_overlap) || 0,
      score: Number(r.cannibal_score) || 0,
      reco: (r.recommendation as PairRow['reco']) ?? classify(Number(r.cannibal_score) || 0),
    }))
    return { pins: pinList, pairs, mode: 'rpc' as const }
  }

  // Fallback: TS 측 계산 (token jaccard + category overlap)
  const keywords = pinList.map((p) => p.keyword)
  let catMap = new Map<string, Set<string>>()
  if (keywords.length > 0) {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    const { data: kws } = await sb
      .from('jimscanner_trends_keywords')
      .select('keyword, category_top, collected_at')
      .in('keyword', keywords)
      .gte('collected_at', cutoff)
      .limit(5000)
    for (const row of (kws ?? []) as Array<{ keyword: string; category_top: string | null }>) {
      if (!row.category_top) continue
      const k = row.keyword.toLowerCase()
      if (!catMap.has(k)) catMap.set(k, new Set())
      catMap.get(k)!.add(row.category_top)
    }
  }

  const enriched = pinList.map((p) => ({
    keyword: p.keyword,
    source: p.source,
    tokens: tokenize(p.keyword),
    cats: Array.from(catMap.get(p.keyword.toLowerCase()) ?? []),
  }))

  const pairs: PairRow[] = []
  for (let i = 0; i < enriched.length; i++) {
    for (let j = i + 1; j < enriched.length; j++) {
      const a = enriched[i]
      const b = enriched[j]
      const tj = jaccard(a.tokens, b.tokens)
      const cov = jaccard(a.cats, b.cats)
      const sov = 0
      const score = 0.55 * tj + 0.25 * cov + 0.2 * sov
      if (score < 0.1) continue
      pairs.push({
        a_kw: a.keyword,
        a_src: a.source,
        b_kw: b.keyword,
        b_src: b.source,
        tj,
        cov,
        sov,
        score,
        reco: classify(score),
      })
    }
  }
  pairs.sort((x, y) => y.score - x.score)
  return { pins: pinList, pairs, mode: 'fallback' as const }
}

export default async function PortfolioCannibalPage() {
  const { pins, pairs, mode } = await fetchData()

  const pinKeys = pins.map((p) => `${p.source}::${p.keyword}`)
  const scoreByPair = new Map<string, PairRow>()
  for (const p of pairs) {
    const k1 = `${p.a_src}::${p.a_kw}|${p.b_src}::${p.b_kw}`
    const k2 = `${p.b_src}::${p.b_kw}|${p.a_src}::${p.a_kw}`
    scoreByPair.set(k1, p)
    scoreByPair.set(k2, p)
  }

  const top = pairs.slice(0, 20)

  const summary = {
    pinCount: pins.length,
    pairCount: pairs.length,
    avoid: pairs.filter((p) => p.reco === '회피').length,
    merge: pairs.filter((p) => p.reco === '통합').length,
    keep: pairs.filter((p) => p.reco === '유지').length,
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold">포트폴리오 카니발리제이션 맵</h1>
          <p className="text-sm text-gray-500 mt-1">
            활성 핀끼리 Co-SERP·동일 구매자 의도 중첩 — 자기잠식 탐지.
            점수 = 0.55 · 토큰 Jaccard + 0.25 · 카테고리 중첩 + 0.20 · ggsan 공급원 중첩.
          </p>
          <p className="text-xs text-gray-400 mt-1">
            모드:{' '}
            <span className={mode === 'rpc' ? 'text-emerald-600' : 'text-amber-600'}>
              {mode === 'rpc' ? 'RPC (jimscanner_pin_cannibal_pairs)' : 'TS fallback — RPC 마이그레이션 미적용'}
            </span>
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {pins.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          핀이 없습니다. 먼저 트렌드 레이더에서 핀을 등록하세요.
        </div>
      ) : (
        <>
          <section className="grid grid-cols-5 gap-3 text-sm">
            <Stat label="활성 핀" value={summary.pinCount} />
            <Stat label="중첩 쌍 (≥0.10)" value={summary.pairCount} />
            <Stat label="회피 권고" value={summary.avoid} tone="bad" />
            <Stat label="통합 권고" value={summary.merge} tone="warn" />
            <Stat label="유지 권고" value={summary.keep} tone="ok" />
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-2">핀×핀 히트맵</h2>
            <CannibalHeatmap
              pinKeys={pinKeys}
              labels={pins.map((p) => p.keyword)}
              scoreByPair={Object.fromEntries(
                Array.from(scoreByPair.entries()).map(([k, v]) => [k, v.score]),
              )}
            />
          </section>

          <section>
            <h2 className="text-lg font-semibold mb-2">강한 중첩 쌍 Top 20</h2>
            {top.length === 0 ? (
              <p className="text-sm text-gray-500">중첩 쌍 없음 (임계값 0.10 이상).</p>
            ) : (
              <div className="overflow-x-auto rounded border border-gray-200">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-xs text-gray-500">
                    <tr>
                      <th className="px-3 py-2 text-left">핀 A</th>
                      <th className="px-3 py-2 text-left">핀 B</th>
                      <th className="px-3 py-2 text-right">토큰 J</th>
                      <th className="px-3 py-2 text-right">카테고리</th>
                      <th className="px-3 py-2 text-right">공급원</th>
                      <th className="px-3 py-2 text-right">카니발 점수</th>
                      <th className="px-3 py-2 text-center">권고</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {top.map((p, i) => (
                      <tr key={i} className="hover:bg-gray-50">
                        <td className="px-3 py-2">
                          <div className="font-medium">{p.a_kw}</div>
                          <div className="text-xs text-gray-400">{p.a_src}</div>
                        </td>
                        <td className="px-3 py-2">
                          <div className="font-medium">{p.b_kw}</div>
                          <div className="text-xs text-gray-400">{p.b_src}</div>
                        </td>
                        <td className="px-3 py-2 text-right font-mono">{p.tj.toFixed(3)}</td>
                        <td className="px-3 py-2 text-right font-mono">{p.cov.toFixed(3)}</td>
                        <td className="px-3 py-2 text-right font-mono">{p.sov.toFixed(3)}</td>
                        <td className="px-3 py-2 text-right font-mono font-semibold">
                          {p.score.toFixed(3)}
                        </td>
                        <td className="px-3 py-2 text-center">
                          <RecoBadge reco={p.reco} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}

function Stat({
  label,
  value,
  tone = 'neutral',
}: {
  label: string
  value: number
  tone?: 'neutral' | 'ok' | 'warn' | 'bad'
}) {
  const toneCls =
    tone === 'bad'
      ? 'text-rose-600'
      : tone === 'warn'
        ? 'text-amber-600'
        : tone === 'ok'
          ? 'text-emerald-600'
          : 'text-gray-900'
  return (
    <div className="rounded border border-gray-200 px-3 py-2">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`text-xl font-semibold mt-1 ${toneCls}`}>{value}</div>
    </div>
  )
}

function RecoBadge({ reco }: { reco: '유지' | '통합' | '회피' }) {
  const cls =
    reco === '회피'
      ? 'bg-rose-100 text-rose-700 border-rose-200'
      : reco === '통합'
        ? 'bg-amber-100 text-amber-700 border-amber-200'
        : 'bg-emerald-100 text-emerald-700 border-emerald-200'
  return (
    <span className={`inline-block rounded border px-2 py-0.5 text-xs font-medium ${cls}`}>
      {reco}
    </span>
  )
}
