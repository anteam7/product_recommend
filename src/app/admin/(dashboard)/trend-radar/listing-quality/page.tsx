import Link from 'next/link'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

interface QualityRow {
  goods_no: string
  title: string
  cate_cd: string | null
  cate_label: string | null
  price_krw: number | null
  image_url: string | null
  detail_url: string | null
  is_imminent: boolean
  last_seen_at: string
  image_score: number
  title_score: number
  overall_score: number
  gate: 'go' | 'fix' | 'reshoot' | 'unscored'
  issues: Array<{ code: string; label: string; dim: 'image' | 'title'; weight: number }>
  computed_at: string | null
  scorer_version: string | null
}

const GATE_OPTIONS = [
  { v: '', label: '전체' },
  { v: 'go', label: '🟢 바로 업로드 (go)' },
  { v: 'fix', label: '🟡 보강 필요 (fix)' },
  { v: 'reshoot', label: '🔴 재촬영 (reshoot)' },
  { v: 'unscored', label: '⚪ 미채점' },
] as const

async function fetchRows(gate: string): Promise<{ rows: QualityRow[]; error: string | null }> {
  const sb = createAdminClient()
  // 뷰는 generated types 미반영 — `as any` 캐스팅. supabase/sku_listing_quality.sql 적용 전제.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const q = (sb as any)
    .from('jimscanner_ggsan_listing_quality_v')
    .select(
      'goods_no, title, cate_cd, cate_label, price_krw, image_url, detail_url, is_imminent, last_seen_at, image_score, title_score, overall_score, gate, issues, computed_at, scorer_version',
    )
    .order('overall_score', { ascending: true })
    .limit(300)

  const { data, error } = await q
  if (error) return { rows: [], error: error.message as string }
  let rows = (data ?? []) as QualityRow[]
  if (gate) rows = rows.filter((r) => r.gate === gate)
  return { rows, error: null }
}

function buildHref(current: Record<string, string>, override: Record<string, string | null>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(current)) if (v) params.set(k, v)
  for (const [k, v] of Object.entries(override)) {
    if (v == null || v === '') params.delete(k)
    else params.set(k, v)
  }
  const qs = params.toString()
  return '/admin/trend-radar/listing-quality' + (qs ? `?${qs}` : '')
}

function gateBadge(gate: QualityRow['gate']) {
  switch (gate) {
    case 'go':
      return <span className="bg-emerald-100 text-emerald-800 text-xs font-semibold px-2 py-0.5 rounded">🟢 go</span>
    case 'fix':
      return <span className="bg-amber-100 text-amber-800 text-xs font-semibold px-2 py-0.5 rounded">🟡 fix</span>
    case 'reshoot':
      return <span className="bg-red-100 text-red-800 text-xs font-semibold px-2 py-0.5 rounded">🔴 reshoot</span>
    default:
      return <span className="bg-gray-100 text-gray-600 text-xs font-semibold px-2 py-0.5 rounded">⚪ unscored</span>
  }
}

export default async function ListingQualityPage({
  searchParams,
}: {
  searchParams: Promise<{ gate?: string }>
}) {
  const sp = await searchParams
  const gate = (sp.gate ?? '').trim()
  const current: Record<string, string> = { gate }

  const { rows, error } = await fetchRows(gate)

  const total = rows.length
  const goCount = rows.filter((r) => r.gate === 'go').length
  const fixCount = rows.filter((r) => r.gate === 'fix').length
  const reshootCount = rows.filter((r) => r.gate === 'reshoot').length
  const unscoredCount = rows.filter((r) => r.gate === 'unscored').length
  const avgOverall =
    rows.length > 0 ? rows.reduce((s, r) => s + Number(r.overall_score ?? 0), 0) / rows.length : 0

  // 이슈 토픽 차트 (issue.code 별 카운트)
  const issueTopics = new Map<string, { label: string; dim: string; count: number }>()
  for (const r of rows) {
    for (const issue of r.issues ?? []) {
      const key = issue.code
      const prev = issueTopics.get(key)
      if (prev) prev.count += 1
      else issueTopics.set(key, { label: issue.label, dim: issue.dim, count: 1 })
    }
  }
  const topIssues = Array.from(issueTopics.entries())
    .map(([code, v]) => ({ code, ...v }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)
  const maxIssueCount = topIssues[0]?.count ?? 1

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">🛡 리스팅 적합도 게이트</h1>
          <p className="text-sm text-gray-500 mt-1">
            SKU 단위 이미지·제목 점수 → 바로 업로드(go) / 보강(fix) / 재촬영(reshoot) 3등급.
            추천 보드의 quality_gate 컬럼에 조인되어 낮은 점수 SKU 는 자동 보류된다.
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 안내 */}
      <div className="rounded border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-900">
        <strong>스코어러:</strong> heuristic-v1 — 비전 LLM 보강 전. 이미지: 호스트·확장자·해상도 단서·워터마크 키워드.
        제목: 길이·한글 비율·금칙어·중복어·옵션 괄호 수. 실행:
        <code className="font-mono text-[11px] ml-1">node --env-file=.env.local scripts/score-listing-quality.mjs</code>
      </div>

      {/* 필터 */}
      <div className="rounded border border-gray-200 px-4 py-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-gray-500">게이트</span>
          {GATE_OPTIONS.map((g) => (
            <Link
              key={g.v}
              href={buildHref(current, { gate: g.v || null })}
              className={`px-3 py-1 text-xs rounded ${
                gate === g.v ? 'bg-black text-white font-semibold' : 'text-gray-500 hover:text-black'
              }`}
            >
              {g.label}
            </Link>
          ))}
        </div>
      </div>

      {/* KPI */}
      <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Kpi label="필터링 결과" value={total} />
        <Kpi label="🟢 go" value={goCount} highlight={goCount > 0} tone="emerald" />
        <Kpi label="🟡 fix" value={fixCount} tone="amber" />
        <Kpi label="🔴 reshoot" value={reshootCount} tone="red" />
        <Kpi label="평균 overall" value={avgOverall.toFixed(2)} />
      </section>

      {/* 이슈 토픽 차트 */}
      {topIssues.length > 0 && (
        <section className="rounded border border-gray-200 p-4 space-y-3">
          <div className="text-sm font-semibold">📊 이슈 토픽 분포 (필터 기준 상위 8개)</div>
          <div className="space-y-1.5">
            {topIssues.map((it) => (
              <div key={it.code} className="flex items-center gap-3 text-xs">
                <div className="w-40 truncate" title={it.label}>
                  <span
                    className={`inline-block w-2 h-2 rounded-full mr-1.5 align-middle ${
                      it.dim === 'image' ? 'bg-purple-400' : 'bg-cyan-400'
                    }`}
                  />
                  {it.label}
                </div>
                <div className="flex-1 bg-gray-100 rounded h-3 overflow-hidden">
                  <div
                    className={`h-3 ${it.dim === 'image' ? 'bg-purple-400' : 'bg-cyan-400'}`}
                    style={{ width: `${(it.count / maxIssueCount) * 100}%` }}
                  />
                </div>
                <div className="w-10 text-right font-mono text-gray-600">{it.count}</div>
              </div>
            ))}
          </div>
          <div className="text-[11px] text-gray-500">
            💡 동일 코드가 많이 잡히면 cron 스크립트의 임계값이 너무 빡빡하거나, 도매몰 표준 자체가
            낮다는 신호. 비전 LLM 보강 시 우선 검증할 코드.
          </div>
        </section>
      )}

      {/* 에러 */}
      {error && (
        <div className="rounded border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 space-y-1">
          <div>
            DB 에러: <code className="font-mono text-xs">{error}</code>
          </div>
          <div className="text-xs">
            <code>supabase/sku_listing_quality.sql</code> 적용 + 최소 1회{' '}
            <code className="font-mono">scripts/score-listing-quality.mjs</code> 실행 필요.
          </div>
        </div>
      )}

      {/* 결과 카드 */}
      {!error && rows.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500 space-y-2">
          <div className="text-base font-medium">조건에 맞는 SKU 없음</div>
          <div className="text-xs text-gray-400">
            아직 채점된 SKU 가 없다면{' '}
            <code className="font-mono">node --env-file=.env.local scripts/score-listing-quality.mjs</code> 실행.
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <div
              key={r.goods_no}
              className={`block rounded border overflow-hidden ${
                r.gate === 'reshoot'
                  ? 'border-red-200 bg-red-50/40'
                  : r.gate === 'fix'
                    ? 'border-amber-200 bg-amber-50/30'
                    : r.gate === 'go'
                      ? 'border-emerald-200 bg-emerald-50/30'
                      : 'border-gray-200'
              }`}
            >
              <div className="flex items-start gap-3 p-3">
                {/* 이미지 */}
                <div className="w-24 h-24 bg-gray-100 rounded overflow-hidden flex-shrink-0 relative">
                  {r.image_url && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={r.image_url}
                      alt=""
                      loading="lazy"
                      className="w-full h-full object-cover"
                    />
                  )}
                  <div className="absolute bottom-0 left-0 right-0 bg-black/60 text-white text-[10px] px-1 py-0.5 text-center font-mono">
                    img {Number(r.image_score ?? 0).toFixed(1)}
                  </div>
                </div>

                {/* 본문 */}
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    {gateBadge(r.gate)}
                    <span className="text-xs text-gray-500">
                      {r.cate_label ?? r.cate_cd} · {r.goods_no}
                    </span>
                    {r.is_imminent && (
                      <span className="bg-red-100 text-red-700 text-[10px] px-1.5 py-0.5 rounded">임박</span>
                    )}
                  </div>
                  <div className="text-sm font-medium leading-snug" title={r.title}>
                    {r.detail_url ? (
                      <a
                        href={r.detail_url}
                        target="_blank"
                        rel="noopener"
                        className="hover:underline"
                      >
                        {r.title}
                      </a>
                    ) : (
                      r.title
                    )}
                  </div>
                  {/* 이슈 칩 */}
                  {r.issues && r.issues.length > 0 && (
                    <div className="flex flex-wrap gap-1 pt-1">
                      {r.issues.slice(0, 6).map((iss, idx) => (
                        <span
                          key={`${iss.code}-${idx}`}
                          className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${
                            iss.dim === 'image'
                              ? 'bg-purple-100 text-purple-800'
                              : 'bg-cyan-100 text-cyan-800'
                          }`}
                          title={`-${iss.weight} (${iss.code})`}
                        >
                          {iss.dim === 'image' ? '🖼' : '📝'} {iss.label}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {/* 점수 + 가격 */}
                <div className="text-right flex-shrink-0 space-y-1">
                  <div className="text-sm font-bold">
                    {r.price_krw ? (
                      `${r.price_krw.toLocaleString()}원`
                    ) : (
                      <span className="text-gray-400 text-xs">가격 X</span>
                    )}
                  </div>
                  <div className="text-2xl font-bold font-mono text-gray-800">
                    {Number(r.overall_score ?? 0).toFixed(1)}
                  </div>
                  <div className="text-[10px] text-gray-500 font-mono space-y-0.5">
                    <div>🖼 {Number(r.image_score ?? 0).toFixed(1)}</div>
                    <div>📝 {Number(r.title_score ?? 0).toFixed(1)}</div>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 공식 설명 */}
      <section className="text-xs text-gray-500 border-t border-gray-200 pt-4 space-y-1">
        <div className="font-semibold text-gray-700">📐 ListingQuality 공식 (heuristic-v1)</div>
        <code className="block bg-gray-50 px-3 py-2 rounded font-mono text-[11px] leading-relaxed">
          overall_score = (image_score + title_score) / 2
          <br />
          gate = image_score &lt; 3 OR title_score &lt; 3 → reshoot
          <br />
          {'     '}else overall ≥ 7.5 → go · overall ≥ 4.5 → fix · else reshoot
        </code>
        <div className="pt-2">
          <strong>다음 단계:</strong> 비전 LLM(워터마크·배경 단색·모델 노출·여백) → image_score 가중치 +
          recommend 보드의 final_score 에 (1 - reshoot_penalty) 곱셈으로 자동 보류.
        </div>
      </section>
    </div>
  )
}

function Kpi({
  label,
  value,
  highlight = false,
  tone,
}: {
  label: string
  value: number | string
  highlight?: boolean
  tone?: 'emerald' | 'amber' | 'red'
}) {
  const toneClass =
    tone === 'emerald'
      ? 'border-emerald-300 bg-emerald-50 text-emerald-800'
      : tone === 'amber'
        ? 'border-amber-300 bg-amber-50 text-amber-800'
        : tone === 'red'
          ? 'border-red-300 bg-red-50 text-red-800'
          : highlight
            ? 'border-emerald-300 bg-emerald-50'
            : 'border-gray-200'
  return (
    <div className={`rounded border p-3 ${toneClass}`}>
      <div className="text-xs opacity-80">{label}</div>
      <div className="text-2xl font-bold mt-1">
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  )
}
