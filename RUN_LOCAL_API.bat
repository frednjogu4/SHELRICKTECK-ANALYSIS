@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%APPDATA%\npm;%PATH%"
where node >nul 2>&1
if errorlevel 1 if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "PATH=%LOCALAPPDATA%\Programs\nodejs;%APPDATA%\npm;%PATH%"
set "HOST=127.0.0.1"
set "PORT=4100"
if not defined ENVIRONMENT set "ENVIRONMENT=real"
if not defined DERIV_TRADING_ENABLED set "DERIV_TRADING_ENABLED=true"
if not defined DERIV_ALLOW_BROWSER_EXEC set "DERIV_ALLOW_BROWSER_EXEC=true"
if not exist logs mkdir logs
set "API_LOG=%~dp0logs\local-api.log"
echo [%date% %time%] Starting local API on %HOST%:%PORT% (ENVIRONMENT=%ENVIRONMENT%, DERIV_TRADING_ENABLED=%DERIV_TRADING_ENABLED%) >> "%API_LOG%"
node server\server.js >> "%API_LOG%" 2>&1
set "API_EXIT=%ERRORLEVEL%"
echo [%date% %time%] Local API exited with code %API_EXIT%. >> "%API_LOG%"
echo.
echo AURUM Local API stopped with exit code %API_EXIT%.
echo Details were saved to logs\local-api.log.
pause
exit /b %API_EXIT%
