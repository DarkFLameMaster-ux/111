@echo off
setlocal
cd /d "%~dp0"
call npm --prefix frontend\display run build
if errorlevel 1 exit /b %errorlevel%
call npm --prefix frontend\subscription run build
