import { revalidatePath as nextRevalidatePath } from 'next/cache'

/**
 * Wrapped revalidatePath — always uses 'layout' option.
 *
 * 메모리 vercel_isr_revalidate.md: 기본값 'page' 만으론 Edge Cache purge
 * 실패하는 케이스 있음. 'layout' 옵션으로 호출하면 해당 path 의 layout 트리
 * 전체 cache 무효화 → 안정적.
 *
 * 모든 신규 코드는 이 헬퍼 사용. 기존 `next/cache` 의 revalidatePath 직접
 * import 는 점진적으로 마이그레이션.
 *
 * 사용:
 *   import { revalidatePath } from '@/lib/revalidate'
 *   revalidatePath(`/forwarders/${slug}`)
 */
export function revalidatePath(path: string): void {
  nextRevalidatePath(path, 'layout')
}
