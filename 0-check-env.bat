@echo off
chcp 65001 >nul
title Environment check - CODESYS V3 client
cd /d "%~dp0"

echo ============================================================
echo   Environment check  (run this first if something fails)
echo ============================================================
echo.
echo   Checks: Node.js  /  dependency "ws"  /  Python 3
echo.

rem ============================================================
rem  [1/3] Node.js
rem ============================================================
echo [1/3] Node.js
where node >nul 2>nul
if errorlevel 1 goto :no_node
for /f "delims=" %%v in ('node -v 2^>^&1') do echo   [v] %%v
echo   [i] path: 
where node
goto :node_done
:no_node
echo   [x] node not found in PATH
echo       Install Node.js 18 or newer: https://nodejs.org/
set "FAIL=1"
:node_done
echo.

rem ============================================================
rem  [2/3] dependency ws
rem ============================================================
echo [2/3] dependency "ws"
if exist "server\node_modules\ws\index.js" (
  echo   [v] bundled ^(server\node_modules^)
  goto :ws_done
)
if exist "node_modules\ws\index.js" (
  echo   [v] installed ^(node_modules^)
  goto :ws_done
)
echo   [x] missing -^> run this once in the project root:  npm install
set "FAIL=1"
:ws_done
echo.

rem ============================================================
rem  [3/3] Python 3  (needed by XML import: tools\gen_tags.py)
rem
rem  NOTE: "where python" is NOT a valid check on Windows.
rem  When Python is not installed, the name python may still resolve to
rem     %LOCALAPPDATA%\Microsoft\WindowsApps\python.exe
rem  a 0-byte Microsoft Store alias that exits with code 9009 and prints
rem  nothing. That is why the import fails with "exit code 9009".
rem  So we really execute a tiny script with each candidate name.
rem ============================================================
echo [3/3] Python 3 ^(needed by XML import^)
if not defined MYX_PYTHON goto :try_python
"%MYX_PYTHON%" -c "import sys;sys.exit(0 if sys.version_info>=(3,6) else 1)" >nul 2>nul
if errorlevel 1 goto :bad_env_py
set "PY=%MYX_PYTHON%"
echo   [i] using MYX_PYTHON
goto :py_found
:bad_env_py
echo   [!] MYX_PYTHON is set but not usable: %MYX_PYTHON%
:try_python
python -c "import sys;sys.exit(0 if sys.version_info>=(3,6) else 1)" >nul 2>nul
if errorlevel 1 goto :try_py
set "PY=python"
goto :py_found
:try_py
py -3 -c "import sys;sys.exit(0 if sys.version_info>=(3,6) else 1)" >nul 2>nul
if errorlevel 1 goto :try_py3
set "PY=py -3"
goto :py_found
:try_py3
python3 -c "import sys;sys.exit(0 if sys.version_info>=(3,6) else 1)" >nul 2>nul
if errorlevel 1 goto :no_py
set "PY=python3"
goto :py_found

:py_found
for /f "delims=" %%v in ('%PY% -c "import sys;print(sys.version.split()[0])" 2^>^&1') do echo   [v] Python %%v   ^(command: %PY%^)
echo   [i] XML import available.
goto :py_done

:no_py
echo   [x] no usable Python 3.6+ found  --^> XML import will NOT work
echo.
echo       Why "exit code 9009": Windows reports 9009 when the command does
echo       not exist. It means gen_tags.py never started. Typical causes:
echo         1. Python is not installed at all
echo         2. Python is installed but "Add python.exe to PATH" was not checked
echo         3. The name python points to the Microsoft Store placeholder alias
echo            (typing python in cmd opens the Store instead of a REPL)
echo.
echo       Fix (any one):
echo         A. Install Python 3.8+ from https://www.python.org/downloads/
echo            and CHECK "Add python.exe to PATH" on the first screen.
echo            Then close this window and run this check again.
echo         B. Python is installed but not in PATH:
echo              set MYX_PYTHON=C:\Python312\python.exe
echo            (permanent: System Properties - Environment Variables)
echo            Restart 2-run-verify.bat afterwards.
echo         C. Manual check: open cmd and run   python -V
echo            It must print "Python 3.x" and must not open the Store.
echo.
set "FAIL=1"
:py_done
echo.

echo ============================================================
if defined FAIL (
  echo   RESULT:  some checks FAILED -^> see [x] lines above
) else (
  echo   RESULT:  all checks passed -^> run 2-run-verify.bat
)
echo ============================================================
echo.
pause
