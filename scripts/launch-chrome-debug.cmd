@echo off
REM ----------------------------------------------------------------
REM Launch a DEDICATED Chrome with remote debugging on port 9222.
REM - Separate profile (--user-data-dir) so it runs alongside your
REM   normal Chrome and keeps a warmed Coupang login.
REM - Used by scripts/tv-itemwinner-poc.mjs and domeme-sourcing
REM   (coupangMedianViaCDP) for Coupang price lookup.
REM Usage: double-click this file. Log into Coupang once in the window
REM        that opens, then leave it open. Re-run anytime.
REM ASCII only: cmd misparses UTF-8 Korean comments.
REM ----------------------------------------------------------------
set CHROME="C:\Program Files\Google\Chrome\Application\chrome.exe"
set PROFILE=%LOCALAPPDATA%\chrome-debug-9222
start "" %CHROME% --remote-debugging-port=9222 --user-data-dir="%PROFILE%" https://www.coupang.com/
echo Launched Chrome (debug 9222, profile: %PROFILE%)
echo Log into Coupang in the new window, then leave it open.
