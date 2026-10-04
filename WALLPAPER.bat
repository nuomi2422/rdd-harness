@echo off
chcp 65001 >nul
title Wallpaper Rotator
setlocal

REM ============================================================
REM  Desktop wallpaper rotator / restorer.
REM  Double-click  ->  rotate to the next picture, then show
REM                     the result for 4 seconds and close.
REM  With arguments -> pass them straight through, e.g.
REM      WALLPAPER.bat -ListScreens
REM      WALLPAPER.bat -Image "D:\pic.jpg" -Mode Fit
REM      WALLPAPER.bat -Restore
REM      WALLPAPER.bat -Preview -Image "D:\pic.jpg"
REM
REM  ASCII-only on purpose, same reason as stager.bat: cmd.exe
REM  walks this file with a byte pointer computed BEFORE the
REM  `chcp 65001`, so any multibyte char desyncs it and cmd then
REM  eats the first character of every following line.  All
REM  Chinese output comes from the PowerShell script behind it.
REM ============================================================

set "HARNESS=%~dp0"
set "PS1=%HARNESS%bin\set-wallpaper.ps1"
set "SRC=C:\Users\lenovo\Pictures\Wallpapers-src"

if not exist "%PS1%" (
  echo [X] set-wallpaper.ps1 not found under "%HARNESS%bin" - folder is broken.
  ping -n 3 127.0.0.1 >nul
  exit /b 1
)

if "%~1"=="" (
  if not exist "%SRC%" (
    echo [X] wallpaper source folder not found: "%SRC%"
    echo     Put your pictures in there; names are sorted, so prefix
    echo     them 01- 02- 03- to control the rotation order.
    ping -n 4 127.0.0.1 >nul
    exit /b 1
  )
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -RotateDir "%SRC%" -Format Jpg -AllowUpscale %*
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
  echo  Done. Close this window.
) else (
  echo  [X] Failed. Exit code %RC%
)

if "%~1"=="" (
  ping -n 5 127.0.0.1 >nul
) else (
  exit /b %RC%
)
exit /b %RC%