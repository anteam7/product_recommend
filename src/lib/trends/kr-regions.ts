/**
 * 한국 17개 시도 메타데이터.
 * - code: ISO 3166-2 KR
 * - name: 한글 약칭
 * - naverArea: Naver DataLab 'area' 파라미터 코드 (지역별 클릭 추이)
 */

export type KrRegion = {
  code: string
  name: string
  naverArea: string
}

export const KR_REGIONS: KrRegion[] = [
  { code: 'KR-11', name: '서울', naverArea: '01' },
  { code: 'KR-26', name: '부산', naverArea: '02' },
  { code: 'KR-27', name: '대구', naverArea: '03' },
  { code: 'KR-28', name: '인천', naverArea: '04' },
  { code: 'KR-29', name: '광주', naverArea: '05' },
  { code: 'KR-30', name: '대전', naverArea: '06' },
  { code: 'KR-31', name: '울산', naverArea: '07' },
  { code: 'KR-50', name: '세종', naverArea: '08' },
  { code: 'KR-41', name: '경기', naverArea: '09' },
  { code: 'KR-42', name: '강원', naverArea: '10' },
  { code: 'KR-43', name: '충북', naverArea: '11' },
  { code: 'KR-44', name: '충남', naverArea: '12' },
  { code: 'KR-45', name: '전북', naverArea: '13' },
  { code: 'KR-46', name: '전남', naverArea: '14' },
  { code: 'KR-47', name: '경북', naverArea: '15' },
  { code: 'KR-48', name: '경남', naverArea: '16' },
  { code: 'KR-49', name: '제주', naverArea: '17' },
]

export const KR_REGION_COUNT = KR_REGIONS.length // 17

/**
 * KL-divergence: D(P || U) where U = 1/17 균등분포.
 * shares: region_code → share (합=1)
 * 반환: D_KL >= 0, 0 = 완전 균등, 큰 값일수록 편중.
 */
export function klDivergenceVsUniform(shares: Record<string, number>): number {
  const n = KR_REGION_COUNT
  let kl = 0
  for (const r of KR_REGIONS) {
    const p = shares[r.code] ?? 0
    if (p > 0) {
      kl += p * (Math.log(p) + Math.log(n))
    }
  }
  return kl
}

/** Top N 지역 추출. */
export function topRegions(
  shares: Record<string, number>,
  n = 3,
): Array<{ code: string; name: string; share: number }> {
  return KR_REGIONS.map((r) => ({
    code: r.code,
    name: r.name,
    share: shares[r.code] ?? 0,
  }))
    .sort((a, b) => b.share - a.share)
    .slice(0, n)
}
