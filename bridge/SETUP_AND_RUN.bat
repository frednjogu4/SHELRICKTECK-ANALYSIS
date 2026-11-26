@echo off
title Fredrick TRADING - Exness MT5 Bridge
cd /d "%~dp0"
rem Optional: set this once if several MT5 terminals are installed.
rem set "AURUM_MT5_PATH=C:\Program Files\Exness MT5\terminal64.exe"
echo ============================================================
echo  Fredrick TRADING - Exness (MT5) local bridge -- setup + run
echo  Starts MT5 only if it is closed; an open terminal is never stopped.
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
if not exist START_MT5_IF_CLOSED.ps1 (
  echo [X] START_MT5_IF_CLOSED.ps1 is missing; extract the updated complete package.
  pause
  exit /b 1
)

rem The MetaTrader5 connector supports Python 3.8 - 3.13 (3.14/3.15 too new).
set "PY="
for %%V in (3.13 3.12 3.11 3.10) do (
  if not defined PY (
    py -%%V -c "import sys; raise SystemExit(0 if (3,8)<=sys.version_info[:2]<=(3,13) else 2)" >nul 2>nul
    if not errorlevel 1 set "PY=py -%%V"
  )
)
if defined PY goto havepy

for %%D in (Python313 Python312 Python311 Python310) do (
  if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\%%D\python.exe" set "PY="%LOCALAPPDATA%\Programs\Python\%%D\python.exe""
  if not defined PY if exist "%ProgramFiles%\%%D\python.exe" set "PY="%ProgramFiles%\%%D\python.exe""
)
if defined PY goto havepy

py -3 -c "import sys; raise SystemExit(0 if (3,8)<=sys.version_info[:2]<=(3,13) else (2 if sys.version_info[:2]>=(3,14) else 1))" >nul 2>nul
if "%ERRORLEVEL%"=="0" (
  set "PY=py -3"
  goto havepy
)
if "%ERRORLEVEL%"=="2" (
  set "PYVER=3.14+"
  goto toonew
)

python -c "import sys; raise SystemExit(0 if (3,8)<=sys.version_info[:2]<=(3,13) else (2 if sys.version_info[:2]>=(3,14) else 1))" >nul 2>nul
if "%ERRORLEVEL%"=="0" (
  set "PY=python"
  goto havepy
)
if "%ERRORLEVEL%"=="2" (
  set "PYVER=3.14+"
  goto toonew
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
echo [3.6/4] Checking the local UI release...
if not exist "%~dp0app.html" (
  echo [X] app.html is missing next to this file; the local package cannot serve the app.
  echo     Extract the complete latest ZIP and run this file from the extracted folder.
  pause
  exit /b 1
)
if not exist "%~dp0pwa\build.json" (
  echo [!] pwa\build.json is missing - the UI release cannot be verified.
  echo     Re-extract the latest ZIP, or run "npm run build" in the repository.
)
set "AURUM_BUILD_ID="
%PY% -c "import json; print(json.load(open('pwa/build.json', encoding='utf-8')).get('id') or '')" >"%TEMP%\aurum_build_id.txt" 2>nul
if not errorlevel 1 set /p AURUM_BUILD_ID=<"%TEMP%\aurum_build_id.txt"
if defined AURUM_BUILD_ID echo        Local UI release: %AURUM_BUILD_ID% - matches Settings Build and delivery
if not defined AURUM_BUILD_ID echo [!] Local UI release id could not be read from pwa\build.json.
echo [3.5/4] Checking MT5; starting Exness MT5 only if no terminal is open...
if exist "%~dp0terminal_path.txt" set /p AURUM_MT5_PATH=<"%~dp0terminal_path.txt"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0START_MT5_IF_CLOSED.ps1" -PathFile "%~dp0terminal_path.txt"
if errorlevel 1 echo [!] MT5 auto-start check failed; the app and bridge will continue. Open MT5 manually if needed.
if exist "%~dp0terminal_path.txt" set /p AURUM_MT5_PATH=<"%~dp0terminal_path.txt"
if not exist "%~dp0terminal_path.txt" set "AURUM_MT5_PATH="
if defined AURUM_MT5_PATH echo        MT5 target selected; the bridge will attach to that terminal.
echo [4/4] Freeing ports 8787/8788 from any earlier bridge window (normal; it prints nothing)...
powershell -NoProfile -Command "$ports=@(8787,8788);foreach($pt in $ports){$cs=Get-NetTCPConnection -LocalPort $pt -State Listen -ErrorAction SilentlyContinue;if($cs){foreach($id in ($cs|Select-Object -ExpandProperty OwningProcess -Unique)){if($id -gt 0){$p=Get-Process -Id $id -ErrorAction SilentlyContinue;if($p -and $p.ProcessName -notmatch '^(?i)terminal(64)?$'){Stop-Process -Id $id -Force -ErrorAction SilentlyContinue}}}}}" >nul 2>&1
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":8787" ^| findstr "LISTENING"') do taskkill /PID %%P /F >nul 2>&1
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":8788" ^| findstr "LISTENING"') do taskkill /PID %%P /F >nul 2>&1
timeout /t 1 /nobreak >nul
echo        Preparing your bridge token (one-time; saved as bridge_token.txt)...
if exist "%~dp0bridge_token.txt" goto have_bridge_token
%PY% -c "import secrets;print(secrets.token_urlsafe(18))" > "%~dp0bridge_token.txt"
:have_bridge_token
set /p AURUM_BRIDGE_TOKEN=<"%~dp0bridge_token.txt"
if exist "%~dp0..\LOCAL_HOST_ONLY.txt" if not exist "%~dp0..\server\server.js" (
  echo [X] Local-only package is incomplete. The bridge will NOT fall back to Railway.
  pause
  exit /b 1
)
if exist "%~dp0..\server\server.js" goto local_backend
goto fallback_backend
:local_backend
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
goto backend_configured
:fallback_backend
set "AURUM_UPSTREAM=https://aurum-staging.up.railway.app"
set "AURUM_LOCAL_API_AUTH="
set "AURUM_LOCAL_API_TOKEN="
set "AURUM_BRIDGE_ALLOWED_ORIGINS=aurum-staging.up.railway.app"
:backend_configured
echo        Saving the selected Python path for automatic startup...
%PY% -c "import sys; print(sys.executable)" > "%~dp0python_runtime.txt"
if errorlevel 1 (
  echo [X] Could not save the Python path; automatic startup was not installed.
  pause
  exit /b 1
)
set "AURUM_BRIDGE_DIR=%~dp0"
echo        Creating the desktop icon "Fredrick TRADING (local app)" -- use this one-click launcher.
powershell -NoProfile -Command "$b=$env:AURUM_BRIDGE_DIR.TrimEnd('\');$r=Split-Path -Parent $b;$w=New-Object -ComObject WScript.Shell;$s=$w.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Fredrick TRADING (local app).lnk'));$s.TargetPath=(Join-Path $r 'START_ALL_LOCAL.bat');$s.WorkingDirectory=$r;$s.Save()" >nul 2>&1
echo        Installing per-user auto-start -- bridge and app open when Windows signs in...
powershell -NoProfile -Command "$b=$env:AURUM_BRIDGE_DIR.TrimEnd('\');$startup=[Environment]::GetFolderPath('Startup');$shell=New-Object -ComObject WScript.Shell;$s=$shell.CreateShortcut((Join-Path $startup 'Fredrick TRADING AutoStart.lnk'));$s.TargetPath=(Join-Path $b 'AUTO_START.bat');$s.WorkingDirectory=$b;$s.Save()" >nul 2>&1
if errorlevel 1 (
  echo [!] Auto-start shortcut could not be created; check Windows profile permissions.
) else (
  echo        Auto-start installed for the next sign-in; no need to rerun this file.
)
echo.
echo        Starting the bridge. It prints YOUR exact address below.
echo        On THIS PC:  http://127.0.0.1:8788/app
echo        Local app uses its same-origin bridge socket on port 8788.
echo        On a PHONE or tablet on same wifi: use the http://...:8788/app link
echo        the bridge prints -- or the https app with Bridge URL + token.
echo        Bridge token stored locally in bridge_token.txt; do not share it in chat or screenshots.
echo        If Windows asks about the firewall: ALLOW python on Private networks.
echo.
echo        Starting the bridge in its own visible window...
set "PY_EXE="
set /p PY_EXE=<"%~dp0python_runtime.txt"
if defined PY_EXE if exist "%PY_EXE%" goto launch_bridge_exe
start "Fredrick TRADING - Exness MT5 Bridge" %PY% "%~dp0mt5_bridge.py"
goto after_launch_bridge
:launch_bridge_exe
start "Fredrick TRADING - Exness MT5 Bridge" "%PY_EXE%" "%~dp0mt5_bridge.py"
:after_launch_bridge
set /a bridge_tries=0
:wait_for_local_bridge
powershell -NoProfile -Command "try{$r=Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:8788/ready' -TimeoutSec 2;if($r.StatusCode -eq 200 -and $r.Content -match 'AURUM local app bridge ready'){if(-not $env:AURUM_BUILD_ID){exit 0};$b=(Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:8788/build.json' -Headers @{'Cache-Control'='no-cache'} -TimeoutSec 2).Content|ConvertFrom-Json;if($b -and [string]$b.id -eq $env:AURUM_BUILD_ID){exit 0}}}catch{};exit 1" >nul 2>&1
if not errorlevel 1 goto local_bridge_ready
set /a bridge_tries+=1
if %bridge_tries% GEQ 60 goto local_bridge_timeout
timeout /t 1 /nobreak >nul
goto wait_for_local_bridge
:local_bridge_timeout
echo [X] Local app server on port 8788 did not become ready after 60 seconds.
echo     Chrome will NOT be opened to a refused connection. Inspect the separate bridge window.
echo     Send a screenshot of its last lines or a redacted logs\local-startup-*.log; do not send tokens or passwords.
pause
exit /b 1
:local_bridge_ready
echo [OK] Local app server and same-origin bridge endpoint are ready. Opening the app in Chrome...
:open_local_app
echo Opening a fresh local app tab in Chrome (the browser is not force-closed)...
set "AURUM_CHROME="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "AURUM_CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined AURUM_CHROME if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "AURUM_CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined AURUM_CHROME if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "AURUM_CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if defined AURUM_CHROME (
  start "" "%AURUM_CHROME%" --new-tab "http://127.0.0.1:8788/app"
) else (
  echo Chrome was not found in its standard install folders; opening the default browser instead.
  start "" "http://127.0.0.1:8788/app"
)
echo Leave the separate Fredrick TRADING - Exness MT5 Bridge window open.
pause
