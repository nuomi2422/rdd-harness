@echo off
chcp 65001 >nul
title STAGER Console
setlocal

REM ============================================================
REM  STAGER console.  Pass a command through, or double-click for
REM  an interactive shell with a `stager` alias.
REM
REM  ASCII-only on purpose.  cmd.exe computes its file byte pointer
REM  with the pre-chcp codepage; `chcp 65001` only affects output,
REM  not that pointer.  Once it walks over a multibyte char the
REM  pointer desyncs from the real line starts and cmd then eats
REM  the FIRST CHARACTER of every following line -- `start` becomes
REM  `tart`, `set` becomes `et`, and the script dies.  Keeping this
REM  file pure ASCII removes the whole class of failure.
REM  All Chinese belongs in the node code behind stager.cmd.
REM ============================================================

set "ST=%~dp0"

if not exist "%ST%bin\stager.cmd" (
  echo [X] stager.cmd not found under "%ST%bin" - folder is broken.
  ping -n 3 127.0.0.1 >nul
  exit /b 1
)

if not "%~1"=="" goto passthru

echo.
echo  ==================== STAGER ====================
echo   stager status      where we are right now
echo   stager ctx         context block - AI runs this first
echo   stager list        all tasks
echo   stager check       what the gate still wants
echo   stager next        advance to the next stage
echo   stager pet         desktop pet
echo   stager web         web dashboard
echo   stager help        every command
echo  ==============================================
echo  Type `stager` for anything else, e.g. stager check
echo.

set "STAGER_DIR=%ST%"
cmd /k "chcp 65001 && cd /d ""%STAGER_DIR%"" && doskey stager=node bin\stager.js $* && title STAGER  (type stager)"
exit /b 0

:passthru
"%ST%bin\stager.cmd" %*
exit /b %ERRORLEVEL%
