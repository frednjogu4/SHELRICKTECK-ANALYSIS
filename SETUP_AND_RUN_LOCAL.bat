@echo off
rem Single entry point for the complete PC-local API + Exness bridge setup.
call "%~dp0START_ALL_LOCAL.bat" %*
exit /b %ERRORLEVEL%
