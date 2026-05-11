/**
 * B2B 직구 사업자 도구 chrome.
 *
 * Phase 2 신설 트랙. 페이지 추가 후 사업자 전용 헤더·사이드바 구성.
 * 디자인 결정 D10 (B2C/B2B 톤 통합) 은 B2B v0 빌드 시점에 진행.
 *
 * 현재는 layout 만 셋업 (라우트 그룹 인프라). 페이지 신설 전이라
 * `/b2b` 접근 시 `not-found` 노출.
 */
export default function B2BLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return <main className="flex-1">{children}</main>;
}
