import Link from 'next/link'
import { revalidatePath } from 'next/cache'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { createAdminClient } from '@/lib/auth/admin-supabase'

export const dynamic = 'force-dynamic'

type CategoryTopEntry = { code: number; name: string | null; count: number }

interface PatternRow {
  id: string
  cluster_id: number
  label: string
  exemplar_reason: string
  fix_template: {
    summary?: string
    steps?: string[]
    payload_patch?: Record<string, unknown>
  }
  category_top: CategoryTopEntry[]
  sample_count: number
  recoverable_revenue_krw: number
  generated_at: string
}

interface RejectedListingRow {
  id: string
  registered_title: string
  display_category_code: number
  display_category_name: string | null
  list_price_krw: number
  rejection_reason: string | null
  cluster_id: number | null
  created_at: string
}

async function fetchPatterns(): Promise<PatternRow[]> {
  const sb = createAdminClient() as unknown as {
    from: (t: string) => ReturnType<ReturnType<typeof createAdminClient>['from']>
  }
  // 가장 최근 generated_at 의 patterns 만 노출 (히스토리 중 최신 batch)
  const { data: latest } = await sb
    .from('jimscanner_coupang_rejection_patterns')
    .select('generated_at')
    .order('generated_at', { ascending: false })
    .limit(1)
  const latestRows = (latest ?? []) as unknown as { generated_at: string }[]
  const latestAt = latestRows[0]?.generated_at
  if (!latestAt) return []
  const { data } = await sb
    .from('jimscanner_coupang_rejection_patterns')
    .select('*')
    .eq('generated_at', latestAt)
    .order('sample_count', { ascending: false })
  return ((data ?? []) as unknown as PatternRow[])
}

async function fetchRejectedWithCluster(): Promise<RejectedListingRow[]> {
  const sb = createAdminClient() as unknown as {
    from: (t: string) => ReturnType<ReturnType<typeof createAdminClient>['from']>
  }
  const { data: listings } = await sb
    .from('jimscanner_coupang_listings')
    .select('id, registered_title, display_category_code, display_category_name, list_price_krw, rejection_reason, created_at')
    .eq('status', 'REJECTED')
    .order('created_at', { ascending: false })
    .limit(200)
  const ls = ((listings ?? []) as unknown as Omit<RejectedListingRow, 'cluster_id'>[])
  if (ls.length === 0) return []
  const ids = ls.map((l) => l.id)
  const { data: assigns } = await sb
    .from('jimscanner_coupang_rejection_assignments')
    .select('listing_id, cluster_id')
    .in('listing_id', ids)
  const m = new Map<string, number>()
  for (const a of ((assigns ?? []) as unknown as { listing_id: string; cluster_id: number }[])) {
    m.set(a.listing_id, a.cluster_id)
  }
  return ls.map((l) => ({ ...l, cluster_id: m.get(l.id) ?? null }))
}

async function spawnNodeScript(scriptName: string, extraArgs: string[]) {
  const cwd = process.cwd()
  // path.join 으로 동적 구성 — Turbopack 의 정적 모듈 해석 회피
  const scriptPath = path.join(cwd, 'scripts', scriptName)
  const child = spawn('node', [scriptPath, ...extraArgs], {
    cwd,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  })
  child.unref()
}

async function repairCluster(formData: FormData) {
  'use server'
  const clusterId = formData.get('cluster_id')
  const dryRun = formData.get('dry_run') === '1'
  if (!clusterId) return
  const extra = ['--cluster', String(clusterId)]
  if (dryRun) extra.push('--dry-run')
  await spawnNodeScript('auto-repair-coupang.mjs', extra)
  revalidatePath('/admin/coupang-publish/rejections')
}

async function runClustering(formData: FormData) {
  'use server'
  const dryRun = formData.get('dry_run') === '1'
  const extra = dryRun ? ['--dry-run'] : []
  await spawnNodeScript('cluster-rejections.mjs', extra)
  revalidatePath('/admin/coupang-publish/rejections')
}

function fmtKRW(n: number | null | undefined) {
  if (!n) return '—'
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1)}억원`
  if (n >= 10_000) return `${(n / 10_000).toFixed(1)}만원`
  return `${n.toLocaleString()}원`
}

export default async function CoupangRejectionsPage() {
  const [patterns, rejected] = await Promise.all([fetchPatterns(), fetchRejectedWithCluster()])
  const maxSample = patterns.reduce((m, p) => Math.max(m, p.sample_count), 0) || 1
  const totalRecoverable = patterns.reduce((s, p) => s + (p.recoverable_revenue_krw ?? 0), 0)
  const totalReject = rejected.length
  const unclustered = rejected.filter((r) => r.cluster_id == null).length

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold">쿠팡 거절 사유 클러스터링</h1>
          <p className="text-sm text-gray-500 mt-1">
            REJECTED <strong>{totalReject}</strong>건 · 클러스터 <strong>{patterns.length}</strong>개 ·
            미할당 <strong>{unclustered}</strong>건 · 회수 가능 매출 추정{' '}
            <strong className="text-emerald-700">{fmtKRW(totalRecoverable)}</strong>
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/admin/coupang-publish"
            className="text-xs px-3 py-1.5 rounded bg-gray-100 text-gray-700 hover:bg-gray-200"
          >
            ← 등록 상품 관리
          </Link>
          <form action={runClustering}>
            <button
              type="submit"
              className="text-xs px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700"
            >
              재클러스터링 실행
            </button>
          </form>
        </div>
      </header>

      {patterns.length === 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded p-4 text-sm text-amber-900">
          아직 클러스터링 결과가 없습니다. <strong>재클러스터링 실행</strong> 버튼을 누르거나{' '}
          <code className="bg-amber-100 px-1.5 py-0.5 rounded">node scripts/cluster-rejections.mjs</code>{' '}
          를 수동 실행하세요.
        </div>
      )}

      {/* 클러스터별 카드 */}
      <div className="grid gap-4">
        {patterns.map((p) => {
          const barPct = Math.round((p.sample_count / maxSample) * 100)
          const hasPatch =
            p.fix_template?.payload_patch && Object.keys(p.fix_template.payload_patch).length > 0
          return (
            <div key={p.id} className="bg-white border rounded-lg p-5 shadow-sm">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-3 flex-wrap">
                    <span className="text-xs text-gray-400 font-mono">#{p.cluster_id}</span>
                    <h2 className="text-lg font-semibold text-gray-900">{p.label}</h2>
                    <span className="text-xs text-gray-500">샘플 {p.sample_count}건</span>
                    <span className="text-xs text-emerald-700">
                      회수 {fmtKRW(p.recoverable_revenue_krw)}
                    </span>
                  </div>
                  {/* 빈도 막대그래프 */}
                  <div className="mt-3 h-2 bg-gray-100 rounded overflow-hidden">
                    <div
                      className="h-full bg-rose-400"
                      style={{ width: `${barPct}%` }}
                    />
                  </div>
                  <p className="mt-3 text-sm text-gray-700">
                    <span className="text-gray-400 text-xs">대표 사유 · </span>
                    {p.exemplar_reason}
                  </p>

                  {/* 카테고리 분포 */}
                  {p.category_top.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {p.category_top.map((c) => (
                        <span
                          key={`${p.cluster_id}-${c.code}`}
                          className="text-[11px] px-2 py-0.5 rounded bg-gray-100 text-gray-700"
                        >
                          {c.name ?? c.code} <span className="text-gray-400">×{c.count}</span>
                        </span>
                      ))}
                    </div>
                  )}

                  {/* fix_template */}
                  <div className="mt-4 p-3 bg-blue-50 border border-blue-100 rounded">
                    <div className="text-[11px] text-blue-700 font-semibold mb-1">자동 수선 템플릿</div>
                    {p.fix_template?.summary ? (
                      <p className="text-sm text-blue-900">{p.fix_template.summary}</p>
                    ) : (
                      <p className="text-sm text-gray-500 italic">— summary 미생성 (OPENAI_API_KEY 필요)</p>
                    )}
                    {p.fix_template?.steps && p.fix_template.steps.length > 0 && (
                      <ol className="mt-2 text-xs text-blue-900 list-decimal list-inside space-y-0.5">
                        {p.fix_template.steps.map((s, i) => (
                          <li key={i}>{s}</li>
                        ))}
                      </ol>
                    )}
                    {hasPatch && (
                      <details className="mt-2">
                        <summary className="text-[11px] text-blue-700 cursor-pointer">payload_patch 미리보기</summary>
                        <pre className="mt-1 text-[10px] bg-white p-2 rounded border border-blue-100 overflow-x-auto max-h-40">
                          {JSON.stringify(p.fix_template.payload_patch, null, 2)}
                        </pre>
                      </details>
                    )}
                  </div>
                </div>

                {/* 액션 */}
                <div className="flex flex-col gap-2 shrink-0">
                  <form action={repairCluster}>
                    <input type="hidden" name="cluster_id" value={p.cluster_id} />
                    <button
                      type="submit"
                      disabled={!hasPatch}
                      className={`text-xs px-3 py-1.5 rounded w-full ${
                        hasPatch
                          ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                          : 'bg-gray-200 text-gray-400 cursor-not-allowed'
                      }`}
                    >
                      자동 수선 재등록
                    </button>
                  </form>
                  <form action={repairCluster}>
                    <input type="hidden" name="cluster_id" value={p.cluster_id} />
                    <input type="hidden" name="dry_run" value="1" />
                    <button
                      type="submit"
                      disabled={!hasPatch}
                      className={`text-xs px-3 py-1.5 rounded w-full ${
                        hasPatch
                          ? 'bg-white border border-emerald-300 text-emerald-700 hover:bg-emerald-50'
                          : 'bg-gray-100 text-gray-400 cursor-not-allowed border border-gray-200'
                      }`}
                    >
                      Dry-run (페이로드만)
                    </button>
                  </form>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* 클러스터별 멤버 리스팅 미리보기 */}
      {rejected.length > 0 && (
        <details className="bg-white border rounded p-4">
          <summary className="text-sm font-semibold text-gray-700 cursor-pointer">
            REJECTED 리스팅 전체 보기 ({rejected.length}건)
          </summary>
          <table className="w-full text-xs mt-3">
            <thead className="text-gray-500">
              <tr>
                <th className="text-left px-2 py-1 font-semibold">cluster</th>
                <th className="text-left px-2 py-1 font-semibold">상품명</th>
                <th className="text-left px-2 py-1 font-semibold">카테고리</th>
                <th className="text-right px-2 py-1 font-semibold">판매가</th>
                <th className="text-left px-2 py-1 font-semibold">거절 사유</th>
              </tr>
            </thead>
            <tbody>
              {rejected.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="px-2 py-1 font-mono">
                    {r.cluster_id != null ? `#${r.cluster_id}` : <span className="text-gray-300">—</span>}
                  </td>
                  <td className="px-2 py-1 text-gray-900 line-clamp-1">{r.registered_title}</td>
                  <td className="px-2 py-1 text-gray-500">{r.display_category_name ?? r.display_category_code}</td>
                  <td className="px-2 py-1 text-right tabular-nums">{r.list_price_krw?.toLocaleString() ?? '—'}</td>
                  <td className="px-2 py-1 text-rose-700 line-clamp-1">{r.rejection_reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  )
}
