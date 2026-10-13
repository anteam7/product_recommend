#!/usr/bin/env bash
# 토스 일괄 등록 감독 루프 — 러너(toss-register-batch.mjs)가 연속 실패/검수 지연으로 멈추거나 끝나면 다시 띄워 후보가 소진될 때까지 민다.
# (2026-10-14 사용자 지시 "미루지 않게 계속 밀어넣어줘") 반려·건너뜀·등록 실패(FAILED)는 DB에 남아 다음 실행 후보에서 빠지므로 같은 상품에서 반복 정지하지 않는다.
#   bash scripts/toss-register-supervise.sh [최대 반복=40] [검수 창=8] [sources]
# 로그: _workspace/toss-supervise-<날짜>.log (회차 요약), _workspace/toss-run-<날짜>-<회차>.log (러너 원문)
# 진전 판정: 이번 회차에 새로 등록했거나 검수 통과가 있어야 진전. (이전 실행에서 이어받은 TIMEOUT/반려의 ✗ 는 진전이 아니다 —
#   2026-10-14 새벽 ✗ 만 세어 "진전 있음"으로 오판, 2분 간격으로 38회 공회전.) 진전 없는 회차는 10분 쉬고, 연속 6회면 사람 확인이 필요하니 종료.
set -u
cd "$(dirname "$0")/.."
MAX=${1:-40}; PAR=${2:-8}; SRC=${3:-ggsan,upickb2b,bio77,kwholesale,wellroot}
DAY=$(date +%Y%m%d); mkdir -p _workspace   # 이 PC 로컬 시각(KST). TZ=Asia/Seoul 은 Git Bash 에서 UTC 로 떨어짐(10-13 파일명 실측)
SUM="_workspace/toss-supervise-$DAY.log"
echo "$(date +%H:%M:%S) 감독 시작 max=$MAX parallel=$PAR sources=$SRC" | tee -a "$SUM"
idle=0
for i in $(seq 1 "$MAX"); do
  LOG="_workspace/toss-run-$DAY-$i.log"
  node scripts/toss-register-batch.mjs --limit=600 --parallel="$PAR" --wait-max=90 --sources="$SRC" > "$LOG" 2>&1
  code=$?
  cand=$(head -1 "$LOG" | grep -o '후보 [0-9]*' | grep -o '[0-9]*'); cand=${cand:-0}
  reg=$(grep -c '등록 OK' "$LOG")
  ok=$(grep -c '^  ✓' "$LOG"); ng=$(grep -c '^  ✗' "$LOG"); skip=$(grep -c '^  ↷' "$LOG"); wait=$(grep -c '^  ⏳' "$LOG")
  halt=$(grep -E '→ 등록 중단' "$LOG" | tail -1 | cut -c1-80)
  echo "$(date +%H:%M:%S) #$i exit=$code 후보=$cand 등록=$reg 통과=$ok 실패=$ng 건너뜀=$skip 검수대기=$wait ${halt:+중단:$halt}" | tee -a "$SUM"
  if [ "$cand" -eq 0 ]; then echo "$(date +%H:%M:%S) 후보 소진 → 종료" | tee -a "$SUM"; break; fi
  if [ "$reg" -eq 0 ] && [ "$ok" -eq 0 ]; then
    idle=$((idle + 1))
    if [ "$idle" -ge 6 ]; then echo "$(date +%H:%M:%S) 진전 없음 연속 $idle회 → 종료(원인 확인 필요: $LOG)" | tee -a "$SUM"; break; fi
    echo "$(date +%H:%M:%S) 진전 없음($idle/6) → 10분 대기" | tee -a "$SUM"; sleep 600
  else
    idle=0; sleep 30
  fi
done
echo "$(date +%H:%M:%S) 감독 종료" | tee -a "$SUM"
