@echo off
setlocal
cd /d "%~dp0"
if not exist server\server.js (
  echo [X] Local API source is missing. Extract the complete local-host bundle.
  exit /b 1
)
where node >nul 2>&1
if errorlevel 1 (
  echo [X] Node.js is not installed. Install Node.js 20 LTS or newer from https://nodejs.org/ and run this again.
  exit /b 1
)
where npm >nul 2>&1
if errorlevel 1 (
  echo [X] npm was not found. Repair the Node.js installation and ensure it is on PATH.
  exit /b 1
)
node -e "process.exit(Number(process.versions.node.split('.')[0])>=20?0:1)"
if errorlevel 1 (
  echo [X] Node.js 20 or newer is required. Update Node.js, then retry.
  exit /b 1
)
powershell -NoProfile -Command "try{$j=Invoke-RestMethod 'http://127.0.0.1:4100/api/health' -TimeoutSec 2;if($j.ok -eq $true -and $j.live_feed -eq 'deriv-public'){exit 0}}catch{};exit 1" >nul 2>&1
if not errorlevel 1 exit /b 0
if not exist node_modules\express\package.json (
  echo [1/2] Installing production Node dependencies (first run needs internet)...
  call npm ci --omit=dev --no-audit --no-fund
  if errorlevel 1 (
    echo [X] npm install failed. Check internet and re-run START_LOCAL_API.bat.
    exit /b 1
  )
)
if not exist node_modules\ws\package.json (
  echo [1/2] Repairing production Node dependencies...
  call npm ci --omit=dev --no-audit --no-fund
  if errorlevel 1 exit /b 1
)
echo [2/2] Starting AURUM API on 127.0.0.1:4100 (not exposed to the LAN)...
start "Fredrick AURUM Local API" /min "%ComSpec%" /c ""%~dp0RUN_LOCAL_API.bat""
powershell -NoProfile -Command "$until=(Get-Date).AddSeconds(45);while((Get-Date)-lt $until){try{$j=Invoke-RestMethod 'http://127.0.0.1:4100/api/health' -TimeoutSec 2;if($j.ok -eq $true -and $j.live_feed -eq 'deriv-public'){exit 0}}catch{};Start-Sleep -Seconds 1};exit 1" >nul 2>&1
if errorlevel 1 (
  echo [X] The local API did not answer health checks. See the minimized API window.
  echo     The bridge will NOT fall back to Railway.
  exit /b 1
)
echo [OK] Local API ready on loopback. API port 4100 is not open to other devices.
exit /b 0
