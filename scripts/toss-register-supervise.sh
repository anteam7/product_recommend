#!/usr/bin/env bash
# 토스 일괄 등록 감독 루프 — 러너(toss-register-batch.mjs)가 연속 실패/검수 지연으로 멈추거나 끝나면 다시 띄워 후보가 소진될 때까지 민다.
# (2026-10-14 사용자 지시 "미루지 않게 계속 밀어넣어줘") 반려·건너뜀은 DB에 남아 다음 실행 후보에서 빠지므로 같은 상품에서 반복 정지하지 않는다.
#   bash scripts/toss-register-supervise.sh [최대 반복=40] [검수 창=8] [sources]
# 로그: _workspace/toss-supervise-<KST날짜>.log (회차 요약), _workspace/toss-run-<회차>.log (러너 원문)
set -u
cd "$(dirname "$0")/.."
MAX=${1:-40}; PAR=${2:-8}; SRC=${3:-ggsan,upickb2b,bio77,kwholesale,wellroot}
DAY=$(TZ=Asia/Seoul date +%Y%m%d); mkdir -p _workspace
SUM="_workspace/toss-supervise-$DAY.log"
echo "$(date +%H:%M:%S) 감독 시작 max=$MAX parallel=$PAR sources=$SRC" | tee -a "$SUM"
for i in $(seq 1 "$MAX"); do
  LOG="_workspace/toss-run-$DAY-$i.log"
  node scripts/toss-register-batch.mjs --limit=600 --parallel="$PAR" --wait-max=90 --sources="$SRC" > "$LOG" 2>&1
  code=$?
  cand=$(head -1 "$LOG" | grep -o '후보 [0-9]*' | grep -o '[0-9]*'); cand=${cand:-0}
  reg=$(grep -c '등록 OK' "$LOG")
  ok=$(grep -c '^  ✓' "$LOG"); ng=$(grep -c '^  ✗' "$LOG"); skip=$(grep -c '^  ↷' "$LOG")
  halt=$(grep -E '→ 등록 중단' "$LOG" | tail -1 | cut -c1-80)
  echo "$(date +%H:%M:%S) #$i exit=$code 후보=$cand 등록=$reg 통과=$ok 실패=$ng 건너뜀=$skip ${halt:+중단:$halt}" | tee -a "$SUM"
  if [ "$cand" -eq 0 ]; then echo "$(date +%H:%M:%S) 후보 소진 → 종료" | tee -a "$SUM"; break; fi
  if [ "$reg" -eq 0 ] && [ "$ok" -eq 0 ] && [ "$ng" -eq 0 ]; then
    # 아무것도 못 한 회차(IP 차단·토스 장애·검수 전면 지연) → 10분 쉬고 재시도
    echo "$(date +%H:%M:%S) 진전 없음 → 10분 대기" | tee -a "$SUM"; sleep 600
  else
    sleep 30
  fi
done
echo "$(date +%H:%M:%S) 감독 종료" | tee -a "$SUM"
