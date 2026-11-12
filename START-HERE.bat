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

rem ---- 3. python + generated data ----
rem   XML import needs python (tools\gen_tags.py).
rem   "where python" is NOT a valid check: the name may resolve to the
rem   Microsoft Store placeholder alias (%LOCALAPPDATA%\...\WindowsApps\python.exe)
rem   which exits with 9009 and prints nothing. So we execute a real script.
set "PY="
if not defined MYX_PYTHON goto :st_try_python
"%MYX_PYTHON%" -c "import sys;sys.exit(0 if sys.version_info>=(3,6) else 1)" >nul 2>nul
if errorlevel 1 goto :st_try_python
set "PY=%MYX_PYTHON%"
goto :st_py_ready
:st_try_python
python -c "import sys;sys.exit(0 if sys.version_info>=(3,6) else 1)" >nul 2>nul
if errorlevel 1 goto :st_try_py
set "PY=python"
goto :st_py_ready
:st_try_py
py -3 -c "import sys;sys.exit(0 if sys.version_info>=(3,6) else 1)" >nul 2>nul
if errorlevel 1 goto :st_try_py3
set "PY=py -3"
goto :st_py_ready
:st_try_py3
python3 -c "import sys;sys.exit(0 if sys.version_info>=(3,6) else 1)" >nul 2>nul
if errorlevel 1 goto :st_no_py
set "PY=python3"

:st_py_ready
echo [v] python: %PY%
if not exist "server\gen\DEMO_MACHINE.tags.json" (
  echo [.] tag table missing, generating from example XML ...
  %PY% tools\gen_tags.py --all
)
if not exist "out\DEMO_MACHINE\tag_table.json" (
  echo [.] full symbol table missing, generating ...
  %PY% tools\gen_tags.py --all
)
echo [v] data ready
goto :st_data_done

:st_no_py
if not exist "server\gen\DEMO_MACHINE.tags.json" goto :st_no_py_nodata
echo [!] python not found -- XML IMPORT WILL NOT WORK ^(browsing existing data is fine^).
echo     Run 0-check-env.bat for the cause and the fix.
goto :st_data_done

:st_no_py_nodata
echo [x] python not found and no generated data yet.
echo     Install Python 3.8+ from python.org and CHECK "Add python.exe to PATH".
echo     Then run 0-check-env.bat and start this file again.
echo.
pause
exit /b 1

:st_data_done

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
