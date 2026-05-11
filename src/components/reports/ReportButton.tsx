'use client'

import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Flag, X } from 'lucide-react'
import {
  REPORT_REASON_CATEGORIES,
  type ReportTargetType,
} from '@/lib/reports'

type Props = {
  mode: 'floating' | 'inline'
  targetType: ReportTargetType
  targetSlug?: string
  targetId?: string
  label?: string // inline 모드용 문구 ("요금 오류 신고" 등)
  className?: string
}

const HCAPTCHA_SITE_KEY = process.env.NEXT_PUBLIC_HCAPTCHA_SITE_KEY

// hCaptcha 글로벌 타입
declare global {
  interface Window {
    hcaptcha?: {
      render: (container: HTMLElement, opts: Record<string, unknown>) => string
      reset: (id?: string) => void
      getResponse: (id?: string) => string
    }
  }
}

export default function ReportButton({
  mode,
  targetType,
  targetSlug,
  targetId,
  label,
  className,
}: Props) {
  const [open, setOpen] = useState(false)

  return (
    <>
      {mode === 'floating' ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={
            className ??
            'fixed bottom-4 right-4 z-40 flex items-center gap-1.5 rounded-full bg-gray-900/90 hover:bg-gray-800 text-white text-xs font-medium px-3.5 py-2 shadow-lg backdrop-blur transition-colors'
          }
          aria-label="정보 정정 요청"
        >
          <Flag className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">정보 정정 요청</span>
          <span className="sm:hidden">정정</span>
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={
            className ??
            'inline-flex items-center gap-1 text-xs text-gray-500 hover:text-red-600 transition-colors'
          }
        >
          <AlertTriangle className="w-3.5 h-3.5" />
          <span>{label ?? '오류 신고'}</span>
        </button>
      )}

      {open && (
        <ReportDialog
          targetType={targetType}
          targetSlug={targetSlug}
          targetId={targetId}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

function ReportDialog({
  targetType,
  targetSlug,
  targetId,
  onClose,
}: {
  targetType: ReportTargetType
  targetSlug?: string
  targetId?: string
  onClose: () => void
}) {
  const [reasonCategory, setReasonCategory] = useState<string>(
    REPORT_REASON_CATEGORIES[0].value,
  )
  const [description, setDescription] = useState('')
  const [correctInfo, setCorrectInfo] = useState('')
  const [sourceUrl, setSourceUrl] = useState('')
  const [email, setEmail] = useState('')
  const [privacyAgreed, setPrivacyAgreed] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const captchaRef = useRef<HTMLDivElement | null>(null)
  const captchaIdRef = useRef<string | null>(null)

  // hCaptcha 스크립트 주입 (키가 있을 때만)
  useEffect(() => {
    if (!HCAPTCHA_SITE_KEY) return
    const existing = document.getElementById('hcaptcha-script') as HTMLScriptElement | null
    const mount = () => {
      if (window.hcaptcha && captchaRef.current && !captchaIdRef.current) {
        captchaIdRef.current = window.hcaptcha.render(captchaRef.current, {
          sitekey: HCAPTCHA_SITE_KEY,
          theme: 'light',
        })
      }
    }
    if (existing) {
      mount()
      return
    }
    const script = document.createElement('script')
    script.id = 'hcaptcha-script'
    script.src = 'https://js.hcaptcha.com/1/api.js?render=explicit'
    script.async = true
    script.defer = true
    script.onload = () => setTimeout(mount, 50)
    document.head.appendChild(script)
  }, [])

  // ESC 닫기
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function submit() {
    setErr(null)
    if (description.trim().length < 10) {
      setErr('설명을 10자 이상 입력해주세요')
      return
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setErr('이메일 형식이 올바르지 않습니다')
      return
    }
    if (email && !privacyAgreed) {
      setErr('이메일 수집·이용에 동의해주세요')
      return
    }

    let hcaptchaToken: string | undefined
    if (HCAPTCHA_SITE_KEY) {
      if (!window.hcaptcha || captchaIdRef.current === null) {
        setErr('캡차 로딩 중입니다. 잠시 후 다시 시도해주세요')
        return
      }
      hcaptchaToken = window.hcaptcha.getResponse(captchaIdRef.current)
      if (!hcaptchaToken) {
        setErr('캡차를 완료해주세요')
        return
      }
    }

    setSubmitting(true)
    try {
      const res = await fetch('/api/reports', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          target_type: targetType,
          target_slug: targetSlug ?? null,
          target_id: targetId ?? null,
          target_url: typeof window !== 'undefined' ? window.location.href : '',
          reason_category: reasonCategory,
          description: description.trim(),
          correct_info: correctInfo.trim() || null,
          source_url: sourceUrl.trim() || null,
          reporter_email: email.trim() || null,
          hcaptcha_token: hcaptchaToken,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setErr(data.error ?? '신고 제출 실패')
        if (HCAPTCHA_SITE_KEY && window.hcaptcha && captchaIdRef.current) {
          window.hcaptcha.reset(captchaIdRef.current)
        }
        return
      }
      setDone(true)
    } catch {
      setErr('네트워크 오류')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between px-5 py-3 border-b">
          <h2 className="text-sm font-bold text-gray-900 flex items-center gap-1.5">
            <Flag className="w-4 h-4 text-red-500" />
            잘못된 정보 신고
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600"
            aria-label="닫기"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        {done ? (
          <div className="p-6 text-center space-y-2">
            <div className="text-2xl">✅</div>
            <p className="text-sm font-medium text-gray-900">신고가 접수되었습니다</p>
            <p className="text-xs text-gray-500">
              관리자가 확인 후 정정합니다.
              {email && ' 처리 결과는 입력하신 이메일로 회신됩니다.'}
            </p>
            <button
              type="button"
              onClick={onClose}
              className="mt-4 text-xs text-blue-600 hover:underline"
            >
              닫기
            </button>
          </div>
        ) : (
          <div className="p-5 space-y-3">
            <p className="text-xs text-gray-500 leading-relaxed">
              이 페이지의 정보에 오류가 있나요? 내용을 알려주시면 관리자가 확인 후 정정합니다.
              신고 내용은 공개되지 않고 관리자에게만 전달됩니다.
            </p>

            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-700">문제 유형</label>
              <select
                value={reasonCategory}
                onChange={(e) => setReasonCategory(e.target.value)}
                className="w-full border rounded-md px-3 py-2 text-sm"
                disabled={submitting}
              >
                {REPORT_REASON_CATEGORIES.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-700">
                어떤 부분이 잘못되었나요? <span className="text-red-500">*</span>
              </label>
              <textarea
                rows={4}
                value={description}
                onChange={(e) => setDescription(e.target.value.slice(0, 1000))}
                placeholder="예: kg당 요금이 1,500원이 아니라 1,300원으로 변경되었습니다."
                className="w-full border rounded-md px-3 py-2 text-sm resize-none"
                disabled={submitting}
              />
              <div className="text-[11px] text-right text-gray-400">
                {description.length} / 1000 (최소 10자)
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-700">
                올바른 정보 (선택)
              </label>
              <textarea
                rows={2}
                value={correctInfo}
                onChange={(e) => setCorrectInfo(e.target.value.slice(0, 2000))}
                placeholder="확인된 올바른 정보를 알려주시면 검증이 빨라집니다"
                className="w-full border rounded-md px-3 py-2 text-sm resize-none"
                disabled={submitting}
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-700">
                근거 URL (선택)
              </label>
              <input
                type="url"
                value={sourceUrl}
                onChange={(e) => setSourceUrl(e.target.value)}
                placeholder="https://..."
                className="w-full border rounded-md px-3 py-2 text-sm"
                disabled={submitting}
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-700">
                이메일 (선택 — 처리 결과 회신용)
              </label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="your@email.com"
                className="w-full border rounded-md px-3 py-2 text-sm"
                disabled={submitting}
              />
              {email && (
                <label className="flex items-start gap-2 pt-1.5 text-[11px] text-gray-600 leading-relaxed select-none">
                  <input
                    type="checkbox"
                    checked={privacyAgreed}
                    onChange={(e) => setPrivacyAgreed(e.target.checked)}
                    disabled={submitting}
                    className="mt-0.5 accent-red-600"
                  />
                  <span>
                    이메일 수집·이용에 동의합니다. 수집한 이메일은{' '}
                    <strong className="font-medium">신고 처리 결과 회신</strong> 목적으로만 사용하며,
                    처리 완료 후 최대 90일 내 파기합니다.{' '}
                    <a
                      href="/privacy#reports"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:underline"
                    >
                      자세히
                    </a>
                  </span>
                </label>
              )}
            </div>

            <p className="text-[11px] text-gray-400 leading-relaxed">
              신고 접수 시 스팸 방지를 위해 IP·브라우저 정보가 자동 수집되며, 신고 내용과 함께
              서비스 관리 목적으로만 사용됩니다.
            </p>

            {HCAPTCHA_SITE_KEY && (
              <div className="pt-1 flex justify-center">
                <div ref={captchaRef} />
              </div>
            )}

            {err && (
              <div className="text-xs bg-red-50 border border-red-100 text-red-700 rounded px-3 py-2">
                {err}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                className="text-sm px-3 py-2 text-gray-600 hover:text-gray-900"
              >
                취소
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={
                  submitting ||
                  description.trim().length < 10 ||
                  (!!email && !privacyAgreed)
                }
                className="text-sm bg-red-600 hover:bg-red-700 disabled:bg-gray-300 text-white px-4 py-2 rounded-md font-medium transition-colors"
              >
                {submitting ? '제출 중…' : '신고 제출'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
