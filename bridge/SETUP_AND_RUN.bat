@echo off
title Fredrick TRADING - Exness MT5 Bridge
cd /d "%~dp0"
rem Optional: uncomment and replace with the exact local Exness terminal64.exe path.
rem set "AURUM_MT5_PATH=C:\path\to\Exness\terminal64.exe"
echo ============================================================
echo  Fredrick TRADING - Exness (MT5) local bridge -- setup + run
echo  Keep MetaTrader 5 open and logged in FIRST.
echo  LEAVE THIS WINDOW OPEN during local read-only verification.
echo ============================================================
echo.
echo [0/4] Folder: %CD%
if not exist requirements.txt (
  echo [X] requirements.txt is MISSING here.
  echo     You are probably running from INSIDE the zip.
  echo     Fix: right-click the zip - Extract All - open the new folder -
  echo     run SETUP_AND_RUN.bat from there.
  pause
  exit /b 1
)
if not exist AUTO_START.bat (
  echo [X] AUTO_START.bat is missing; extract the full latest ZIP before running setup.
  pause
  exit /b 1
)

rem The MetaTrader5 connector supports Python 3.8 - 3.13 (3.14/3.15 too new).
set "PY="
for %%V in (3.13 3.12 3.11) do (
  if not defined PY (
    py -%%V --version >nul 2>nul
    if not errorlevel 1 set "PY=py -%%V"
  )
)
if defined PY goto havepy

set "PYVER="
py -3 --version >"%TEMP%\aurum_py.txt" 2>&1
if not errorlevel 1 for /f "usebackq tokens=2" %%A in ("%TEMP%\aurum_py.txt") do set "PYVER=%%A"
if defined PYVER if "%PYVER:~0,4%"=="3.14" goto toonew
if defined PYVER if "%PYVER:~0,4%"=="3.15" goto toonew
if defined PYVER (
  set "PY=py -3"
  goto havepy
)
set "PYVER="
python --version >"%TEMP%\aurum_py.txt" 2>&1
for /f "usebackq tokens=2" %%A in ("%TEMP%\aurum_py.txt") do set "PYVER=%%A"
if defined PYVER if "%PYVER:~0,4%"=="3.14" goto toonew
if defined PYVER if "%PYVER:~0,4%"=="3.15" goto toonew
if defined PYVER (
  set "PY=python"
  goto havepy
)

echo.
echo [X] PYTHON IS NOT INSTALLED on this PC -- that is the problem.
echo     Your browser is now downloading the correct Python installer (3.13).
echo     Then: 1. run that downloaded installer
echo           2. ON THE FIRST SCREEN TICK: Add python.exe to PATH
echo           3. click Install Now, wait, then run this SETUP_AND_RUN.bat again
echo.
start "" "https://www.python.org/ftp/python/3.13.15/python-3.13.15-amd64.exe"
pause
exit /b 1

:toonew
echo.
echo [X] Your Python (%PYVER%) is TOO NEW for the MetaTrader5 connector.
echo     MetaTrader5 supports Python 3.8 - 3.13 only. Your browser is now
echo     downloading Python 3.13 -- you can KEEP both, no need to uninstall.
echo     Then: 1. run the downloaded python-3.13 installer
echo           2. ON THE FIRST SCREEN TICK: Add python.exe to PATH
echo           3. click Install Now, wait, then run this SETUP_AND_RUN.bat again
echo     (If no download started, go to python.org/downloads/windows and get
echo      "Python 3.13.15 - Windows installer (64-bit)".)
echo.
start "" "https://www.python.org/ftp/python/3.13.15/python-3.13.15-amd64.exe"
pause
exit /b 1

:havepy
echo [1/4] Python OK:
%PY% --version
echo [2/4] Installing requirements -- first run can take a minute, needs internet...
%PY% -m pip install -r requirements.txt --disable-pip-version-check
if errorlevel 1 (
  echo [X] pip install FAILED. The two usual causes:
  echo     1. no internet on this PC right now -- connect, then run again
  echo     2. Python was installed WITHOUT Add python.exe to PATH --
  echo        reinstall Python, TICK that box on the first screen, run again
  pause
  exit /b 1
)
echo [3/4] Checking the MT5 connector...
%PY% -c "import MetaTrader5, websockets; print('connector ok')"
if errorlevel 1 (
  echo [X] The MetaTrader5 connector did not load.
  echo     Make sure the Exness MetaTrader 5 TERMINAL is installed on this PC.
  echo     Open it once and log in, then run this file again.
  pause
  exit /b 1
)
echo [4/4] Freeing ports 8787/8788 from any earlier bridge window (normal; it prints nothing)...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":8787" ^| findstr "LISTENING"') do taskkill /PID %%P /F >nul 2>&1
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":8788" ^| findstr "LISTENING"') do taskkill /PID %%P /F >nul 2>&1
echo        Preparing your bridge token (one-time; saved as bridge_token.txt)...
if not exist "%~dp0bridge_token.txt" (
  %PY% -c "import secrets;print(secrets.token_urlsafe(18))" > "%~dp0bridge_token.txt"
)
set /p AURUM_BRIDGE_TOKEN=<"%~dp0bridge_token.txt"
if exist "%~dp0..\LOCAL_HOST_ONLY.txt" if not exist "%~dp0..\server\server.js" (
  echo [X] Local-only package is incomplete. The bridge will NOT fall back to Railway.
  pause
  exit /b 1
)
if exist "%~dp0..\server\server.js" (
  echo        Local backend found -- checking the Express API on loopback...
  call "%~dp0..\START_LOCAL_API.bat"
  if errorlevel 1 (
    echo [X] Local API did not start. The bridge will NOT fall back to Railway.
    pause
    exit /b 1
  )
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
echo        Saving the selected Python path for automatic startup...
%PY% -c "import sys; print(sys.executable)" > "%~dp0python_runtime.txt"
if errorlevel 1 (
  echo [X] Could not save the Python path; automatic startup was not installed.
  pause
  exit /b 1
)
echo        Creating the desktop icon "Fredrick TRADING (local app)" -- ALWAYS use that one.
powershell -NoProfile -Command "$w=New-Object -ComObject WScript.Shell;$s=$w.CreateShortcut([Environment]::GetFolderPath('Desktop')+'\Fredrick TRADING (local app).lnk');$s.TargetPath='%~dp0AUTO_START.bat';$s.WorkingDirectory='%~dp0';$s.Save()" >nul 2>&1
echo        Installing per-user auto-start (bridge + app open when Windows signs in)...
powershell -NoProfile -Command "$startup=[Environment]::GetFolderPath('Startup');$shell=New-Object -ComObject WScript.Shell;$s=$shell.CreateShortcut((Join-Path $startup 'Fredrick TRADING AutoStart.lnk'));$s.TargetPath='%~dp0AUTO_START.bat';$s.WorkingDirectory='%~dp0';$s.Save()" >nul 2>&1
if errorlevel 1 (
  echo [!] Auto-start shortcut could not be created; check Windows profile permissions.
) else (
  echo        Auto-start installed for the next sign-in; no need to rerun this file.
)
echo.
echo        Starting the bridge. It prints YOUR exact address below.
echo        On THIS PC:  http://127.0.0.1:8788/app
echo        Local Bridge URL in the app: ws://127.0.0.1:8787
echo        On a PHONE or tablet (same wifi): use the http://...:8788/app link
echo        the bridge prints -- or the https app with Bridge URL + token.
echo        Bridge token stored locally in bridge_token.txt; do not share it in chat or screenshots.
echo        If Windows asks about the firewall: ALLOW python on Private networks.
echo.
%PY% mt5_bridge.py
echo.
echo === Bridge stopped. Exit code: %errorlevel% ===
echo If it never said "listening":
echo   - is MetaTrader 5 OPEN and logged in? Open it, log in, run this again
echo   - send a screenshot of this whole window to the assistant
pause
