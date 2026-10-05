@echo off
chcp 65001 >nul
title RDD Harness - One-Click All
setlocal

REM ============================================================
REM  RDD Harness - turn everything ON / OFF with one click.
REM  Pure ASCII on purpose: cmd.exe desyncs its byte pointer on
REM  multibyte chars inside a .bat and eats the first character of
REM  the following lines. Do NOT put CJK in this file.
REM  Also: wmic is REMOVED on newer Windows, so process matching
REM  goes through kill-by-cmdline.ps1 (CIM) instead.
REM ============================================================

set "D=%~dp0"
set "SHOWPET=E:\restart developing doer\stager\bin\show-pet.ps1"
set "KILL=powershell.exe -NoProfile -ExecutionPolicy Bypass -File E:\restart developing doer\stager\bin\kill-by-cmdline.ps1"

if "%~1"=="" goto :ask
if /i "%~1"=="on" goto :on
if /i "%~1"=="off" goto :off
echo Usage: ALL-ON-OFF.bat [on^|off]
exit /b 2

:ask
echo.
echo   [1]  all ON
echo   [2]  all OFF
echo   [0]  cancel
set /p C=pick:
if "%C%"=="1" goto :on
if "%C%"=="2" goto :off
exit /b 0

:on
echo.
echo [1/6] monitoring + watchdog + AI Bridge
call "%D%run-autostart.bat" >nul 2>&1
echo        done
echo [2/6] desktop pet ON
call "%D%stager-pet.bat" >nul 2>&1
echo        done
echo [3/6] stage heartbeat watchdog ON
call "%D%stager-heartbeat.bat" >nul 2>&1
echo        done
echo [4/7] web dashboard ON (8899)
call "%D%stager-dashboard.bat" >nul 2>&1
echo        done
echo [5/7] harness panel ON (8891)
call "%D%app\PANEL.bat" >nul 2>&1
echo        done
echo [6/7] pull pet window to screen center
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SHOWPET%"
echo        done
echo [7/7] all ON
echo.
echo        monitoring : http://127.0.0.1:8776/
echo        dashboard  : http://127.0.0.1:8899/
echo        h-panel    : http://127.0.0.1:8891/
ping -n 3 127.0.0.1 >nul
exit /b 0

:off
echo.
echo [1/7] stop harness panel (8891)
for /f "tokens=5" %%q in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":8891"') do taskkill /f /pid %%q >nul 2>&1
echo        done
echo [2/7] stop web dashboard
call "%D%stop-stager-web.bat" >nul 2>&1
echo        done
echo [3/7] stop desktop pet
call "%D%stop-stager-pet.bat" >nul 2>&1
%KILL% -Match "start-pet" -Quiet >nul 2>&1
echo        done
echo [4/7] stop stage heartbeat watchdog
call "%D%stager-heartbeat.bat" stop >nul 2>&1
%KILL% -Match "stage-heartbeat" -Quiet >nul 2>&1
echo        done
echo [5/7] stop watchdogs
%KILL% -Match "mc-watchdog" -Quiet >nul 2>&1
%KILL% -Match "presence-watchdog" -Quiet >nul 2>&1
%KILL% -Match "every-10min-drive" -Quiet >nul 2>&1
echo        done
echo [6/7] stop servers on 8776 / 8777 / 8899
for %%p in (8776 8777 8899) do (
  for /f "tokens=5" %%q in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":%%p"') do taskkill /f /pid %%q >nul 2>&1
)
echo        done
echo [7/7] all OFF
ping -n 3 127.0.0.1 >nul
exit /b 0