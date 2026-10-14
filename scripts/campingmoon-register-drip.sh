#!/usr/bin/env bash
# 캠핑문 → 쿠팡 드립 등록 — 10분마다 N건씩 이어 붙인다(사장님 2026-10-14: "한번에 일괄할 필요 없어, 10분에 2개 5개 이런식으로").
#   bash scripts/campingmoon-register-drip.sh [회차당 성공 건수=3] [간격 분=10] [최대 회차=300] [무진전 종료 회차=12]
# 후보는 campingmoon-register.mjs 가 매 회차 다시 고른다(시세 조회된 것만·품절/KC/제외/기등록 제외). 시세 조회(campingmoon-market.mjs)가
# 뒤에서 돌면서 후보가 늘어나므로, 후보 0 이 연속 12회(2시간)여야 종료. 로그: _workspace/campingmoon-drip-<날짜>.log (요약) · campingmoon-drip-run-<날짜>-<회차>.log (원문)
set -u
cd "$(dirname "$0")/.."
N=${1:-3}; MIN=${2:-10}; MAX=${3:-300}; IDLE_MAX=${4:-12}
case "$N$MIN$MAX$IDLE_MAX" in *[!0-9]*) echo "사용법: $0 [건수] [간격분] [최대회차] [무진전종료회차]" >&2; exit 2;; esac
DAY=$(date +%Y%m%d); mkdir -p _workspace
SUM="_workspace/campingmoon-drip-$DAY.log"; TAG="$DAY-$(date +%H%M)"
echo "$(date +%H:%M:%S) 드립 시작 n=$N interval=${MIN}m max=$MAX" | tee -a "$SUM"
idle=0; total=0
for i in $(seq 1 "$MAX"); do
  LOG="_workspace/campingmoon-drip-run-$TAG-$i.log"
  node scripts/campingmoon-register.mjs --limit="$N" > "$LOG" 2>&1; code=$?
  ok=$(grep -c '^\[[0-9/]*\] ✓' "$LOG"); ng=$(grep -c '^\[[0-9/]*\] ✗' "$LOG"); hold=$(grep -c '^\[[0-9/]*\] ⏭' "$LOG")
  cand=$(grep -o '^후보 [0-9]*' "$LOG" | grep -o '[0-9]*'); cand=${cand:-0}
  total=$((total + ok))
  echo "$(date +%H:%M:%S) #$i exit=$code 후보=$cand 등록=$ok 실패=$ng 보류=$hold 누적=$total" | tee -a "$SUM"
  if [ "$ok" -eq 0 ]; then
    idle=$((idle + 1))
    if [ "$idle" -ge "$IDLE_MAX" ]; then echo "$(date +%H:%M:%S) 등록 0건 연속 $idle회 → 종료(후보 소진 또는 시세 미조회)" | tee -a "$SUM"; break; fi
  else idle=0; fi
  sleep $((MIN * 60))
done
echo "$(date +%H:%M:%S) 드립 종료 누적 $total건" | tee -a "$SUM"
