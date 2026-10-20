@echo off
chcp 65001 >nul
title RDD Monitoring Autostart
echo Starting monitoring station + watchdog + AI Bridge browser...
REM RDD root = <root>\harness\rdd-harness -> two levels up. No hardcoded D:\ path.
set "RDD_ROOT=%~dp0..\.."
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%RDD_ROOT%\workspace\rdd-selfcompile\scripts\autostart-dev.ps1"
echo.
echo Done. Monitoring: http://127.0.0.1:8776/
ping -n 4 127.0.0.1 >nul
exit /b 0
