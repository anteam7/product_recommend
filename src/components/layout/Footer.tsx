'use client'

import Link from 'next/link'
import Image from 'next/image'
import { usePathname } from 'next/navigation'

export default function Footer() {
  const pathname = usePathname()
  if (pathname?.startsWith('/admin')) return null

  return (
    <footer className="border-t border-black/10 bg-white text-[#5F5E5A]">
      <div className="container mx-auto px-5 py-10 sm:px-8">
        <div className="grid grid-cols-1 gap-8 md:grid-cols-4">
          <div className="col-span-1 md:col-span-2">
            <Link href="/" className="inline-flex items-center" aria-label="짐스캐너 홈">
              <Image
                src="/jimscanner-logo.png"
                alt="짐스캐너"
                width={345}
                height={80}
                className="h-8 w-auto sm:h-9"
              />
            </Link>
            <p className="mt-3 max-w-md text-sm leading-relaxed text-[#5F5E5A]">
              해외직구 상품가, 배송비, 관세, 부가세를 조건별로 계산하는 도구입니다.
            </p>
            <p className="mt-4 max-w-xl text-xs leading-relaxed text-[#888780]">
              ※ 계산 결과는 참고용 데이터이며, 실제 청구 금액과 다를 수 있습니다.
              짐스캐너는 배대지 서비스를 직접 제공하지 않으며,
              배송 사고·분쟁에 대한 책임을 지지 않습니다.
            </p>
          </div>

          <div>
            <h3 className="mb-4 text-[11px] font-medium uppercase tracking-[0.16em] text-[#888780]">서비스</h3>
            <ul className="space-y-2">
              <li>
                <Link href="/recommend" className="text-sm transition-colors hover:text-[#1C1C1A]">
                  직구 시뮬레이터
                </Link>
              </li>
              <li>
                <Link href="/calculator" className="text-sm transition-colors hover:text-[#1C1C1A]">
                  배송비 계산기
                </Link>
              </li>
              <li>
                <Link href="/forwarders" className="text-sm transition-colors hover:text-[#1C1C1A]">
                  배대지 목록
                </Link>
              </li>
              <li>
                <Link href="/exchange-rates" className="text-sm transition-colors hover:text-[#1C1C1A]">
                  환율 동향
                </Link>
              </li>
              <li>
                <Link href="/blog" className="text-sm transition-colors hover:text-[#1C1C1A]">
                  블로그
                </Link>
              </li>
            </ul>
          </div>

          <div>
            <h3 className="mb-4 text-[11px] font-medium uppercase tracking-[0.16em] text-[#888780]">정보</h3>
            <ul className="space-y-2">
              <li>
                <Link href="/guide" className="text-sm transition-colors hover:text-[#1C1C1A]">
                  직구 가이드
                </Link>
              </li>
              <li>
                <Link href="/guide#customs" className="text-sm transition-colors hover:text-[#1C1C1A]">
                  통관 안내
                </Link>
              </li>
              <li>
                <Link href="/guide#tips" className="text-sm transition-colors hover:text-[#1C1C1A]">
                  절약 팁
                </Link>
              </li>
              <li>
                <Link href="/about" className="text-sm transition-colors hover:text-[#1C1C1A]">
                  서비스 소개
                </Link>
              </li>
              <li>
                <Link href="/terms" className="text-sm transition-colors hover:text-[#1C1C1A]">
                  이용약관
                </Link>
              </li>
              <li>
                <Link href="/privacy" className="text-sm transition-colors hover:text-[#1C1C1A]">
                  개인정보처리방침
                </Link>
              </li>
            </ul>
          </div>
        </div>

        <div className="mt-8 border-t border-black/10 pt-8">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-3">
            <div>
              <p className="text-sm text-[#888780]">
                © {new Date().getFullYear()} 짐스캐너. All rights reserved.
              </p>
              <p className="mt-1 text-xs text-[#888780]">
                본 서비스는 정보 제공 목적으로 운영되며, 순위는 가격·조건만으로 산정합니다.
              </p>
            </div>
            <div className="flex gap-4 text-xs text-[#888780]">
              <Link href="/terms" className="transition-colors hover:text-[#1C1C1A]">이용약관</Link>
              <Link href="/privacy" className="transition-colors hover:text-[#1C1C1A]">개인정보처리방침</Link>
            </div>
          </div>
        </div>
      </div>
    </footer>
  )
}
