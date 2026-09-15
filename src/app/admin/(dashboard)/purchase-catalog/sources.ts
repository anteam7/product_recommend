// 매입처(공급처) 표시 메타 — 서버/클라이언트 양쪽에서 쓰므로 별도 모듈로 둔다.
// 매입처 추가 시 여기 + scripts/register-agent.mjs SOURCE_SCRIPTS + /api/admin/register-jobs SUPPORTED_SOURCES 를 같이 고칠 것.
export const SOURCE_META: Record<string, { label: string; cls: string; url: (g: string) => string | null }> = {
  ggsan: { label: '건강산', cls: 'bg-emerald-100 text-emerald-700', url: (g) => `https://www.ggsan.com/goods/goods_view.php?goodsNo=${g}` },
  upickb2b: { label: '유픽B2B', cls: 'bg-sky-100 text-sky-700', url: (g) => `https://upickb2b.com/product/x/${g}/category/1/display/1/` },
  bio77: { label: '77바이오', cls: 'bg-violet-100 text-violet-700', url: (g) => `https://77bio.co.kr/goods/goods_view.php?goodsNo=${g}` },
  wellroot: { label: '웰루트', cls: 'bg-lime-100 text-lime-700', url: (g) => `https://wellrootb2b.com/product/detail.html?product_no=${g}` },
  beseller: { label: '비셀러', cls: 'bg-amber-100 text-amber-700', url: () => null },
}
export const SOURCES = Object.keys(SOURCE_META)
