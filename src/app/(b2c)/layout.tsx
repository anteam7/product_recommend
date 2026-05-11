import Header from "@/components/layout/Header";
import Footer from "@/components/layout/Footer";
import StickyCTA from "@/components/layout/StickyCTA";
import GlobalReportButton from "@/components/reports/GlobalReportButton";

/**
 * B2C 마케팅 chrome — 일반 사용자용 페이지 wrapper.
 * 라우트 그룹 `(b2c)` 안의 모든 페이지 (about, blog, calculator, compare, deals,
 * exchange-rates, forwarders, guide, map, preparing, privacy, recommend, terms,
 * 그리고 root /) 에 적용.
 */
export default function B2CLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <>
      <Header />
      <main className="flex-1">{children}</main>
      <Footer />
      <StickyCTA />
      <GlobalReportButton />
    </>
  );
}
