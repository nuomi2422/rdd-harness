@echo off
chcp 65001 >nul
title Stop STAGER Desktop Pet
setlocal

REM ASCII-only on purpose - see stager-pet.bat for why.
REM Passes -Stop through to pet-launch.ps1.

REM RDD root = <root>\harness\rdd-harness -> two levels up. No hardcoded D:\ path.
set "RDD_ROOT=%~dp0..\.."
set "HELPER=%RDD_ROOT%\workspace\stager\pet\pet-launch.ps1"

if not exist "%HELPER%" (
  echo [X] helper missing: %HELPER%
  ping -n 3 127.0.0.1 >nul
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%HELPER%" -Stop
set "RC=%ERRORLEVEL%"
ping -n 3 127.0.0.1 >nul
exit /b %RC%
