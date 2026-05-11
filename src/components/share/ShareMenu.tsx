'use client'

import { useEffect, useRef, useState } from 'react'
import { Share2, Check, Copy, MessageCircle } from 'lucide-react'

type Props = {
  /** 공유 제목 (카카오톡 카드 제목·X 본문 앞) */
  title: string
  /** 공유 설명 (카카오톡 카드 부제, OG description fallback) */
  description?: string
  /** OG 이미지 URL (카카오톡 카드 썸네일용) */
  imageUrl?: string | null
  /** 공유할 URL. 미지정 시 window.location.href 사용 */
  url?: string
  /** 버튼 사이즈 */
  size?: 'sm' | 'md'
  /** 버튼 라벨. 기본 "공유" */
  label?: string
  className?: string
}

const KAKAO_JS_KEY = process.env.NEXT_PUBLIC_KAKAO_JS_KEY

declare global {
  interface Window {
    Kakao?: {
      init: (key: string) => void
      isInitialized: () => boolean
      Share?: {
        sendDefault: (args: Record<string, unknown>) => void
      }
    }
  }
}

function loadKakaoSdk(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!KAKAO_JS_KEY) {
      reject(new Error('NEXT_PUBLIC_KAKAO_JS_KEY 미설정'))
      return
    }
    if (window.Kakao?.isInitialized()) {
      resolve()
      return
    }
    const existing = document.getElementById('kakao-sdk') as HTMLScriptElement | null
    const init = () => {
      try {
        if (window.Kakao && !window.Kakao.isInitialized()) {
          window.Kakao.init(KAKAO_JS_KEY)
        }
        resolve()
      } catch (e) {
        reject(e)
      }
    }
    if (existing) {
      if (window.Kakao?.isInitialized()) resolve()
      else existing.addEventListener('load', init, { once: true })
      return
    }
    const s = document.createElement('script')
    s.id = 'kakao-sdk'
    s.src = 'https://t1.kakaocdn.net/kakao_js_sdk/2.7.4/kakao.min.js'
    s.crossOrigin = 'anonymous'
    s.async = true
    s.addEventListener('load', init, { once: true })
    s.addEventListener('error', () => reject(new Error('카카오 SDK 로드 실패')), { once: true })
    document.head.appendChild(s)
  })
}

export default function ShareMenu({
  title,
  description,
  imageUrl,
  url,
  size = 'md',
  label = '공유',
  className,
}: Props) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  const resolveUrl = () => url ?? (typeof window !== 'undefined' ? window.location.href : '')

  // 외부 클릭으로 닫기
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  async function nativeShare() {
    const shareUrl = resolveUrl()
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
        await navigator.share({ title, text: description, url: shareUrl })
        setOpen(false)
        return true
      }
    } catch {
      // AbortError 포함 — 사용자가 취소한 것. 무시.
    }
    return false
  }

  async function openMenu() {
    // 모바일(네이티브 share 지원)이면 네이티브 먼저 시도. 실패/미지원이면 드롭다운 열기.
    const used = await nativeShare()
    if (!used) setOpen((o) => !o)
  }

  async function shareKakao() {
    setErr(null)
    try {
      await loadKakaoSdk()
      if (!window.Kakao?.Share) throw new Error('Kakao.Share 미로드')
      window.Kakao.Share.sendDefault({
        objectType: 'feed',
        content: {
          title,
          description: description ?? '',
          imageUrl: imageUrl ?? 'https://www.jimscanner.co.kr/og-image.jpg',
          link: { mobileWebUrl: resolveUrl(), webUrl: resolveUrl() },
        },
        buttons: [
          {
            title: '자세히 보기',
            link: { mobileWebUrl: resolveUrl(), webUrl: resolveUrl() },
          },
        ],
      })
      setOpen(false)
    } catch (e) {
      setErr(e instanceof Error ? e.message : '카카오 공유 실패')
    }
  }

  function shareX() {
    const text = encodeURIComponent(`${title} · 짐스캐너`)
    const u = encodeURIComponent(resolveUrl())
    window.open(
      `https://twitter.com/intent/tweet?text=${text}&url=${u}`,
      '_blank',
      'noopener,noreferrer',
    )
    setOpen(false)
  }

  function shareThreads() {
    const text = encodeURIComponent(`${title} ${resolveUrl()}`)
    window.open(
      `https://threads.net/intent/post?text=${text}`,
      '_blank',
      'noopener,noreferrer',
    )
    setOpen(false)
  }

  function shareFacebook() {
    const u = encodeURIComponent(resolveUrl())
    window.open(
      `https://www.facebook.com/sharer/sharer.php?u=${u}`,
      '_blank',
      'noopener,noreferrer',
    )
    setOpen(false)
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(resolveUrl())
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      setErr('복사 실패')
    }
  }

  const btnPad = size === 'sm' ? 'px-2 py-1 text-xs' : 'px-3 py-2 text-sm'
  const iconSize = size === 'sm' ? 'w-3.5 h-3.5' : 'w-4 h-4'

  return (
    <div ref={menuRef} className={`relative inline-block ${className ?? ''}`}>
      <button
        type="button"
        onClick={openMenu}
        className={`inline-flex items-center gap-1.5 rounded-md border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium ${btnPad}`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Share2 className={iconSize} />
        {label}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 z-40 min-w-[180px] bg-white border rounded-md shadow-lg py-1"
        >
          {KAKAO_JS_KEY && (
            <button
              type="button"
              onClick={shareKakao}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-yellow-50 text-gray-800"
              role="menuitem"
            >
              <MessageCircle className="w-4 h-4 text-yellow-500" />
              카카오톡
            </button>
          )}
          <button
            type="button"
            onClick={shareX}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-gray-50 text-gray-800"
            role="menuitem"
          >
            <span className="w-4 h-4 inline-flex items-center justify-center rounded-sm bg-black text-white text-[10px] font-bold">
              𝕏
            </span>
            X
          </button>
          <button
            type="button"
            onClick={shareThreads}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-gray-50 text-gray-800"
            role="menuitem"
          >
            <span className="w-4 h-4 inline-flex items-center justify-center text-gray-900 font-bold">
              @
            </span>
            Threads
          </button>
          <button
            type="button"
            onClick={shareFacebook}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-blue-50 text-gray-800"
            role="menuitem"
          >
            <span className="w-4 h-4 inline-flex items-center justify-center rounded-sm bg-blue-600 text-white text-[10px] font-bold">
              f
            </span>
            Facebook
          </button>
          <div className="h-px bg-gray-100 my-1" />
          <button
            type="button"
            onClick={copy}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-gray-50 text-gray-800"
            role="menuitem"
          >
            {copied ? (
              <>
                <Check className="w-4 h-4 text-green-600" />
                링크 복사됨
              </>
            ) : (
              <>
                <Copy className="w-4 h-4 text-gray-500" />
                링크 복사
              </>
            )}
          </button>
          {err && (
            <p className="px-3 py-1.5 text-[11px] text-red-600 border-t mt-1">{err}</p>
          )}
        </div>
      )}
    </div>
  )
}
