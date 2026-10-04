@echo off
chcp 65001 >nul
title STAGER Dashboard
setlocal

REM ============================================================
REM  STAGER dashboard launcher   (ASCII-only on purpose)
REM  cmd.exe desyncs its byte pointer on multibyte chars in a
REM  .bat and eats the first char of following lines. So: no CJK.
REM ============================================================

set "STAGER_DIR=E:\restart developing doer\stager"
set "PORT=8899"
set "URL=http://127.0.0.1:%PORT%/"
REM ping instead of timeout: timeout needs a console stdin and dies when
REM the batch is piped (e.g. from a test harness). ping always works.
set /a SLP=2

netstat -ano | findstr "LISTENING" | findstr ":%PORT%" >nul 2>&1
if not errorlevel 1 goto already

echo Starting STAGER dashboard on port %PORT% ...
start "stager-web" /min cmd /c "cd /d ""%STAGER_DIR%"" && node bin\stager.js web --port %PORT%"

set /a WAITED=0
:wait
ping -n 2 127.0.0.1 >nul
set /a WAITED+=1
netstat -ano | findstr "LISTENING" | findstr ":%PORT%" >nul 2>&1
if not errorlevel 1 goto ready
if %WAITED% lss 15 goto wait

echo.
echo [X] Failed to start. Run this by hand:
echo     cd /d "%STAGER_DIR%"
echo     node bin\stager.js web --port %PORT%
pause
exit /b 1

:already
echo Dashboard already running - just opening the browser.
start "" "%URL%"
ping -n %SLP% 127.0.0.1 >nul
exit /b 0

:ready
echo [OK] Dashboard is up: %URL%
start "" "%URL%"
echo To stop it, double-click  stop-stager-web.bat
ping -n 3 127.0.0.1 >nul
exit /b 0
