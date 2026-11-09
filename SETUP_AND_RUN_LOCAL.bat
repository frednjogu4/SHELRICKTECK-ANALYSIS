@echo off
title Fredrick TRADING - PC-local analysis + Exness bridge
cd /d "%~dp0"
echo ============================================================
echo  Fredrick TRADING - fully PC-local analysis system
echo  Node/Express analysis API: 127.0.0.1:4100 (loopback only)
echo  Exness bridge: PC/private LAN only; no port forwarding
echo ============================================================
echo.
if not exist bridge\SETUP_AND_RUN.bat (
  echo [X] The bridge folder is missing. Extract the complete local-host ZIP first.
  pause
  exit /b 1
)
if not exist server\server.js (
  echo [X] The local API files are missing. This setup will not fall back to Railway.
  pause
  exit /b 1
)
if not exist package.json (
  echo [X] package.json is missing. Extract the complete local-host ZIP first.
  pause
  exit /b 1
)
echo This setup installs the local Python and Node requirements if needed.
echo It checks the API before starting the bridge and will NOT fall back to Railway.
echo.
call "%~dp0bridge\SETUP_AND_RUN.bat"
