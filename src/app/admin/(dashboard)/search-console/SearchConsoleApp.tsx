'use client'

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

type GscRow = {
  query?: string
  page?: string
  clicks: number
  impressions: number
  ctr: number
  position: number
}

type GscReport = {
  range: { start: string; end: string; days: number }
  summary: { clicks: number; impressions: number; ctr: number; position: number }
  queries: GscRow[]
  pages: GscRow[]
  opportunities: GscRow[]
  has_credentials: boolean
}

const DAY_OPTIONS = [
  { value: 7, label: '최근 7일' },
  { value: 14, label: '최근 14일' },
  { value: 30, label: '최근 30일' },
  { value: 90, label: '최근 90일' },
]

export default function SearchConsoleApp() {
  const [days, setDays] = useState(7)
  const [report, setReport] = useState<GscReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (n: number) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/admin/search-console?days=${n}`, { cache: 'no-store' })
      const data = (await res.json()) as GscReport | { error: string }
      if ('error' in data) {
        setError(data.error)
        setReport(null)
      } else {
        setReport(data)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(days)
  }, [days, load])

  return (
    <div className="space-y-6">
      {/* 컨트롤 */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-white p-3">
        <label className="text-sm font-medium">기간</label>
        <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DAY_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={String(o.value)}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {report && (
          <span className="text-xs text-gray-500">
            {report.range.start} ~ {report.range.end}
          </span>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => load(days)}
          disabled={loading}
          className="ml-auto"
        >
          {loading ? '불러오는 중...' : '🔄 새로고침'}
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">
          ⚠️ {error}
        </div>
      )}

      {report && !report.has_credentials && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-semibold">⚠️ Search Console 인증 정보 없음</p>
          <p className="mt-1">
            Vercel env <code className="rounded bg-amber-100 px-1">GSC_SERVICE_ACCOUNT_JSON</code>{' '}
            (base64 인코딩된 service account JSON) 또는 로컬{' '}
            <code className="rounded bg-amber-100 px-1">gsc-key.json</code> 파일이 필요합니다.
          </p>
        </div>
      )}

      {report && report.has_credentials && (
        <>
          {/* 요약 */}
          <div className="grid gap-3 sm:grid-cols-4">
            <SummaryStat label="총 클릭" value={report.summary.clicks.toLocaleString()} />
            <SummaryStat label="총 노출" value={report.summary.impressions.toLocaleString()} />
            <SummaryStat label="평균 CTR" value={`${(report.summary.ctr * 100).toFixed(2)}%`} />
            <SummaryStat label="평균 순위" value={`${report.summary.position.toFixed(1)}위`} />
          </div>

          {/* CTR 개선 기회 — 가장 가치 큼 */}
          <Card className="border-orange-200">
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">
                💡 CTR 개선 기회 — 노출 많은데 클릭 적음 (콘텐츠 보강 시 큰 효과)
              </CardTitle>
            </CardHeader>
            <CardContent>
              {report.opportunities.length === 0 ? (
                <p className="py-4 text-center text-sm text-gray-500">
                  기회 키워드가 없습니다 (노출 10+ AND CTR &lt; 2% 인 키워드).
                </p>
              ) : (
                <QueryTable
                  rows={report.opportunities}
                  showCreate
                  highlightOpportunity
                />
              )}
            </CardContent>
          </Card>

          {/* 검색어 Top */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">🔍 검색 키워드 Top 30</CardTitle>
            </CardHeader>
            <CardContent>
              <QueryTable rows={report.queries} showCreate />
            </CardContent>
          </Card>

          {/* 페이지별 성과 */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">📄 페이지별 성과 Top 20</CardTitle>
            </CardHeader>
            <CardContent>
              <PageTable rows={report.pages} />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}

function SummaryStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-white p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="mt-1 text-xl font-bold text-gray-900">{value}</div>
    </div>
  )
}

function QueryTable({
  rows,
  showCreate,
  highlightOpportunity,
}: {
  rows: GscRow[]
  showCreate?: boolean
  highlightOpportunity?: boolean
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-xs text-gray-500">
            <th className="px-2 py-2 text-left font-medium">검색어</th>
            <th className="px-2 py-2 text-right font-medium">클릭</th>
            <th className="px-2 py-2 text-right font-medium">노출</th>
            <th className="px-2 py-2 text-right font-medium">CTR</th>
            <th className="px-2 py-2 text-right font-medium">순위</th>
            {showCreate && <th className="px-2 py-2 text-right font-medium">액션</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const ctrPct = (r.ctr * 100).toFixed(1)
            const isOpp = highlightOpportunity || (r.impressions >= 10 && r.ctr < 0.02)
            const writeUrl =
              `/admin/blog?suggest_keyword=${encodeURIComponent(r.query ?? '')}` +
              `&category=${encodeURIComponent('가이드')}` +
              `&angle=${encodeURIComponent(`GSC: 노출 ${r.impressions} · CTR ${ctrPct}% · 평균 ${r.position.toFixed(1)}위 — 콘텐츠 보강 또는 신규 글`)}`
            return (
              <tr key={i} className={'border-b last:border-0 hover:bg-gray-50 ' + (isOpp ? 'bg-orange-50/30' : '')}>
                <td className="px-2 py-2 font-medium text-gray-900">{r.query ?? '-'}</td>
                <td className="px-2 py-2 text-right tabular-nums">{r.clicks}</td>
                <td className="px-2 py-2 text-right tabular-nums">{r.impressions.toLocaleString()}</td>
                <td className="px-2 py-2 text-right tabular-nums">
                  <span className={r.ctr < 0.02 && r.impressions >= 10 ? 'text-orange-700 font-semibold' : ''}>
                    {ctrPct}%
                  </span>
                </td>
                <td className="px-2 py-2 text-right tabular-nums">{r.position.toFixed(1)}</td>
                {showCreate && (
                  <td className="px-2 py-2 text-right">
                    <Button asChild variant="outline" size="sm" className="h-7 text-xs">
                      <Link href={writeUrl}>
                        ✏️ 글 작성
                      </Link>
                    </Button>
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function PageTable({ rows }: { rows: GscRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-xs text-gray-500">
            <th className="px-2 py-2 text-left font-medium">페이지</th>
            <th className="px-2 py-2 text-right font-medium">클릭</th>
            <th className="px-2 py-2 text-right font-medium">노출</th>
            <th className="px-2 py-2 text-right font-medium">CTR</th>
            <th className="px-2 py-2 text-right font-medium">순위</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const raw = r.page ?? ''
            const path = raw.startsWith('/')
              ? raw
              : (() => {
                  try { return new URL(raw).pathname || '/' } catch { return raw || '/' }
                })()
            const ctrPct = (r.ctr * 100).toFixed(1)
            const lowCtr = r.ctr < 0.02 && r.impressions >= 10
            return (
              <tr key={i} className="border-b last:border-0 hover:bg-gray-50">
                <td className="px-2 py-2">
                  <Link href={path} target="_blank" className="text-blue-600 hover:underline">
                    {path}
                  </Link>
                  {lowCtr && (
                    <Badge variant="outline" className="ml-2 border-orange-300 text-xs text-orange-700">
                      CTR ↑ 가능
                    </Badge>
                  )}
                </td>
                <td className="px-2 py-2 text-right tabular-nums">{r.clicks}</td>
                <td className="px-2 py-2 text-right tabular-nums">{r.impressions.toLocaleString()}</td>
                <td className="px-2 py-2 text-right tabular-nums">{ctrPct}%</td>
                <td className="px-2 py-2 text-right tabular-nums">{r.position.toFixed(1)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
