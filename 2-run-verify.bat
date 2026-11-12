@echo off
chcp 65001 >nul
title Step 2 - Start verification console
cd /d "%~dp0"

rem ============================================================
rem  Optional arg 1 = application name (which tag table to use)
rem    2-run-verify.bat                  newest one
rem    2-run-verify.bat DEMO_MACHINE     specify
rem
rem  Optional environment variables (or just click the IP in the UI):
rem    MYX_VERIFY_PORT   web port        default 8095
rem    MYX_HOST          PLC address     default 192.0.2.10
rem    MYX_PLC_PORT      PLC port        default 11740
rem    MYX_READONLY=1    read-only mode (all writes disabled)
rem    MYX_SRC           bind local NIC  (multi-homed machines)
rem ============================================================
if not "%~1"=="" set MYX_APP=%~1

rem ---- dependency check ----
if not exist "server\node_modules\ws\index.js" (
  if not exist "node_modules\ws\index.js" (
    echo [x] dependency "ws" not found.
    echo     Run this once in the project root:  npm install
    echo.
    pause
    exit /b 1
  )
)

echo ============================================================
echo   MYX verification console
echo ============================================================
echo   UI      http://127.0.0.1:8095
echo   stop    Ctrl+C
echo.
start "" http://127.0.0.1:8095
node server\verify-server.js
echo.
echo [i] server stopped.
pause
