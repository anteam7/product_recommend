'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

export type ExtractedRate = {
  country: string
  center_name: string | null
  grade_level: number
  member_grade: string | null
  weight_min: number
  weight_max: number
  price_krw: number | null
  price_usd: number | null
  price_jpy: number | null
  shipping_type: string | null
}

export type ResultRow = {
  id: string
  run_id: string
  forwarder_id: string
  forwarder_slug: string
  forwarder_name: string
  status: string
  extracted_rates: ExtractedRate[] | null
  extracted_count: number
  ai_summary: string | null
  page_url: string | null
  error_message: string | null
  applied_at: string | null
  applied_by: string | null
  db_rate_count: number
  checked_at: string
}

function statusBadge(status: string) {
  const map: Record<string, string> = {
    extracted: 'bg-green-600',
    no_rates_found: 'bg-amber-500',
    error: 'bg-red-600',
    skipped: 'bg-gray-300 text-gray-700',
    no_change: 'bg-green-600',
    changed: 'bg-red-600',
    uncertain: 'bg-amber-500',
  }
  const labels: Record<string, string> = {
    extracted: '추출 완료',
    no_rates_found: '요금 없음',
    error: '오류',
    skipped: '생략',
    no_change: '(이전) 동일',
    changed: '(이전) 변동',
    uncertain: '(이전) 불확실',
  }
  return <Badge className={map[status] ?? 'bg-gray-500'}>{labels[status] ?? status}</Badge>
}

function formatRateValue(r: ExtractedRate): string {
  const parts: string[] = []
  if (r.price_krw != null) parts.push(`${r.price_krw.toLocaleString('ko-KR')}원`)
  if (r.price_usd != null) parts.push(`$${r.price_usd}`)
  if (r.price_jpy != null) parts.push(`¥${r.price_jpy.toLocaleString('ko-KR')}`)
  return parts.join(' / ') || '—'
}

export default function ResultsTable({ rows }: { rows: ResultRow[] }) {
  const router = useRouter()
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [applying, setApplying] = useState<Record<string, boolean>>({})
  const [rescanning, setRescanning] = useState<Record<string, boolean>>({})
  const [message, setMessage] = useState<Record<string, string>>({})

  const sorted = [...rows].sort((a, b) => {
    const order: Record<string, number> = {
      extracted: 0,
      no_rates_found: 1,
      error: 2,
      skipped: 3,
      no_change: 4,
      changed: 4,
      uncertain: 4,
    }
    const oa = order[a.status] ?? 5
    const ob = order[b.status] ?? 5
    if (oa !== ob) return oa - ob
    // extracted 안에서는 DB 대비 커버리지가 낮은 것부터 (조정 필요도 높음)
    if (a.status === 'extracted' && b.status === 'extracted') {
      const covA = a.db_rate_count > 0 ? a.extracted_count / a.db_rate_count : 0
      const covB = b.db_rate_count > 0 ? b.extracted_count / b.db_rate_count : 0
      return covA - covB
    }
    return a.forwarder_name.localeCompare(b.forwarder_name)
  })

  async function handleRescan(row: ResultRow) {
    setRescanning((s) => ({ ...s, [row.id]: true }))
    setMessage((s) => ({ ...s, [row.id]: '' }))
    try {
      const res = await fetch('/api/admin/rate-check/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'rescan',
          run_id: row.run_id,
          forwarder_id: row.forwarder_id,
        }),
      })
      const text = await res.text()
      let data: { ok?: boolean; error?: string; processed?: { extracted_count: number; status: string } }
      try {
        data = JSON.parse(text)
      } catch {
        throw new Error(`응답 파싱 실패 (${res.status}): ${text.slice(0, 120)}`)
      }
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      setMessage((s) => ({
        ...s,
        [row.id]: `✅ 재스캔: ${data.processed?.status} / ${data.processed?.extracted_count}건`,
      }))
      router.refresh()
    } catch (err) {
      setMessage((s) => ({
        ...s,
        [row.id]: `❌ ${err instanceof Error ? err.message : '오류'}`,
      }))
    } finally {
      setRescanning((s) => ({ ...s, [row.id]: false }))
    }
  }

  async function handleApply(row: ResultRow) {
    const coverage =
      row.db_rate_count > 0 ? Math.round((row.extracted_count / row.db_rate_count) * 100) : null
    const warning =
      coverage != null && coverage < 70
        ? `⚠️ 커버리지 ${coverage}% (DB ${row.db_rate_count} → 추출 ${row.extracted_count}). 부분 추출일 수 있습니다.\n\n`
        : ''
    if (
      !confirm(
        `${warning}"${row.forwarder_name}"의 shipping_rates ${row.db_rate_count}건을 추출된 ${row.extracted_count}건으로 교체합니다. 되돌릴 수 없습니다. 계속?`,
      )
    ) {
      return
    }

    setApplying((s) => ({ ...s, [row.id]: true }))
    setMessage((s) => ({ ...s, [row.id]: '' }))
    try {
      const res = await fetch('/api/admin/rate-check/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ result_id: row.id }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) {
        setMessage((s) => ({ ...s, [row.id]: `❌ ${data.error ?? '실패'}` }))
      } else {
        setMessage((s) => ({ ...s, [row.id]: `✅ ${data.deleted} → ${data.inserted}건 반영` }))
        router.refresh()
      }
    } catch (err) {
      setMessage((s) => ({ ...s, [row.id]: `❌ ${err instanceof Error ? err.message : '오류'}` }))
    } finally {
      setApplying((s) => ({ ...s, [row.id]: false }))
    }
  }

  return (
    <div className="bg-white border rounded-lg overflow-x-auto">
      <table className="w-full text-sm min-w-[860px]">
        <thead className="bg-gray-50 border-b">
          <tr>
            <th className="text-left px-4 py-2 text-xs font-semibold text-gray-600 uppercase">배대지</th>
            <th className="text-left px-4 py-2 text-xs font-semibold text-gray-600 uppercase">상태</th>
            <th className="text-right px-4 py-2 text-xs font-semibold text-gray-600 uppercase">
              DB 현재
            </th>
            <th className="text-right px-4 py-2 text-xs font-semibold text-gray-600 uppercase">
              추출 건수
            </th>
            <th className="text-right px-4 py-2 text-xs font-semibold text-gray-600 uppercase">
              커버리지
            </th>
            <th className="text-left px-4 py-2 text-xs font-semibold text-gray-600 uppercase">
              메모 / 오류
            </th>
            <th className="px-4 py-2 text-xs font-semibold text-gray-600 uppercase text-right">액션</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const coverage =
              row.db_rate_count > 0
                ? Math.round((row.extracted_count / row.db_rate_count) * 100)
                : null
            const isExpanded = expanded[row.id] ?? false
            const canApply = row.status === 'extracted' && row.extracted_count > 0 && !row.applied_at
            const sampleRates = (row.extracted_rates ?? []).slice(0, 20)

            return (
              <>
                <tr key={row.id} className="border-b last:border-b-0 align-top">
                  <td className="px-4 py-3 font-medium text-gray-900 whitespace-nowrap">
                    {row.forwarder_name}
                    <div className="text-xs text-gray-400 font-normal">/{row.forwarder_slug}</div>
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    {statusBadge(row.status)}
                    {row.applied_at && (
                      <div className="text-[10px] text-green-700 mt-1">반영됨</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-700 tabular-nums">
                    {row.db_rate_count}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums font-semibold">
                    {row.extracted_count}
                  </td>
                  <td className="px-4 py-3 text-right text-xs tabular-nums">
                    {coverage == null ? (
                      <span className="text-gray-400">—</span>
                    ) : coverage >= 70 ? (
                      <span className="text-green-700">{coverage}%</span>
                    ) : coverage >= 30 ? (
                      <span className="text-amber-700">{coverage}%</span>
                    ) : (
                      <span className="text-red-700">{coverage}%</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-700 max-w-md">
                    {row.status === 'error' || row.status === 'skipped'
                      ? row.error_message ?? '—'
                      : row.ai_summary ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <div className="flex gap-2 justify-end flex-wrap">
                      {row.extracted_count > 0 && (
                        <button
                          onClick={() =>
                            setExpanded((s) => ({ ...s, [row.id]: !s[row.id] }))
                          }
                          className="text-xs text-blue-600 hover:underline"
                        >
                          {isExpanded ? '접기' : '미리보기'}
                        </button>
                      )}
                      {row.page_url && (
                        <a
                          href={row.page_url.split(/[,\n]/)[0].trim()}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-gray-600 hover:underline"
                          title={row.page_url}
                        >
                          ↗
                        </a>
                      )}
                      <button
                        onClick={() => handleRescan(row)}
                        disabled={rescanning[row.id] || applying[row.id]}
                        className="text-xs text-gray-700 hover:text-blue-600 hover:underline disabled:opacity-50"
                        title="이 배대지만 다시 스캔"
                      >
                        {rescanning[row.id] ? '스캔 중…' : '↻ 다시'}
                      </button>
                      {canApply && (
                        <Button
                          size="sm"
                          onClick={() => handleApply(row)}
                          disabled={applying[row.id] || rescanning[row.id]}
                          className={
                            coverage != null && coverage < 70
                              ? 'bg-amber-600 hover:bg-amber-700 h-7 text-xs'
                              : 'bg-green-600 hover:bg-green-700 h-7 text-xs'
                          }
                        >
                          {applying[row.id] ? '반영 중…' : '반영'}
                        </Button>
                      )}
                    </div>
                    {message[row.id] && (
                      <div
                        className={`text-[10px] mt-1 ${
                          message[row.id].startsWith('✅') ? 'text-green-700' : 'text-red-700'
                        }`}
                      >
                        {message[row.id]}
                      </div>
                    )}
                  </td>
                </tr>
                {isExpanded && sampleRates.length > 0 && (
                  <tr key={`${row.id}-expand`} className="border-b bg-gray-50">
                    <td colSpan={7} className="px-4 py-3">
                      <div className="text-xs font-semibold text-gray-600 mb-2">
                        추출 샘플 (최대 20건, 총 {row.extracted_count}건)
                      </div>
                      <div className="overflow-x-auto">
                        <table className="text-xs bg-white border rounded w-full min-w-[720px]">
                          <thead className="bg-gray-100 text-gray-600">
                            <tr>
                              <th className="px-2 py-1 text-left">국가</th>
                              <th className="px-2 py-1 text-left">센터</th>
                              <th className="px-2 py-1 text-left">등급</th>
                              <th className="px-2 py-1 text-right">무게</th>
                              <th className="px-2 py-1 text-right">가격</th>
                              <th className="px-2 py-1 text-left">타입</th>
                            </tr>
                          </thead>
                          <tbody>
                            {sampleRates.map((r, i) => (
                              <tr key={i} className="border-b last:border-b-0">
                                <td className="px-2 py-1">{r.country}</td>
                                <td className="px-2 py-1">{r.center_name ?? '—'}</td>
                                <td className="px-2 py-1">
                                  {r.grade_level} / {r.member_grade ?? '—'}
                                </td>
                                <td className="px-2 py-1 text-right tabular-nums">
                                  {r.weight_min === r.weight_max
                                    ? `${r.weight_min}kg`
                                    : `${r.weight_min}~${r.weight_max}kg`}
                                </td>
                                <td className="px-2 py-1 text-right tabular-nums">
                                  {formatRateValue(r)}
                                </td>
                                <td className="px-2 py-1">{r.shipping_type ?? '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </td>
                  </tr>
                )}
              </>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
