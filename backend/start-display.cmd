@echo off
setlocal
cd /d "%~dp0.."
set PY=%RESLIB_PYTHON%
if "%PY%"=="" set PY=F:\资源_项目\_归档脚本\.venv\Scripts\python.exe
if not exist "%PY%" set PY=python
set RESLIB_DISPLAY_DIST=%~dp0..\frontend\display\dist\index.html
if "%RESLIB_HOST%"=="" set RESLIB_HOST=0.0.0.0
if "%RESLIB_PORT%"=="" set RESLIB_PORT=8777
"%PY%" backend\display\server.py
