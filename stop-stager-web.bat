@echo off
chcp 65001 >nul
title Stop STAGER Dashboard
setlocal

REM ============================================================
REM  ASCII-only on purpose: cmd.exe desyncs its byte pointer on
REM  multibyte chars inside a .bat and eats the first character of
REM  the following lines.
REM
REM  Only the port needs sweeping.  `stager web` spawns pet\server.js
REM  as a child; killing that child makes stager.js's execFileSync
REM  throw, which CMD.web swallows, so the parent exits on its own.
REM  Verified 2026-09-30 - no orphans left behind.
REM ============================================================

netstat -ano | findstr "LISTENING" | findstr ":8899" >nul 2>&1
if errorlevel 1 (
  echo Dashboard was not running.
  ping -n 2 127.0.0.1 >nul
  exit /b 0
)

for /f "tokens=5" %%p in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":8899"') do (
  echo Killing pid %%p
  taskkill /f /t /pid %%p >nul 2>&1
)
ping -n 2 127.0.0.1 >nul

netstat -ano | findstr "LISTENING" | findstr ":8899" >nul 2>&1
if not errorlevel 1 (
  echo [X] something is still holding 8899 - check Task Manager.
  ping -n 3 127.0.0.1 >nul
  exit /b 1
)
echo [OK] Dashboard stopped.
ping -n 2 127.0.0.1 >nul
exit /b 0
