@echo off
chcp 65001 >nul
title STAGER Desktop Pet
setlocal

REM ============================================================
REM  STAGER desktop pet launcher.  Double-click = start (or
REM  report "already running" - never spawns a second pet).
REM
REM  ASCII-only on purpose: cmd.exe desyncs its byte pointer on
REM  multibyte chars inside a .bat and eats the first character of
REM  the following lines.  All Chinese lives in pet-launch.ps1.
REM ============================================================

set "HELPER=E:\restart developing doer\stager\pet\pet-launch.ps1"

if not exist "%HELPER%" (
  echo [X] helper missing: %HELPER%
  ping -n 3 127.0.0.1 >nul
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%HELPER%" %*
set "RC=%ERRORLEVEL%"
ping -n 3 127.0.0.1 >nul
exit /b %RC%
