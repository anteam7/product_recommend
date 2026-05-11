import { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: "/", disallow: ["/admin/", "/api/", "/doc/"] },
      // 네이버 검색봇 명시적 허용
      { userAgent: "Yeti", allow: "/", disallow: ["/admin/", "/api/"] },
      // Bing 봇
      { userAgent: "bingbot", allow: "/", disallow: ["/admin/", "/api/"] },
    ],
    sitemap: "https://jimscanner.co.kr/sitemap.xml",
  };
}
