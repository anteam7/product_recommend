@echo off
REM ───────────────────────────────────────────────────────────────
REM order-server keep-alive 런처 (결제진행 버튼이 호출하는 127.0.0.1:39201)
REM   - 로그온 시 자동 시작용. 죽으면 5초 후 재시작.
REM   - 이미 39201 리스닝 중이면 중복 실행하지 않음.
REM
REM Windows 작업 등록(로그온 트리거, 사용자 세션 — Playwright Chrome 표시 필요):
REM   $a = New-ScheduledTaskAction -Execute "C:\Web\jimscanner-personal\scripts\order-server.cmd"
REM   $t = New-ScheduledTaskTrigger -AtLogOn
REM   $s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
REM   Register-ScheduledTask -TaskName "jimscanner-order-server" -Action $a -Trigger $t -Settings $s -RunLevel Limited -Force
REM ───────────────────────────────────────────────────────────────
cd /d C:\Web\jimscanner-personal
:loop
netstat -ano | findstr ":39201 " >nul
if %errorlevel%==0 (
  REM 이미 떠 있음 — 30초 후 재점검
  timeout /t 30 /nobreak >nul
  goto loop
)
echo [%date% %time%] order-server 시작
node --env-file=.env.local scripts\order-server.mjs
echo [%date% %time%] order-server 종료 — 5초 후 재시작
timeout /t 5 /nobreak >nul
goto loop
