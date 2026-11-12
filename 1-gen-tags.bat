@echo off
chcp 65001 >nul
title Step 1 - Build tag tables from symbol XML
cd /d "%~dp0"

echo ============================================================
echo   Step 1 / Generate tag tables from CODESYS symbol XML
echo ============================================================
echo.
echo   input : example\*.Device.Application.xml
echo   output: server\gen\*.tags.json            (tags / symbols / types)
echo           out\^<APP^>\tag_table.json           (full table + CSV + layout)
echo           server\profiles\^<APP^>.profile.json (point selection profile)
echo.

rem ---- locate a workable python 3 ----
rem   "where python" is NOT a valid check: on Windows the name python may resolve
rem   to %LOCALAPPDATA%\Microsoft\WindowsApps\python.exe, a 0-byte Store alias
rem   that exits with 9009 and prints nothing when Python is not installed.
set "PY="
if not defined MYX_PYTHON goto :try_python
"%MYX_PYTHON%" -c "import sys;sys.exit(0 if sys.version_info>=(3,6) else 1)" >nul 2>nul
if errorlevel 1 goto :bad_env_py
set "PY=%MYX_PYTHON%"
goto :py_found
:bad_env_py
echo [!] MYX_PYTHON is set but not usable: %MYX_PYTHON%
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

:no_py
echo [x] no usable Python 3.6+ found.
echo     Install Python 3.8+ from python.org and CHECK "Add python.exe to PATH".
echo     Already installed? Set MYX_PYTHON=C:\Python312\python.exe and retry.
echo     Detail: run 0-check-env.bat
echo.
pause
exit /b 1

:py_found
for /f "delims=" %%v in ('%PY% -c "import sys;print(sys.version.split()[0])" 2^>^&1') do echo [v] Python %%v  ^(cmd: %PY%^)

if not "%~1"=="" (
  echo [.] using XML: %~1
  %PY% tools\gen_tags.py "%~1"
) else (
  echo [.] scanning example\ and Test\ for symbol configuration XML ...
  %PY% tools\gen_tags.py --all
)

if errorlevel 1 (
  echo.
  echo [x] generation failed. Make sure the XML was exported from
  echo     CODESYS "Symbol Configuration" ^(root node Symbolconfiguration^).
  echo.
  pause
  exit /b 1
)

echo.
echo -- generated --
dir /b server\gen\*.tags.json 2>nul
echo.
echo [v] done. Next: double-click 2-run-verify.bat
echo.
pause
