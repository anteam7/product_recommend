import { redirect } from 'next/navigation'
import { legacyRedirectHref, type RawSearchParams } from '../orders/model'

// 2026-10-13 마켓별 주문 페이지를 /admin/orders 로 통합 — 옛 링크·북마크는 네이버 필터로 보낸다(필터 파라미터 보존).
export const dynamic = 'force-dynamic'

export default async function NaverOrdersRedirect({ searchParams }: { searchParams: Promise<RawSearchParams> }) {
  redirect(legacyRedirectHref('naver', await searchParams))
}
