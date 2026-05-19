import Link from 'next/link'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { createAdminClient } from '@/lib/auth/admin-supabase'
import ResolveButton from './ResolveButton'

export const dynamic = 'force-dynamic'

interface FindingRow {
  id: string
  target_kind: 'pin' | 'ggsan_product' | 'trend_product' | 'trend_keyword'
  target_id: string
  target_label: string | null
  rule_id: string
  matched_text: string
  severity: 'low' | 'medium' | 'high' | 'critical'
  action: 'block' | 'warn' | 'require_doc'
  detected_at: string
  resolved_at: string | null
  resolved_by: string | null
  resolution_note: string | null
}

interface RuleRow {
  rule_id: string
  domain: string
  rule_name: string
  required_disclaimer: string | null
  reference_url: string | null
}

const DOMAINS = ['약사법','식약처건강기능식품','의료기기법','화장품법','표시광고법','공정위'] as const

const KIND_LABEL: Record<string, string> = {
  pin: '핀',
  ggsan_product: 'ggsan 상품',
  trend_product: '트렌드 상품',
  trend_keyword: '트렌드 키워드',
}

const SEVERITY_COLOR: Record<string, string> = {
  critical: 'bg-red-200 text-red-900 border-red-300',
  high: 'bg-red-100 text-red-800 border-red-200',
  medium: 'bg-amber-100 text-amber-800 border-amber-200',
  low: 'bg-gray-100 text-gray-700 border-gray-200',
}

const ACTION_LABEL: Record<string, string> = {
  block: '차단',
  warn: '주의',
  require_doc: '면책문구 강제',
}

async function fetchData(opts: { domain: string; showResolved: boolean }) {
  const sb = createAdminClient()
  // service-role 클라이언트 + 신규 테이블 → 타입 미생성. as any 캐스팅.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sbAny = sb as any

  const [rulesRes, findingsRes] = await Promise.all([
    sbAny
      .from('jimscanner_compliance_rules')
      .select('rule_id, domain, rule_name, required_disclaimer, reference_url, is_active')
      .eq('is_active', true)
      .order('domain'),
    (() => {
      let q = sbAny
        .from('jimscanner_compliance_findings')
        .select('*')
        .order('detected_at', { ascending: false })
        .limit(500)
      if (!opts.showResolved) q = q.is('resolved_at', null)
      return q
    })(),
  ])

  const rules = (rulesRes.data ?? []) as RuleRow[]
  let findings = (findingsRes.data ?? []) as FindingRow[]

  const rulesById = new Map(rules.map((r) => [r.rule_id, r]))
  if (opts.domain) {
    findings = findings.filter((f) => rulesById.get(f.rule_id)?.domain === opts.domain)
  }

  // 도메인별 카운트 (미해제만)
  const domainCounts: Record<string, number> = {}
  const { data: allOpen } = await sbAny
    .from('jimscanner_compliance_findings')
    .select('rule_id')
    .is('resolved_at', null)
  for (const r of (allOpen ?? []) as { rule_id: string }[]) {
    const dom = rulesById.get(r.rule_id)?.domain
    if (dom) domainCounts[dom] = (domainCounts[dom] ?? 0) + 1
  }

  return { rules, rulesById, findings, domainCounts }
}

export default async function ComplianceGatePage({
  searchParams,
}: {
  searchParams: Promise<{ domain?: string; resolved?: string }>
}) {
  const sp = await searchParams
  const domain = sp.domain ?? ''
  const showResolved = sp.resolved === '1'

  const { rules, rulesById, findings, domainCounts } = await fetchData({ domain, showResolved })

  const totalOpen = Object.values(domainCounts).reduce((a, b) => a + b, 0)

  function buildHref(override: Record<string, string | null>): string {
    const params = new URLSearchParams()
    if (domain) params.set('domain', domain)
    if (showResolved) params.set('resolved', '1')
    for (const [k, v] of Object.entries(override)) {
      if (v == null || v === '') params.delete(k)
      else params.set(k, v)
    }
    const qs = params.toString()
    return '/admin/trend-radar/compliance' + (qs ? `?${qs}` : '')
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">표시광고·식약처 컴플라이언스 게이트</h1>
          <p className="text-sm text-gray-500 mt-1">
            한국 규제 사전(약사법·식약처·표시광고법·공정위 등)으로 핀·ggsan·트렌드 후보를 자동 스캔.{' '}
            <strong>미해제 위반 {totalOpen.toLocaleString()}건</strong> · 활성 룰 {rules.length}개
          </p>
        </div>
        <Link href="/admin/trend-radar" className="text-sm text-gray-700 hover:text-black underline">
          ← 대시보드
        </Link>
      </header>

      {/* 도메인 탭 */}
      <nav className="flex flex-wrap gap-1 border-b border-gray-200">
        <Link
          href={buildHref({ domain: null })}
          className={`px-3 py-2 text-sm border-b-2 ${domain === '' ? 'border-red-500 font-semibold' : 'border-transparent text-gray-500 hover:text-black'}`}
        >
          전체 <span className="text-xs text-gray-400">{totalOpen}</span>
        </Link>
        {DOMAINS.map((d) => (
          <Link
            key={d}
            href={buildHref({ domain: d })}
            className={`px-3 py-2 text-sm border-b-2 ${domain === d ? 'border-red-500 font-semibold' : 'border-transparent text-gray-500 hover:text-black'}`}
          >
            {d}{' '}
            {domainCounts[d] ? (
              <span className="ml-1 text-xs text-red-600 font-bold">{domainCounts[d]}</span>
            ) : (
              <span className="ml-1 text-xs text-gray-400">0</span>
            )}
          </Link>
        ))}
      </nav>

      <div className="flex items-center gap-3 text-xs">
        <Link
          href={buildHref({ resolved: showResolved ? null : '1' })}
          className={`px-3 py-1 rounded ${showResolved ? 'bg-gray-200 text-gray-800 font-semibold' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
        >
          {showResolved ? '✓ 해제 포함' : '해제 포함'}
        </Link>
        <span className="text-gray-500">표시 {findings.length}건 (최대 500)</span>
      </div>

      {findings.length === 0 ? (
        <div className="rounded border border-dashed border-gray-300 p-12 text-center text-gray-500">
          {showResolved ? '해제 이력 포함 결과 없음' : '미해제 위반 없음 — 클린 상태'}
        </div>
      ) : (
        <div className="rounded border border-gray-200 divide-y divide-gray-100">
          <div className="px-4 py-2 bg-gray-50 grid grid-cols-12 text-xs font-semibold text-gray-600">
            <div className="col-span-1">분류</div>
            <div className="col-span-2">도메인 / 룰</div>
            <div className="col-span-4">대상</div>
            <div className="col-span-2">매칭 표현</div>
            <div className="col-span-1">심각도</div>
            <div className="col-span-2 text-right">액션</div>
          </div>
          {findings.map((f) => {
            const rule = rulesById.get(f.rule_id)
            return (
              <div
                key={f.id}
                className={`px-4 py-3 grid grid-cols-12 items-start text-sm gap-2 ${f.resolved_at ? 'opacity-50' : ''}`}
              >
                <div className="col-span-1">
                  <span className="inline-block px-1.5 py-0.5 text-xs bg-gray-100 text-gray-700 rounded">
                    {KIND_LABEL[f.target_kind] ?? f.target_kind}
                  </span>
                </div>
                <div className="col-span-2">
                  <div className="text-xs font-semibold text-gray-800">{rule?.domain ?? '?'}</div>
                  <div className="text-xs text-gray-500 mt-0.5">{rule?.rule_name ?? '?'}</div>
                </div>
                <div className="col-span-4">
                  <div className="text-sm font-medium line-clamp-2" title={f.target_label ?? ''}>
                    {f.target_label || <span className="text-gray-400">(라벨 없음)</span>}
                  </div>
                  <div className="text-xs text-gray-400 font-mono mt-0.5 line-clamp-1">
                    {f.target_id}
                  </div>
                </div>
                <div className="col-span-2">
                  <span className="inline-block px-2 py-0.5 text-xs bg-yellow-100 text-yellow-900 rounded font-mono">
                    {f.matched_text}
                  </span>
                </div>
                <div className="col-span-1">
                  <span className={`inline-block px-2 py-0.5 text-xs rounded border ${SEVERITY_COLOR[f.severity] ?? ''}`}>
                    {f.severity}
                  </span>
                </div>
                <div className="col-span-2 text-right space-y-1">
                  <div className="text-xs font-semibold text-gray-700">{ACTION_LABEL[f.action]}</div>
                  {f.resolved_at ? (
                    <div className="text-xs text-gray-400">
                      해제 {f.resolved_at.slice(0, 10)}
                      {f.resolution_note && (
                        <div className="text-xs text-gray-500 mt-0.5" title={f.resolution_note}>
                          {f.resolution_note.slice(0, 30)}
                        </div>
                      )}
                    </div>
                  ) : (
                    <ResolveButton findingId={f.id} />
                  )}
                </div>
                {rule?.required_disclaimer && !f.resolved_at && (
                  <div className="col-span-12 mt-2 px-3 py-2 bg-blue-50 border border-blue-200 rounded text-xs text-blue-900">
                    <strong>필수 면책문구:</strong> {rule.required_disclaimer}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      <details className="rounded border border-gray-200 p-3">
        <summary className="text-sm font-medium cursor-pointer text-gray-700">
          활성 룰셋 ({rules.length}개)
        </summary>
        <div className="mt-3 divide-y divide-gray-100 text-sm">
          {rules.map((r) => (
            <div key={r.rule_id} className="py-2">
              <div className="flex items-baseline gap-2">
                <span className="text-xs font-semibold text-gray-700">{r.domain}</span>
                <span className="text-sm">{r.rule_name}</span>
              </div>
              {r.required_disclaimer && (
                <div className="text-xs text-gray-500 mt-1">→ {r.required_disclaimer}</div>
              )}
            </div>
          ))}
        </div>
      </details>
    </div>
  )
}
