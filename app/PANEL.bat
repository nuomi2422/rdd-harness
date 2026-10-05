@echo off
chcp 65001 >nul
title RDD Harness Panel
REM ================================================================
REM  RDD Harness Panel launcher.  Pure ASCII ON PURPOSE:
REM  cmd.exe desyncs its byte pointer on multibyte chars inside a
REM  .bat and eats the first character of the following lines.
REM  Do NOT put CJK in this file.  The window title is set from the
REM  same reason (kept ASCII).
REM
REM  Starts the panel minimized and opens the browser.  Ctrl+C in the
REM  panel window stops it.  To stop it from elsewhere:
REM    ALL-ON-OFF.bat off
REM ================================================================
setlocal

set "D=%~dp0"
set "PORT=8891"
set "NODE=node"

where %NODE% >nul 2>&1
if errorlevel 1 (
  echo [x] node not found in PATH. Install Node.js 18+ and retry.
  pause
  exit /b 1
)

REM already up? then just bring the browser over.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "if (Get-NetTCPConnection -State Listen -LocalPort %PORT% -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if not errorlevel 1 (
  echo [i] panel already running on %PORT%
  start "" "http://127.0.0.1:%PORT%/"
  exit /b 0
)

start "RDD Harness Panel" /min "%NODE%" "%D%server.js" %PORT%
ping -n 2 127.0.0.1 >nul
start "" "http://127.0.0.1:%PORT%/"

echo.
echo  RDD Harness Panel : http://127.0.0.1:%PORT%/
echo  stop              : close the minimized window, or run ALL-ON-OFF.bat off
echo.
exit /b 0