import type { Metadata } from "next";
import { Geist } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import { Analytics } from "@vercel/analytics/react";
import { SpeedInsights } from "@vercel/speed-insights/next";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://jimscanner.co.kr"),
  title: {
    default: "짐스캐너 - 해외직구 배대지 배송비 한눈에 비교",
    template: "%s | 짐스캐너",
  },
  description:
    "미국, 일본, 중국 배대지 30개+ 배송비를 무게별로 즉시 비교하세요. 짐패스·훗타운·포스트고·아라쿠 등 2026년 최신 요금. 무료 즉시 비교.",
  keywords: ["배대지", "해외직구", "배송비비교", "미국배대지", "일본배대지", "중국배대지", "짐스캐너", "몰테일", "훗타운", "짐패스", "포스트고", "아이포터", "아라쿠", "이지타오", "조이포스트", "바로쏨", "배대지비교", "배대지추천", "일본직구", "미국직구", "배대지요금", "배송비계산"],
  verification: {
    google: undefined,
    other: {
      "naver-site-verification": ["54f32df0de8c38cbbaa9ac839abcd319", "fc8857783cca121bd26b263f67c9ce7b"],
    },
  },
  openGraph: {
    type: "website",
    locale: "ko_KR",
    title: "짐스캐너 - 배대지 배송비 한눈에 비교 2026",
    description: "미국·일본·중국 배대지 30개+ 배송비를 무게별로 즉시 비교. 짐패스·훗타운·포스트고 최저가 찾기.",
    url: "https://jimscanner.co.kr",
    images: [{ url: "/og-image.jpg", width: 1200, height: 630, alt: "짐스캐너 - 해외직구 배대지 배송비 비교" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "짐스캐너 - 배대지 배송비 한눈에 비교 2026",
    description: "미국·일본·중국 배대지 30개+ 배송비를 무게별로 즉시 비교. 짐패스·훗타운·포스트고 최저가.",
    images: ["/og-image.jpg"],
  },
};

/**
 * Root layout — 모든 라우트의 공통 frame.
 *
 * 역할 분담:
 *  - root: <html>·<body>·전역 스크립트 (GA, AdSense, JSON-LD)·전역 측정 (Analytics, SpeedInsights)
 *  - (b2c)/layout.tsx: 마케팅 chrome (Header, Footer, StickyCTA, GlobalReportButton)
 *  - (b2b)/layout.tsx: 사업자용 chrome (B2B 진입 후 정의)
 *  - admin/(dashboard)/layout.tsx: 어드민 chrome (자체 사이드바)
 */
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const adsenseClient = process.env.NEXT_PUBLIC_ADSENSE_CLIENT ?? 'ca-pub-1827479577096239'
  return (
    <html lang="ko">
      <head>
        {/* GA disable flag MUST run before gtag/js loads — afterInteractive 단계에서
            gtag('config') 가 실행되기 전에 /admin 경로면 측정을 끔. useEffect 기반
            disable 은 page_view 가 이미 발사된 뒤에 도는 문제가 있어 인라인 동기 스크립트로 처리. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{if(typeof location!=='undefined'&&location.pathname.indexOf('/admin')===0){window['ga-disable-G-TS4P13JPTY']=true;}}catch(e){}`,
          }}
        />
        <Script
          src="https://www.googletagmanager.com/gtag/js?id=G-TS4P13JPTY"
          strategy="afterInteractive"
        />
        <Script id="google-analytics" strategy="afterInteractive">{`
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          gtag('js', new Date());
          gtag('config', 'G-TS4P13JPTY');
        `}</Script>
        {adsenseClient && (
          <>
            {/* AdSense·Funding Choices: lazyOnload — 메인스레드 점유로 LCP 1.5s 늘리던 문제 해결.
                AdSlot 의 (adsbygoogle = []).push 는 큐로 동작해서 스크립트가 늦게 도착해도 안전. */}
            <Script
              id="google-adsense"
              async
              src={`https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${adsenseClient}`}
              crossOrigin="anonymous"
              strategy="lazyOnload"
            />
            <Script
              id="google-funding-choices"
              async
              src={`https://fundingchoicesmessages.google.com/i/${adsenseClient}?ers=1`}
              strategy="lazyOnload"
            />
            <Script id="google-funding-choices-signal" strategy="lazyOnload">{`
              (function(){function s(){if(!window.frames['googlefcPresent']){if(document.body){var i=document.createElement('iframe');i.style='width:0;height:0;border:none;z-index:-1000;left:-1000px;top:-1000px;';i.style.display='none';i.name='googlefcPresent';document.body.appendChild(i)}else{setTimeout(s,0)}}}s()})();
            `}</Script>
          </>
        )}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@graph": [
                {
                  "@type": "WebSite",
                  "@id": "https://jimscanner.co.kr/#website",
                  url: "https://jimscanner.co.kr",
                  name: "짐스캐너",
                  description: "해외직구 배대지 배송비 한눈에 비교",
                  inLanguage: "ko",
                  potentialAction: {
                    "@type": "SearchAction",
                    target: {
                      "@type": "EntryPoint",
                      urlTemplate: "https://jimscanner.co.kr/forwarders?q={search_term_string}",
                    },
                    "query-input": "required name=search_term_string",
                  },
                },
                {
                  "@type": "Organization",
                  "@id": "https://jimscanner.co.kr/#organization",
                  name: "짐스캐너",
                  url: "https://jimscanner.co.kr",
                  logo: {
                    "@type": "ImageObject",
                    url: "https://jimscanner.co.kr/og-image.jpg",
                  },
                  description: "미국, 일본 등 주요 배대지 배송비를 한눈에 비교하는 서비스",
                },
              ],
            }),
          }}
        />
      </head>
      <body className={`${geistSans.variable} antialiased min-h-screen flex flex-col`}>
        {children}
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}
