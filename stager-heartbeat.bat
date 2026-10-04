@echo off
chcp 65001 >nul
title STAGER Heartbeat Watchdog
setlocal

REM ============================================================
REM  STAGER stage heartbeat watchdog (2026-09-30)
REM
REM  What problem it solves: an LLM has no sense of time and no
REM  internal clock. As the context grows it gets "lost in the
REM  middle" -- we hit it twice: (1) stuck in verify and never wrote
REM  the experience record, (2) so busy fixing gate tooling it forgot
REM  to actually deposit anything.
REM
REM  It runs as an INDEPENDENT process on purpose: a timer living
REM  inside the execution loop dies together with the loop, so a
REM  deadlocked main loop could never self-report.
REM
REM  ASCII-only on purpose (see stager.bat for why).
REM ============================================================

set "HB=E:\restart developing doer\rdd-selfcompile\scripts\stage-heartbeat.js"

if not exist "%HB%" (
  echo [X] not found: %HB%
  ping -n 3 127.0.0.1 >nul
  exit /b 1
)

if /i "%~1"=="stop" goto :stop
if /i "%~1"=="--once" goto :once

echo Starting STAGER heartbeat watchdog ^(loop, detached^)...
start "stager-heartbeat" /min node "%HB%" --loop --interval 60
ping -n 2 127.0.0.1 >nul
echo [OK] watchdog started. Log: rdd-selfcompile\selfcompile\heartbeat.log
echo      Stage budgets (min): plan 20 / implement 20 / verify 30 / close 15
echo      Three tiers: T+budget remind / T+budget+10 force-selfcheck / T+budget+20 snapshot+rollback
echo      To stop:  stager-heartbeat.bat stop
exit /b 0

:once
echo Running one round (dry-run, prints what it WOULD inject^)...
node "%HB%" --once --dry
ping -n 3 127.0.0.1 >nul
exit /b 0

:stop
for /f "tokens=2" %%p in ('wmic process where "name='node.exe'" get ProcessId^,CommandLine /format:list ^| find "stage-heartbeat"') do (
  echo Killing %%p
  taskkill /f /pid %%p >nul 2>&1
)
echo [OK] watchdog stopped.
ping -n 2 127.0.0.1 >nul
exit /b 0