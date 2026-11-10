@echo off
setlocal
cd /d "%~dp0"
set "HOST=127.0.0.1"
set "PORT=4100"
if not exist logs mkdir logs
set "API_LOG=%~dp0logs\local-api.log"
echo [%date% %time%] Starting local API on %HOST%:%PORT% >> "%API_LOG%"
node server\server.js >> "%API_LOG%" 2>&1
set "API_EXIT=%ERRORLEVEL%"
echo [%date% %time%] Local API exited with code %API_EXIT%. >> "%API_LOG%"
echo.
echo AURUM Local API stopped with exit code %API_EXIT%.
echo Details were saved to logs\local-api.log.
pause
exit /b %API_EXIT%
