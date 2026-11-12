@echo off
chcp 65001 >nul
title CODESYS V3 client - Quick start
cd /d "%~dp0"

echo ============================================================
echo   CODESYS V3 tag access client - Quick start
echo ============================================================
echo.

rem ---- 1. Node.js ----
where node >nul 2>nul
if errorlevel 1 (
  echo [x] Node.js not found.
  echo     Install Node.js 18 or newer: https://nodejs.org/
  echo     Then double-click this file again.
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do set NODE_VER=%%v
echo [v] Node.js %NODE_VER%   ^(need v18+^)

rem ---- 2. dependency ws ----
rem   bundled copy  -> server\node_modules\ws   (offline package)
rem   npm install   -> node_modules\ws          (after git clone)
if exist "server\node_modules\ws\index.js" (
  echo [v] dependency "ws" present ^(bundled^)
) else if exist "node_modules\ws\index.js" (
  echo [v] dependency "ws" present ^(npm install^)
) else (
  echo [.] installing dependency "ws" ...
  call npm install --no-audit --no-fund
  if not exist "node_modules\ws\index.js" (
    if not exist "server\node_modules\ws\index.js" (
      echo [x] install failed. Run manually: npm install
      echo.
      pause
      exit /b 1
    )
  )
  echo [v] dependency installed
)

rem ---- 3. generated data ----
if not exist "server\gen\DEMO_MACHINE.tags.json" (
  echo [.] tag table missing, generating from example XML ...
  python tools\gen_tags.py --all
)
if not exist "out\DEMO_MACHINE\tag_table.json" (
  echo [.] full symbol table missing, generating ...
  python tools\gen_tags.py --all
)
echo [v] data ready

echo.
echo -- starting verification console --
echo     UI              http://127.0.0.1:8095
echo     change PLC IP   click the IP address at top-left in the UI
echo     stop            Ctrl+C in this window
echo.
start "" http://127.0.0.1:8095
node server\verify-server.js
echo.
echo [i] server stopped.
pause
