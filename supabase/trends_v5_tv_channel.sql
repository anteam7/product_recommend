-- ────────────────────────────────────────────────────────────
-- TV 채널 다중성(MD 검증) 신호용 channel 컬럼 보강 (2026-06-04)
-- ────────────────────────────────────────────────────────────
-- 목적: naver_tvtime 편성 row 에 '어느 홈쇼핑사(채널)가 편성했는지'를 기록해
--       '몇 개 사가 같은 상품을 동시·연쇄 편성했나'(채널폭)를 점수화.
-- 사용처: /admin/trend-radar/tv-validated 보드 + collect-naver-tvtime 수집기
-- 적용: 사람이 psql/pooler 로 직접 실행. 코드는 적용 후 상태를 가정 (as any 캐스팅).
-- ────────────────────────────────────────────────────────────

ALTER TABLE jimscanner_trends_keywords
  ADD COLUMN IF NOT EXISTS channel text;   -- 'GS샵' / 'CJ온스타일' / '롯데' / '현대' / 'NS' ...

-- 채널 다중성 집계 (source + channel + 기간) 인덱스
CREATE INDEX IF NOT EXISTS jimscanner_trends_keywords_channel_at
  ON jimscanner_trends_keywords(source, channel, collected_at DESC)
  WHERE channel IS NOT NULL;
