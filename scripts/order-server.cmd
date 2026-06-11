@echo off
REM ----------------------------------------------------------------
REM order-server keep-alive launcher (127.0.0.1:39201)
REM - ASCII only: cmd.exe misparses UTF-8 Korean comments (CP949).
REM - Auto-start at logon (Startup .vbs runs this hidden).
REM - If port 39201 already listening, do not start a duplicate.
REM - If node exits, restart after 5s.
REM Log: %TEMP%\order-server.log
REM ----------------------------------------------------------------
cd /d C:\Web\jimscanner-personal
:loop
netstat -ano | findstr ":39201 " >nul
if %errorlevel%==0 (
  ping -n 31 127.0.0.1 >nul
  goto loop
)
echo [%date% %time%] order-server start >> "%TEMP%\order-server.log"
node --env-file=.env.local scripts\order-server.mjs >> "%TEMP%\order-server.log" 2>&1
echo [%date% %time%] order-server exited, restarting in 5s >> "%TEMP%\order-server.log"
ping -n 6 127.0.0.1 >nul
goto loop
