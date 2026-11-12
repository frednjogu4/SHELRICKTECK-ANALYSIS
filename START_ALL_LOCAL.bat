@echo off
title Fredrick TRADING - Start all local services
setlocal
cd /d "%~dp0"
set "AURUM_ROOT=%~dp0"

if not exist "%~dp0bridge\SETUP_AND_RUN.bat" (
  echo [X] bridge\SETUP_AND_RUN.bat is missing.
  echo     Extract the complete local package, then run START_ALL_LOCAL.bat from its top folder.
  pause
  exit /b 1
)
if not exist "%~dp0server\server.js" (
  echo [X] server\server.js is missing. This local-only package is incomplete.
  pause
  exit /b 1
)
if not exist "%~dp0package.json" (
  echo [X] package.json is missing. Extract the complete local package first.
  pause
  exit /b 1
)

echo ============================================================
echo  Fredrick TRADING - one-click local startup
echo  Starts MT5 only if closed, then checks the API and private bridge.
echo  It opens a fresh Chrome tab once the local app on port 8788 is ready.
echo  Nothing is exposed publicly; keep this window open.
echo ============================================================
echo.

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Continue'; $root=$env:AURUM_ROOT; $logDir=Join-Path $root 'logs'; New-Item -ItemType Directory -Force -Path $logDir | Out-Null; $log=Join-Path $logDir ('local-startup-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log'); $entry=Join-Path $root 'bridge\SETUP_AND_RUN.bat'; Start-Transcript -Path $log -Force | Out-Null; Write-Host ('Startup log: ' + $log); Write-Host 'Running the complete setup and launch sequence...'; & $entry; $rc=$LASTEXITCODE; Stop-Transcript | Out-Null; if ($null -eq $rc) { $rc=0 }; exit $rc"
set "RC=%ERRORLEVEL%"
echo.
echo Startup sequence ended with exit code %RC%.
echo The diagnostic log is in the package's logs folder.
echo Do not send bridge_token.txt, broker passwords, or unredacted account details.
if not "%RC%"=="0" pause
exit /b %RC%
