/**
 * 쿠팡 소싱 스카우트 확장 인증 — /api/ext/scout/* 전용 정적 Bearer 토큰.
 * CRON_SECRET·service_role 과 분리(권한 분리·독립 회전). 확장 옵션 페이지에 입력해 사용.
 */
export function isAuthorizedScout(request: Request): boolean {
  const expected = process.env.SCOUT_EXT_TOKEN
  if (!expected) return false
  const auth = request.headers.get('authorization') ?? ''
  return auth === `Bearer ${expected}`
}
