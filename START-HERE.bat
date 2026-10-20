@echo off
chcp 65001 >nul
title RDD Harness - Quick Start
setlocal

REM ============================================================
REM  RDD Harness quick launcher (2026-10-01)
REM  Copy of the real scripts - originals stay in place.
REM  ASCII-only: cmd desyncs its byte pointer on multibyte chars.
REM ============================================================

set "D=%~dp0"
REM RDD root = <root>\harness\rdd-harness -> two levels up. No hardcoded D:\ path.
set "RDD_ROOT=%D%..\.."
set "S=%RDD_ROOT%\workspace\stager\bin\stager.js"

:menu
cls
echo.
echo  ==================  RDD Harness  ==================
echo   1  桌宠 起          stager-pet.bat
echo   2  桌宠 关          stop-stager-pet.bat
echo   3  心跳看门狗 起    stager-heartbeat.bat
echo   4  心跳看门狗 停    stager-heartbeat.bat stop
echo   5  网页看板 起      stager-dashboard.bat
echo   6  网页看板 关      stop-stager-web.bat
echo   7  监测台+看门狗    run-autostart.bat
echo  --------------------------------------------------
echo   8  现在在哪         stager status
echo   9  门禁还差什么     stager check
echo  10  开个终端自己敲   cmd
echo   0  退出
echo  ================================================
echo.

set /p C=选哪个（回车=退出）：

if "%C%"=="1" call :run "%D%stager-pet.bat" "桌宠已起"
if "%C%"=="2" call :run "%D%stop-stager-pet.bat" "桌宠已关"
if "%C%"=="3" call :run "%D%stager-heartbeat.bat" "看门狗已起"
if "%C%"=="4" call :run "%D%stager-heartbeat.bat stop" "看门狗已停"
if "%C%"=="5" call :run "%D%stager-dashboard.bat" "看板已起"
if "%C%"=="6" call :run "%D%stop-stager-web.bat" "看板已关"
if "%C%"=="7" call :run "%D%run-autostart.bat" "监测台已起"
if "%C%"=="8" call :stager status
if "%C%"=="9" call :stager check
if "%C%"=="10" (
  start "RDDtool" cmd /k "chcp 65001 && cd /d ""%D%"" && doskey stager=node ""%S%"" %%* && title STAGER - type stager"
  goto :eof
)
if "%C%"=="0" goto :eof
if "%C%"=="" goto :eof
echo 没听懂，敲个数字。
ping -n 2 127.0.0.1 >nul
goto :menu

:run
echo.
call "%~1"
echo.
echo   %~2
ping -n 2 127.0.0.1 >nul
goto :menu

:stager
echo.
node "%S%" %~1
echo.
ping -n 3 127.0.0.1 >nul
goto :menu