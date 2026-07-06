@echo off
REM Improvement Implementer wrapper for Windows Task Scheduler.
REM Runs improvement-implement.mjs and appends to monthly log.

chcp 65001 > nul

REM Task Scheduler PATH is minimal -- prepend npm global bin so claude.cmd resolves.
set "PATH=%USERPROFILE%\AppData\Roaming\npm;%PATH%"

REM Force opus for scheduled runs (global settings.json default is fable).
if not defined IMPLEMENT_MODEL set "IMPLEMENT_MODEL=opus"

cd /d "C:\Web\jimscanner-personal"

set "LOG_DIR=logs"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM"') do set "MONTH=%%i"
set "LOG_FILE=%LOG_DIR%\improvement-implement-%MONTH%.log"

echo. >> "%LOG_FILE%"
echo ============================================================ >> "%LOG_FILE%"
powershell -NoProfile -Command "Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz'" >> "%LOG_FILE%"
echo ============================================================ >> "%LOG_FILE%"

"C:\Program Files\nodejs\node.exe" --env-file=.env.local scripts\improvement-implement.mjs %* >> "%LOG_FILE%" 2>&1
