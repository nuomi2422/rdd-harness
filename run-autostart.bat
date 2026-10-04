@echo off
chcp 65001 >nul
title RDD Monitoring Autostart
echo Starting monitoring station + watchdog + AI Bridge browser...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "E:\restart developing doer\rdd-selfcompile\scripts\autostart-dev.ps1"
echo.
echo Done. Monitoring: http://127.0.0.1:8776/
ping -n 4 127.0.0.1 >nul
exit /b 0
