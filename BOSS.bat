@echo off
chcp 65001 >nul
title RDD Boss Panel
REM ================================================================
REM  BOSS.bat -- open the panel straight to the "boss" page.
REM  Pure ASCII ON PURPOSE: cmd.exe desyncs its byte pointer on
REM  multibyte chars inside a .bat and eats the next line's first
REM  char.  Do NOT put CJK in this file.
REM
REM  Why this file exists (2026-10-20, user request):
REM    "I cannot quickly get the file I want; I have to dig through
REM     folders myself."  So: one double-click -> today's reports,
REM     the three boss lines visible, no folder digging.
REM
REM  NOTE: `start /min node ...` did NOT keep the process alive here
REM  (8891 stayed closed).  Using PowerShell Start-Process instead --
REM  that is the form verified to work on this machine.
REM ================================================================
setlocal

set "D=%~dp0"
set "PORT=8891"

where node >nul 2>&1
if errorlevel 1 (
  echo [x] node not found in PATH. Install Node.js 18+ and retry.
  pause
  exit /b 1
)

REM already listening? just open the browser.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "if (Get-NetTCPConnection -State Listen -LocalPort %PORT% -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if not errorlevel 1 (
  start "" "http://127.0.0.1:%PORT%/"
  exit /b 0
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "Start-Process -FilePath 'node' -ArgumentList '%D%app\server.js','%PORT%' -WorkingDirectory '%D%' -WindowStyle Hidden"

REM wait for the port to actually open (max ~6s) instead of a blind ping
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ok=$false; for($i=0;$i -lt 30;$i++){ if(Get-NetTCPConnection -State Listen -LocalPort %PORT% -ErrorAction SilentlyContinue){$ok=$true;break}; Start-Sleep -Milliseconds 200 }; if($ok){exit 0}else{exit 1}"
if errorlevel 1 (
  echo [x] panel did not start on port %PORT%
  echo     try: node "%D%app\server.js" %PORT%
  pause
  exit /b 1
)

start "" "http://127.0.0.1:%PORT%/"

echo.
echo  Boss panel : http://127.0.0.1:%PORT%/
echo  stop       : taskkill /f /im node.exe
echo.
exit /b 0
