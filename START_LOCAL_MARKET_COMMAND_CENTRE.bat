@echo off
setlocal EnableExtensions
title Shelricktech Market Command Centre - Local Dashboard
cd /d "%~dp0"
set "PROJECT_ROOT=%~dp0"
set "APP_URL=http://127.0.0.1:8788/app"
set "PORT=8788"

echo ============================================================
echo  SHELRICKTECH MARKET COMMAND CENTRE
echo  Local dashboard only - no broker bridge or MT5 is started.
echo  Keep the Wrangler window open while using the dashboard.
echo ============================================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js is not installed or is not on PATH.
  echo Install the supported Node.js LTS release, reopen this window, and retry.
  pause
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo [ERROR] npm was not found. Repair the Node.js installation and retry.
  pause
  exit /b 1
)

if not exist "%PROJECT_ROOT%package.json" (
  echo [ERROR] package.json is missing. Run this file from the project root.
  pause
  exit /b 1
)
if not exist "%PROJECT_ROOT%package-lock.json" (
  echo [ERROR] package-lock.json is missing. Refusing an unpinned dependency install.
  pause
  exit /b 1
)
if not exist "%PROJECT_ROOT%wrangler.jsonc" (
  echo [ERROR] wrangler.jsonc is missing.
  pause
  exit /b 1
)

echo [INFO] Node:
node --version
echo [INFO] npm:
npm --version
echo.

echo [1/5] Checking local build dependencies...
node --input-type=module -e "await import('vite'); await import('wrangler/bin/wrangler.js')" >nul 2>&1
if errorlevel 1 (
  echo [INFO] Dependencies are missing or incomplete. Running npm ci...
  call npm ci --no-audit --no-fund
  if errorlevel 1 (
    echo [ERROR] npm ci failed. No server was started.
    pause
    exit /b 1
  )
)

echo.
echo [2/5] Building the current application...
call npm run build
if errorlevel 1 (
  echo [ERROR] Build failed. The old build will not be served.
  pause
  exit /b 1
)

echo.
echo [3/5] Verifying the generated distribution...
call npm run verify:dist
if errorlevel 1 (
  echo [ERROR] dist verification failed. The server will not start.
  pause
  exit /b 1
)

echo.
echo [4/5] Checking local port %PORT%...
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command ^
  "$c=Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue; if($c){$ids=@($c.OwningProcess|Sort-Object -Unique); foreach($id in $ids){$p=Get-Process -Id $id -ErrorAction SilentlyContinue; Write-Host ('Port %PORT% is occupied by PID '+$id+' '+$p.ProcessName)}; exit 1}; exit 0"
if errorlevel 1 (
  echo [ERROR] Port %PORT% is already in use. No process was stopped.
  echo Close the known old local dashboard yourself, then run this launcher again.
  pause
  exit /b 1
)

echo.
echo [5/5] Starting the local Cloudflare Worker and dashboard...
start "Shelricktech Local Dashboard - Wrangler" /D "%PROJECT_ROOT%" cmd /k "npm exec -- wrangler dev --config wrangler.jsonc --ip 127.0.0.1 --port %PORT%"

echo Waiting for %APP_URL% to respond...
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command ^
  "$uri='%APP_URL%'; $until=(Get-Date).AddSeconds(75); do { try { $r=Invoke-WebRequest -Uri $uri -UseBasicParsing -TimeoutSec 3; if($r.StatusCode -eq 200){exit 0} } catch {}; Start-Sleep -Seconds 2 } while((Get-Date)-lt $until); exit 1"
if errorlevel 1 (
  echo [ERROR] The dashboard did not become ready within 75 seconds.
  echo Check the Wrangler window for the actual startup error. No broker service was started.
  pause
  exit /b 1
)

echo.
echo [SUCCESS] Market Command Centre is responding:
echo %APP_URL%
start "" "%APP_URL%"
echo.
echo Leave the Wrangler window open. Close it only when you want to stop the local dashboard.
echo This launcher does not start MT5, a broker bridge, or order-execution services.
echo.
pause
exit /b 0
