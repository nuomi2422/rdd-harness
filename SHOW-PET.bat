@echo off
chcp 65001 >nul
title Show Desktop Pet
REM ASCII-only.  Finds the pet window and forces it visible + topmost + centered.
REM Uses SW_SHOWNOACTIVATE so it does NOT steal focus (does not interrupt typing).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "E:\restart developing doer\stager\bin\show-pet.ps1"
echo.
ping -n 3 127.0.0.1 >nul
exit /b 0