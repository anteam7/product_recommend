@echo off
REM Improvement Scout wrapper for Windows Task Scheduler.
REM Runs improvement-scout-all.mjs (personal + jimpass) and appends to monthly log.

cd /d "C:\Web\jimscanner-personal"

set "LOG_DIR=logs"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM"') do set "MONTH=%%i"
set "LOG_FILE=%LOG_DIR%\improvement-scout-%MONTH%.log"

echo. >> "%LOG_FILE%"
echo ============================================================ >> "%LOG_FILE%"
powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz'" >> "%LOG_FILE%"
echo ============================================================ >> "%LOG_FILE%"

"C:\Program Files\nodejs\node.exe" --env-file=.env.local scripts\improvement-scout-all.mjs %* >> "%LOG_FILE%" 2>&1
