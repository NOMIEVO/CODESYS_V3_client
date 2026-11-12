@echo off
chcp 65001 >nul
title Step 3 - Self test
cd /d "%~dp0"

echo ============================================================
echo   Step 3 / Self test (cases picked by what is available)
echo ============================================================
echo.
echo   offline only (no server, no PLC):
echo       3-self-test.bat offline
echo   everything (server running + Chrome + PLC online):
echo       3-self-test.bat all
echo.

if /i "%~1"=="offline" (
  node tests\run-all.js --offline
) else if /i "%~1"=="all" (
  node tests\run-all.js --all
) else (
  node tests\run-all.js
)

echo.
echo [i] exit code 0 = all passed; non-zero = some case failed (see x lines)
echo.
pause
