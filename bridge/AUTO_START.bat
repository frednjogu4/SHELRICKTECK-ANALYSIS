@echo off
setlocal
cd /d "%~dp0"
if not exist "%~dp0mt5_bridge.py" exit /b 1
if not exist "%~dp0bridge_token.txt" exit /b 1
if not exist "%~dp0python_runtime.txt" exit /b 1
set /p PY_EXE=<"%~dp0python_runtime.txt"
if not exist "%PY_EXE%" exit /b 1
set /p AURUM_BRIDGE_TOKEN=<"%~dp0bridge_token.txt"
if exist "%~dp0..\LOCAL_HOST_ONLY.txt" if not exist "%~dp0..\server\server.js" exit /b 1
if exist "%~dp0..\server\server.js" (
  call "%~dp0..\START_LOCAL_API.bat"
  if errorlevel 1 exit /b 1
  set "AURUM_UPSTREAM=http://127.0.0.1:4100"
  set "AURUM_LOCAL_API_AUTH=1"
  set "AURUM_LOCAL_API_TOKEN=%AURUM_BRIDGE_TOKEN%"
  set "AURUM_BRIDGE_ALLOWED_ORIGINS="
) else (
  set "AURUM_UPSTREAM=https://aurum-staging.up.railway.app"
  set "AURUM_LOCAL_API_AUTH="
  set "AURUM_LOCAL_API_TOKEN="
  set "AURUM_BRIDGE_ALLOWED_ORIGINS=aurum-staging.up.railway.app"
)
rem Reuse an already healthy local bridge; otherwise start one minimized.
powershell -NoProfile -Command "try{$r=Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:8788/up' -TimeoutSec 2;if($r.Content -match 'AURUM bridge is UP'){exit 0}}catch{};exit 1" >nul 2>&1
if not errorlevel 1 goto open_app
start "Fredrick TRADING - Exness MT5 Bridge" /min "%PY_EXE%" "%~dp0mt5_bridge.py"
set /a tries=0
:wait_for_bridge
powershell -NoProfile -Command "try{$r=Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:8788/up' -TimeoutSec 2;if($r.Content -match 'AURUM bridge is UP'){exit 0}}catch{};exit 1" >nul 2>&1
if not errorlevel 1 goto open_app
set /a tries+=1
if %tries% GEQ 12 goto open_app
timeout /t 1 /nobreak >nul
goto wait_for_bridge
:open_app
start "" "http://127.0.0.1:8788/app"
exit /b 0
