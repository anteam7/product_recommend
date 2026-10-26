#!/usr/bin/env bash
# 매입처 공용 쿠팡 드립 등록 — N분마다 <source>-register.mjs --limit=N 을 돌려 새 후보를 이어 붙이고, 3회차마다 승인 후속(재고 설정)을 돌린다.
#   bash scripts/register-drip.sh <source> [회차당 성공 건수=5] [간격 분=10] [최대 회차=300] [무진전 종료 회차=12]
#   REGISTER_FLAGS="--allow-nomatch" 환경변수로 등록기 플래그를 넘긴다.
# campingmoon-register-drip.sh 를 매입처 공용으로 일반화한 것(등록표 패턴 — 매입처마다 드립 스크립트를 복사하지 않는다).
# 등록기는 출력 형식 "후보 N건" · "[i/n] ✓|✗|⏭" 를 지킨다(아래 grep 이 센다). 시세 조회가 뒤에서 돌며 후보가 늘어나는 매입처(캠핑문·도매아토즈)는
# 무진전 종료 회차를 넉넉히 준다. 로그: _workspace/<source>-drip-<날짜>.log (요약) · <source>-drip-run-<날짜>-<회차>.log (원문)
set -u
cd "$(dirname "$0")/.."
SRC=${1:-}
case "$SRC" in ''|*[!a-z0-9]*) echo "사용법: $0 <source> [건수] [간격분] [최대회차] [무진전종료회차]" >&2; exit 2;; esac
[ -f "scripts/$SRC-register.mjs" ] || { echo "scripts/$SRC-register.mjs 없음" >&2; exit 2; }
N=${2:-5}; MIN=${3:-10}; MAX=${4:-300}; IDLE_MAX=${5:-12}
case "$N$MIN$MAX$IDLE_MAX" in *[!0-9]*) echo "사용법: $0 <source> [건수] [간격분] [최대회차] [무진전종료회차]" >&2; exit 2;; esac
FLAGS=${REGISTER_FLAGS:-}
DAY=$(date +%Y%m%d); mkdir -p _workspace
SUM="_workspace/$SRC-drip-$DAY.log"; TAG="$DAY-$(date +%H%M)"
echo "$(date +%H:%M:%S) 드립 시작 source=$SRC n=$N interval=${MIN}m max=$MAX idle=$IDLE_MAX flags=[$FLAGS]" | tee -a "$SUM"
idle=0; total=0
for i in $(seq 1 "$MAX"); do
  LOG="_workspace/$SRC-drip-run-$TAG-$i.log"
  # $FLAGS 는 단어 분리가 목적이라 따옴표 없이
  node "scripts/$SRC-register.mjs" --limit="$N" $FLAGS > "$LOG" 2>&1; code=$?
  ok=$(grep -c '^\[[0-9/]*\] ✓' "$LOG"); ng=$(grep -c '^\[[0-9/]*\] ✗' "$LOG"); hold=$(grep -c '^\[[0-9/]*\] ⏭' "$LOG")
  cand=$(grep -o '^후보 [0-9]*' "$LOG" | grep -o '[0-9]*'); cand=${cand:-0}
  total=$((total + ok))
  echo "$(date +%H:%M:%S) #$i exit=$code 후보=$cand 등록=$ok 실패=$ng 보류=$hold 누적=$total" | tee -a "$SUM"
  if [ $((i % 3)) -eq 0 ]; then
    FLOG="_workspace/$SRC-drip-followup-$TAG-$i.log"; node scripts/coupang-followup-approvals.mjs --source="$SRC" > "$FLOG" 2>&1 || true
    fsum=$(grep -E '^승인완료 기록' "$FLOG" | tail -1 | cut -c1-100); echo "$(date +%H:%M:%S)   승인 후속: ${fsum:-실패($(tail -1 "$FLOG" | cut -c1-80))}" | tee -a "$SUM"
  fi
  if [ "$ok" -eq 0 ]; then
    idle=$((idle + 1))
    if [ "$idle" -ge "$IDLE_MAX" ]; then echo "$(date +%H:%M:%S) 등록 0건 연속 $idle회 → 종료(후보 소진 또는 시세 미조회)" | tee -a "$SUM"; break; fi
  else idle=0; fi
  sleep $((MIN * 60))
done
echo "$(date +%H:%M:%S) 드립 종료 누적 $total건" | tee -a "$SUM"
