@echo off
setlocal
powershell -NoProfile -Command "$p=Join-Path ([Environment]::GetFolderPath('Startup')) 'Fredrick TRADING AutoStart.lnk';Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue"
echo Fredrick TRADING auto-start has been removed for this Windows user.
echo This does not delete bridge_token.txt or stop a bridge that is currently running.
pause
