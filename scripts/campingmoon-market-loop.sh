#!/usr/bin/env bash
# 캠핑문 쿠팡 시세 조회를 짧은 묶음으로 끊어서 돈다 — Aside 브라우저는 검색 15~30회면 쿠팡이 차단(검색 null)하고 20~30분 뒤 풀린다(2026-10-14 실측 3회).
#   bash scripts/campingmoon-market-loop.sh [묶음당 상품 수=10] [휴식 분=25] [최대 묶음=60]
# 종료: 대상 0건(미조회 상품 소진)이 연속 3회. 로그: _workspace/campingmoon-market-loop-<날짜>.log
set -u
cd "$(dirname "$0")/.."
N=${1:-10}; REST=${2:-25}; MAX=${3:-60}
case "$N$REST$MAX" in *[!0-9]*) echo "사용법: $0 [묶음] [휴식분] [최대묶음]" >&2; exit 2;; esac
DAY=$(date +%Y%m%d); mkdir -p _workspace
SUM="_workspace/campingmoon-market-loop-$DAY.log"
echo "$(date +%H:%M:%S) 시세 루프 시작 n=$N rest=${REST}m" | tee -a "$SUM"
empty=0
for i in $(seq 1 "$MAX"); do
  LOG="_workspace/campingmoon-market-burst-$DAY-$i.log"
  node scripts/campingmoon-market.mjs --limit="$N" > "$LOG" 2>&1; code=$?
  tgt=$(grep -o '^대상 [0-9]*' "$LOG" | grep -o '[0-9]*'); tgt=${tgt:-0}
  done_n=$(grep -c '^\s*\[[0-9]*/' "$LOG"); fail=$(grep -c '검색 실패' "$LOG")
  verdict=$(grep '^판정:' "$LOG" | cut -c1-120)
  echo "$(date +%H:%M:%S) #$i exit=$code 대상=$tgt 조회=$done_n 실패=$fail ${verdict}" | tee -a "$SUM"
  if [ "$tgt" -eq 0 ]; then empty=$((empty + 1)); if [ "$empty" -ge 3 ]; then echo "$(date +%H:%M:%S) 대상 0건 연속 3회 → 종료" | tee -a "$SUM"; break; fi; else empty=0; fi
  sleep $((REST * 60))
done
echo "$(date +%H:%M:%S) 시세 루프 종료" | tee -a "$SUM"
