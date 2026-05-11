import type { RateFetcher } from './types'
import { fetchMalltail } from './malltail'
import { fetchAspCommon } from './asp-common'
import {
  fetchWoomyshipping,
  fetchKenzpost,
  fetchPostteam,
  fetchJoypost,
  fetchTwofasts,
  fetchHoyausa,
  fetchPostgo,
} from './bucket-b'
import {
  fetchOhmyzip,
  fetchItemscout,
  fetchBidpot,
  fetchIrasshaimase,
  fetchBuynifon,
} from './bucket-c-static'
import { fetchGeniezip, fetchUnition, fetchJiggujiggu, fetchGajida } from './bucket-c-spa'

export const RATE_FETCHERS: Record<string, RateFetcher> = {
  malltail: fetchMalltail,
  // ASP 공통 백엔드 (8 사이트)
  thessan: fetchAspCommon,
  araku: fetchAspCommon,
  easytao: fetchAspCommon,
  chinaroad: fetchAspCommon,
  tabae: fetchAspCommon,
  tabaejapan: fetchAspCommon,
  japantimemall: fetchAspCommon,
  triolink: fetchAspCommon,
  // 버킷 B (정적 HTML)
  woomyshipping: fetchWoomyshipping,
  kenzpost: fetchKenzpost,
  postteam: fetchPostteam,
  joypost: fetchJoypost,
  twofasts: fetchTwofasts,
  hoyausa: fetchHoyausa,
  postgo: fetchPostgo,
  // 버킷 C 정적 (다중 테이블 / 다중 country 등)
  ohmyzip: fetchOhmyzip,
  itemscout: fetchItemscout,
  bidpot: fetchBidpot,
  irasshaimase: fetchIrasshaimase,
  buynifon: fetchBuynifon,
  // 버킷 C SPA / API
  geniezip: fetchGeniezip,
  unition: fetchUnition,
  jiggujiggu: fetchJiggujiggu,
  gajida: fetchGajida,
}

export function getRateFetcher(slug: string): RateFetcher | null {
  return RATE_FETCHERS[slug] ?? null
}
