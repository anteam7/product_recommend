'use client'

import { useEffect, useState, useCallback, useMemo } from 'react'
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

type MergedRow = {
  page: string
  gscClicks: number
  gscImpressions: number
  gscCtr: number
  gscPosition: number
  pageViews: number
  activeUsers: number
  bounceRate: number
  avgSessionSec: number
  hasGsc: boolean
  hasGa4: boolean
  diagnosis: string[]
}

type AnalyticsResponse = {
  range: { start: string; end: string; days: number }
  has_gsc: boolean
  has_ga4: boolean
  gsc_summary: { clicks: number; impressions: number; ctr: number; position: number }
  ga4_summary: {
    sessions: number
    activeUsers: number
    pageViews: number
    bounceRate: number
    avgSessionSec: number
  }
  channels: { channel: string; sessions: number; users: number }[]
  landings: { page: string; sessions: number; activeUsers: number }[]
  rows: MergedRow[]
  errors: string[]
}

const DAY_OPTIONS = [
  { value: 7, label: '최근 7일' },
  { value: 14, label: '최근 14일' },
  { value: 30, label: '최근 30일' },
  { value: 90, label: '최근 90일' },
]

const FILTERS = [
  { id: 'all', label: '전체', match: () => true },
  { id: 'ctr_leak', label: 'CTR 누수', match: (r: MergedRow) => r.diagnosis.includes('ctr_leak') || r.diagnosis.includes('clicks_dry') },
  { id: 'high_bounce', label: '이탈 높음', match: (r: MergedRow) => r.diagnosis.includes('high_bounce') || r.diagnosis.includes('short_stay') },
  { id: 'star', label: '잘 됨', match: (r: MergedRow) => r.diagnosis.includes('star') },
  { id: 'gsc_only', label: 'GSC만 (PV 없음)', match: (r: MergedRow) => r.hasGsc && !r.hasGa4 },
  { id: 'ga4_only', label: 'GA4만 (검색 미노출)', match: (r: MergedRow) => !r.hasGsc && r.hasGa4 },
] as const

type FilterId = typeof FILTERS[number]['id']

export default function AnalyticsApp() {
  const [days, setDays] = useState(30)
  const [data, setData] = useState<AnalyticsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<FilterId>('all')

  const load = useCallback(async (n: number) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/admin/analytics?days=${n}`, { cache: 'no-store' })
      const json = (await res.json()) as AnalyticsResponse | { error: string }
      if ('error' in json) {
        setError(json.error)
        setData(null)
      } else {
        setData(json)
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

  const filtered = useMemo(() => {
    if (!data) return []
    const f = FILTERS.find((x) => x.id === filter)?.match ?? (() => true)
    return data.rows.filter(f)
  }, [data, filter])

  const counts = useMemo(() => {
    if (!data) return {} as Record<FilterId, number>
    const out = {} as Record<FilterId, number>
    for (const f of FILTERS) {
      out[f.id] = data.rows.filter(f.match).length
    }
    return out
  }, [data])

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
        {data && (
          <span className="text-xs text-gray-500">
            {data.range.start} ~ {data.range.end}
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

      {data && (
        <>
          {/* 인증 경고 */}
          {!data.has_gsc && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              ⚠️ GSC 인증 정보 없음 — <code className="rounded bg-amber-100 px-1">GSC_SERVICE_ACCOUNT_JSON</code>{' '}
              env 또는 <code className="rounded bg-amber-100 px-1">gsc-key.json</code> 파일이 필요합니다.
            </div>
          )}
          {!data.has_ga4 && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              ⚠️ GA4 인증 정보 없음 — <code className="rounded bg-amber-100 px-1">GA4_SERVICE_ACCOUNT_JSON</code>{' '}
              env 또는 <code className="rounded bg-amber-100 px-1">ga4-key.json</code> 파일이 필요합니다.
            </div>
          )}
          {data.errors.map((err, i) => (
            <div key={i} className="rounded-md border border-rose-200 bg-rose-50 p-2 text-xs text-rose-800">
              {err}
            </div>
          ))}

          {/* 요약 */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <SummaryStat
              label="GSC 노출"
              value={data.gsc_summary.impressions.toLocaleString()}
              sub={`클릭 ${data.gsc_summary.clicks.toLocaleString()} · CTR ${(data.gsc_summary.ctr * 100).toFixed(2)}%`}
            />
            <SummaryStat
              label="GSC 평균순위"
              value={`${data.gsc_summary.position.toFixed(1)}위`}
            />
            <SummaryStat
              label="GA4 사용자"
              value={data.ga4_summary.activeUsers.toLocaleString()}
              sub={`세션 ${data.ga4_summary.sessions.toLocaleString()} · PV ${data.ga4_summary.pageViews.toLocaleString()}`}
            />
            <SummaryStat
              label="이탈률 / 평균체류"
              value={`${(data.ga4_summary.bounceRate * 100).toFixed(1)}%`}
              sub={`${Math.round(data.ga4_summary.avgSessionSec)}초`}
            />
          </div>

          {/* 채널 */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">🔀 유입 채널</CardTitle>
            </CardHeader>
            <CardContent>
              {data.channels.length === 0 ? (
                <p className="py-2 text-sm text-gray-500">데이터 없음</p>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
                  {data.channels.map((c) => (
                    <div key={c.channel} className="rounded-md border bg-gray-50 p-2 text-sm">
                      <div className="font-medium text-gray-900">{c.channel}</div>
                      <div className="text-xs text-gray-600">
                        세션 {c.sessions.toLocaleString()} · 사용자 {c.users.toLocaleString()}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* 유입 페이지 (랜딩) */}
          <LandingCard landings={data.landings} />


          {/* 필터 */}
          <div className="flex flex-wrap items-center gap-2">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilter(f.id)}
                className={
                  'rounded-md border px-3 py-1.5 text-xs font-medium transition ' +
                  (filter === f.id
                    ? 'border-blue-500 bg-blue-50 text-blue-700'
                    : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50')
                }
              >
                {f.label}
                <span className="ml-1.5 text-gray-400">({counts[f.id] ?? 0})</span>
              </button>
            ))}
          </div>

          {/* 매칭 테이블 */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">📄 페이지 매칭</CardTitle>
            </CardHeader>
            <CardContent>
              <MergedTable rows={filtered} />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}

function LandingCard({
  landings,
}: {
  landings: { page: string; sessions: number; activeUsers: number }[]
}) {
  const top = landings.slice(0, 20)
  const totalSessions = landings.reduce((s, l) => s + l.sessions, 0)
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">
          🚪 유입 페이지 Top{' '}
          <span className="ml-2 text-xs font-normal text-gray-500">
            (첫 진입 기준 · 총 세션 {totalSessions.toLocaleString()})
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {top.length === 0 ? (
          <p className="py-2 text-sm text-gray-500">데이터 없음</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-gray-500">
                  <th className="px-2 py-2 text-left font-medium">페이지</th>
                  <th className="px-2 py-2 text-right font-medium">세션 (유입)</th>
                  <th className="px-2 py-2 text-right font-medium">사용자</th>
                  <th className="px-2 py-2 text-right font-medium">비중</th>
                </tr>
              </thead>
              <tbody>
                {top.map((l, i) => {
                  const share = totalSessions > 0 ? l.sessions / totalSessions : 0
                  return (
                    <tr key={i} className="border-b last:border-0 hover:bg-gray-50">
                      <td className="px-2 py-2 font-mono text-xs text-gray-900">
                        <a
                          href={`https://jimscanner.co.kr${l.page}`}
                          target="_blank"
                          rel="noreferrer"
                          className="hover:text-blue-600 hover:underline"
                        >
                          {l.page || '(루트)'}
                        </a>
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums font-semibold text-gray-900">
                        {l.sessions.toLocaleString()}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums text-gray-700">
                        {l.activeUsers.toLocaleString()}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums text-gray-500">
                        {(share * 100).toFixed(1)}%
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function SummaryStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border bg-white p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="mt-1 text-xl font-bold text-gray-900">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-gray-500">{sub}</div>}
    </div>
  )
}

function MergedTable({ rows }: { rows: MergedRow[] }) {
  if (rows.length === 0) {
    return <p className="py-6 text-center text-sm text-gray-500">해당하는 페이지가 없습니다.</p>
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-xs text-gray-500">
            <th className="px-2 py-2 text-left font-medium">페이지</th>
            <th className="px-2 py-2 text-right font-medium" colSpan={4}>
              GSC
            </th>
            <th className="px-2 py-2 text-right font-medium" colSpan={4}>
              GA4
            </th>
            <th className="px-2 py-2 text-left font-medium">진단</th>
          </tr>
          <tr className="border-b text-xs text-gray-400">
            <th />
            <th className="px-2 py-1 text-right font-normal">노출</th>
            <th className="px-2 py-1 text-right font-normal">클릭</th>
            <th className="px-2 py-1 text-right font-normal">CTR</th>
            <th className="px-2 py-1 text-right font-normal">순위</th>
            <th className="px-2 py-1 text-right font-normal">PV</th>
            <th className="px-2 py-1 text-right font-normal">사용자</th>
            <th className="px-2 py-1 text-right font-normal">이탈</th>
            <th className="px-2 py-1 text-right font-normal">체류</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b last:border-0 hover:bg-gray-50">
              <td className="px-2 py-2 font-mono text-xs text-gray-900">
                <a
                  href={`https://jimscanner.co.kr${r.page}`}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:text-blue-600 hover:underline"
                >
                  {r.page || '(루트)'}
                </a>
              </td>
              <td className="px-2 py-2 text-right tabular-nums text-gray-700">
                {r.hasGsc ? r.gscImpressions.toLocaleString() : <span className="text-gray-300">—</span>}
              </td>
              <td className="px-2 py-2 text-right tabular-nums text-gray-700">
                {r.hasGsc ? r.gscClicks : <span className="text-gray-300">—</span>}
              </td>
              <td className="px-2 py-2 text-right tabular-nums">
                {r.hasGsc ? (
                  <span
                    className={
                      r.gscImpressions >= 100 && r.gscCtr < 0.015 ? 'font-semibold text-orange-700' : 'text-gray-700'
                    }
                  >
                    {(r.gscCtr * 100).toFixed(1)}%
                  </span>
                ) : (
                  <span className="text-gray-300">—</span>
                )}
              </td>
              <td className="px-2 py-2 text-right tabular-nums text-gray-700">
                {r.hasGsc ? r.gscPosition.toFixed(1) : <span className="text-gray-300">—</span>}
              </td>
              <td className="px-2 py-2 text-right tabular-nums text-gray-700">
                {r.hasGa4 ? r.pageViews.toLocaleString() : <span className="text-gray-300">—</span>}
              </td>
              <td className="px-2 py-2 text-right tabular-nums text-gray-700">
                {r.hasGa4 ? r.activeUsers.toLocaleString() : <span className="text-gray-300">—</span>}
              </td>
              <td className="px-2 py-2 text-right tabular-nums">
                {r.hasGa4 ? (
                  <span className={r.bounceRate >= 0.6 ? 'font-semibold text-rose-700' : 'text-gray-700'}>
                    {(r.bounceRate * 100).toFixed(0)}%
                  </span>
                ) : (
                  <span className="text-gray-300">—</span>
                )}
              </td>
              <td className="px-2 py-2 text-right tabular-nums text-gray-700">
                {r.hasGa4 ? `${Math.round(r.avgSessionSec)}초` : <span className="text-gray-300">—</span>}
              </td>
              <td className="px-2 py-2">
                <DiagnosisBadges tags={r.diagnosis} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function DiagnosisBadges({ tags }: { tags: string[] }) {
  if (tags.length === 0) return <span className="text-xs text-gray-300">—</span>
  const LABEL: Record<string, { text: string; cls: string }> = {
    ctr_leak: { text: 'CTR 누수', cls: 'bg-orange-100 text-orange-800 border-orange-200' },
    ctr_low: { text: 'CTR 낮음', cls: 'bg-orange-50 text-orange-700 border-orange-100' },
    clicks_dry: { text: '클릭 0', cls: 'bg-rose-100 text-rose-800 border-rose-200' },
    high_bounce: { text: '이탈 높음', cls: 'bg-rose-50 text-rose-700 border-rose-100' },
    short_stay: { text: '체류 짧음', cls: 'bg-amber-50 text-amber-700 border-amber-100' },
    star: { text: '⭐ 잘 됨', cls: 'bg-green-100 text-green-800 border-green-200' },
  }
  return (
    <div className="flex flex-wrap gap-1">
      {tags.map((t) => {
        const meta = LABEL[t]
        if (!meta) return null
        return (
          <Badge key={t} variant="outline" className={`text-[10px] ${meta.cls}`}>
            {meta.text}
          </Badge>
        )
      })}
    </div>
  )
}
