# Archived Routine Specs

이 디렉터리의 파일들은 **더 이상 사용하지 않는** 루틴 스펙입니다. 참고·복구용으로만 보관.

## blog-pipeline.md (2026-04-22 archived)

자동 블로그 초안 → 검토 → 개선 파이프라인. 4 tick/day (KST 09·12·15·18시).

**Archive 사유**: 루틴이 의사결정 트리를 탈 때마다 "옵션 제시·계획 요약만 하고 종료" 하는 실패가 잦아, 기대한 "하루 1편 자동 생성" 이 거의 달성되지 않음. 수동 블로그 작성 + `/admin/blog` 의 새 AI 검토 기능으로 품질을 올리는 전략이 더 안정적이라 판단.

**DB 흔적**: `jimscanner_blog_posts.pipeline_status` · `revision_count` · `auto_generated` · `review_history` · `jimscanner_blog_topic_queue` 는 그대로 유지 (기존 데이터 보존 + 나중에 재활성화 가능).

**claude.ai 등록된 routine**: `claude.ai/code/routines` 에서 수동 Pause/Delete 필요.

## 후속

대체 루틴: `../sale-events-collector.md` — 해외 세일 이벤트 주 1회 수집.
