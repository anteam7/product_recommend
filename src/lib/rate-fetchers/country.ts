// 국가명·국가코드를 ISO-2 로 정규화. 알 수 없으면 null.
const MAP: Record<string, string> = {
  // 미국
  us: 'US', usa: 'US', america: 'US',
  미국: 'US',
  // 일본
  jp: 'JP', jpn: 'JP', japan: 'JP',
  일본: 'JP',
  // 중국
  cn: 'CN', chn: 'CN', china: 'CN',
  중국: 'CN',
  // 홍콩
  hk: 'HK', hkg: 'HK', hongkong: 'HK',
  홍콩: 'HK',
  // 영국
  uk: 'UK', gb: 'UK', gbr: 'UK', england: 'UK', britain: 'UK', unitedkingdom: 'UK',
  영국: 'UK',
  // EU 국가들 (개별 코드 우선)
  de: 'DE', deu: 'DE', germany: 'DE', deutschland: 'DE',
  독일: 'DE',
  fr: 'FR', fra: 'FR', france: 'FR',
  프랑스: 'FR',
  it: 'IT', ita: 'IT', italy: 'IT',
  이탈리아: 'IT',
  es: 'ES', esp: 'ES', spain: 'ES',
  스페인: 'ES',
  nl: 'NL', nld: 'NL', netherlands: 'NL',
  네덜란드: 'NL',
  // 호주
  au: 'AU', aus: 'AU', australia: 'AU',
  호주: 'AU',
  // 캐나다
  ca: 'CA', can: 'CA', canada: 'CA',
  캐나다: 'CA',
  // 싱가포르
  sg: 'SG', sgp: 'SG', singapore: 'SG',
  싱가포르: 'SG',
  // 대만
  tw: 'TW', twn: 'TW', taiwan: 'TW',
  대만: 'TW',
  // 베트남
  vn: 'VN', vnm: 'VN', vietnam: 'VN',
  베트남: 'VN',
  // 태국
  th: 'TH', tha: 'TH', thailand: 'TH',
  태국: 'TH',
  // EU 통합 (특정 국가 미지정)
  eu: 'EU', europe: 'EU', euro: 'EU',
  유럽: 'EU',
}

export function normalizeCountry(raw: string | null | undefined): string | null {
  if (!raw) return null
  const key = raw.toLowerCase().replace(/[\s\-_·,/.()]+/g, '')
  return MAP[key] ?? null
}
