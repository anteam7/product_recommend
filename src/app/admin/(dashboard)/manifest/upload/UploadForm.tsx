'use client'

import { useState, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

type Country = 'US' | 'JP' | 'CN'
type Mode = 'air' | 'boat' | 'mixed'

type Result = {
  ok: boolean
  file: string
  country: string
  mode: string
  center_name: string | null
  source_forwarder_slug: string | null
  summary: {
    total_input_rows: number
    invoices: number
    parsed_rows: number
    skipped_meaningless: number
    outliers: number
    new_rows: number
    dedup_rows: number
    total_after: number
    category_weights_after: number | null
  }
  warnings: string[]
  recompute_error: string | null
}

type ApiError = { error: string; details?: string[] }

export default function UploadForm() {
  const [file, setFile] = useState<File | null>(null)
  const [country, setCountry] = useState<Country>('US')
  const [mode, setMode] = useState<Mode>('air')
  const [centerName, setCenterName] = useState('')
  const [forwarderSlug, setForwarderSlug] = useState('jimpass')
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [errorDetails, setErrorDetails] = useState<string[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!file) {
      setError('파일을 선택해 주세요.')
      return
    }
    setSubmitting(true)
    setError(null)
    setErrorDetails([])
    setResult(null)

    const fd = new FormData()
    fd.append('file', file)
    fd.append('country', country)
    fd.append('mode', mode)
    if (centerName.trim()) fd.append('center_name', centerName.trim())
    if (forwarderSlug.trim()) fd.append('forwarder_slug', forwarderSlug.trim())

    try {
      const res = await fetch('/api/admin/manifest/import', { method: 'POST', body: fd })
      const data = (await res.json()) as Result | ApiError
      if (!res.ok || 'error' in data) {
        setError('error' in data ? data.error : '알 수 없는 오류')
        if ('details' in data && Array.isArray(data.details)) setErrorDetails(data.details)
      } else {
        setResult(data)
        // 폼 리셋 (파일만)
        setFile(null)
        if (fileInputRef.current) fileInputRef.current.value = ''
      }
    } catch (e) {
      setError(`요청 실패: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-6">
      <form onSubmit={handleSubmit} className="space-y-4 rounded-lg border bg-white p-5">
        <div>
          <label className="mb-1 block text-sm font-medium">엑셀 파일 (.xlsx)</label>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,.xls"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full rounded-md border bg-white p-2 text-sm file:mr-3 file:rounded file:border-0 file:bg-blue-50 file:px-3 file:py-1 file:text-sm file:font-medium file:text-blue-700 hover:file:bg-blue-100"
            required
          />
          {file && (
            <p className="mt-1 text-xs text-gray-500">
              선택됨: {file.name} ({(file.size / 1024).toFixed(1)}KB)
              {file.size > 5 * 1024 * 1024 && (
                <span className="ml-2 text-rose-600">⚠️ 5MB 초과</span>
              )}
            </p>
          )}
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium">국가</label>
            <Select value={country} onValueChange={(v) => setCountry(v as Country)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="US">🇺🇸 미국 (US)</SelectItem>
                <SelectItem value="JP">🇯🇵 일본 (JP)</SelectItem>
                <SelectItem value="CN">🇨🇳 중국 (CN)</SelectItem>
              </SelectContent>
            </Select>
            <p className="mt-1 text-xs text-gray-500">
              참고 — 주문번호 prefix: U=미국, J=일본, C=중국항운, A=중국항공
            </p>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">운송수단</label>
            <Select value={mode} onValueChange={(v) => setMode(v as Mode)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="air">✈️ 항공 (air)</SelectItem>
                <SelectItem value="boat">🚢 항운 (boat)</SelectItem>
                <SelectItem value="mixed">🔀 혼합 (mixed) — 분리 불가능 시</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">창고 / 센터</label>
            <Input
              value={centerName}
              onChange={(e) => setCenterName(e.target.value)}
              placeholder="예: 오리건 센터, 캘리포니아 센터, 도쿄 센터"
              maxLength={100}
            />
            <p className="mt-1 text-xs text-gray-500">
              매니페스트가 발송된 센터명. 자유 입력.
            </p>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium">배대지 slug (선택)</label>
            <Input
              value={forwarderSlug}
              onChange={(e) => setForwarderSlug(e.target.value)}
              placeholder="jimpass"
              maxLength={100}
            />
            <p className="mt-1 text-xs text-gray-500">
              forwarders 테이블의 slug. 기본 jimpass.
            </p>
          </div>
        </div>

        <div className="flex items-center justify-between border-t pt-4">
          <p className="text-xs text-gray-500">
            업로드 시 PII 자동 제거 → 적재 → category_weights 재집계까지 한 번에 진행됩니다.
          </p>
          <Button type="submit" disabled={!file || submitting}>
            {submitting ? '적재 중...' : '업로드 및 적재'}
          </Button>
        </div>
      </form>

      {error && (
        <div className="rounded-lg border border-rose-300 bg-rose-50 p-4 text-sm text-rose-900">
          <p className="font-semibold">❌ 적재 실패</p>
          <p className="mt-1">{error}</p>
          {errorDetails.length > 0 && (
            <ul className="mt-2 ml-4 list-disc">
              {errorDetails.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {result && (
        <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-5 text-sm">
          <p className="text-base font-semibold text-emerald-900">✅ 적재 완료</p>
          <p className="mt-1 text-xs text-emerald-800">
            {result.file} · {result.country}/{result.mode}
            {result.center_name ? ` · ${result.center_name}` : ''}
            {result.source_forwarder_slug ? ` (${result.source_forwarder_slug})` : ''}
          </p>

          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
            <Stat label="입력 행" value={result.summary.total_input_rows} />
            <Stat label="송장 수" value={result.summary.invoices} />
            <Stat label="파싱 행" value={result.summary.parsed_rows} />
            <Stat label="신규 적재" value={result.summary.new_rows} highlight />
            <Stat label="중복 dedup" value={result.summary.dedup_rows} />
            <Stat label="무의미 스킵" value={result.summary.skipped_meaningless} />
            <Stat label="outlier 마킹" value={result.summary.outliers} />
            <Stat label="DB 총 행수 (적재 후)" value={result.summary.total_after} />
            {result.summary.category_weights_after !== null && (
              <Stat
                label="category_weights 재집계"
                value={result.summary.category_weights_after}
                highlight
              />
            )}
          </dl>

          {result.warnings.length > 0 && (
            <div className="mt-3 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
              <p className="font-semibold">⚠️ 경고</p>
              <ul className="mt-1 ml-4 list-disc">
                {result.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {result.recompute_error && (
            <div className="mt-3 rounded border border-rose-300 bg-rose-50 p-2 text-xs text-rose-900">
              ⚠️ 집계 재계산 실패: {result.recompute_error}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  return (
    <div className={'rounded p-2 ' + (highlight ? 'bg-white shadow-sm' : '')}>
      <dt className="text-xs text-gray-600">{label}</dt>
      <dd className={'mt-0.5 font-semibold ' + (highlight ? 'text-emerald-700' : 'text-gray-900')}>
        {value.toLocaleString()}
      </dd>
    </div>
  )
}
