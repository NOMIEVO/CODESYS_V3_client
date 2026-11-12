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

where python >nul 2>nul
if errorlevel 1 (
  echo [x] python not found.
  echo     Install Python 3.8+ and check "Add python.exe to PATH".
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('python --version 2^>^&1') do echo [v] %%v

if not "%~1"=="" (
  echo [.] using XML: %~1
  python tools\gen_tags.py "%~1"
) else (
  echo [.] scanning example\ and Test\ for symbol configuration XML ...
  python tools\gen_tags.py --all
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
