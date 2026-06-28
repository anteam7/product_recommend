@echo off
REM ----------------------------------------------------------------
REM work-agent keep-alive launcher (remote work-instruction executor)
REM - ASCII only: cmd.exe misparses UTF-8 Korean comments (CP949).
REM - Auto-start at logon (Startup .vbs runs this hidden).
REM - If node exits, restart after 5s.
REM Log: %TEMP%\work-agent.log
REM ----------------------------------------------------------------
cd /d C:\Web\jimscanner-personal
:loop
echo [%date% %time%] work-agent start >> "%TEMP%\work-agent.log"
node --env-file=.env.local scripts\work-agent.mjs >> "%TEMP%\work-agent.log" 2>&1
echo [%date% %time%] work-agent exited, restarting in 5s >> "%TEMP%\work-agent.log"
ping -n 6 127.0.0.1 >nul
goto loop
