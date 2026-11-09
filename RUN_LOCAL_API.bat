@echo off
setlocal
cd /d "%~dp0"
set "HOST=127.0.0.1"
set "PORT=4100"
node server\server.js
echo.
echo AURUM Local API stopped with exit code %errorlevel%.
pause
