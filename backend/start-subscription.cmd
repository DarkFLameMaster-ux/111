@echo off
setlocal
cd /d "%~dp0.."
set PY=%RESLIB_PYTHON%
if "%PY%"=="" set PY=F:\资源_项目\_归档脚本\.venv\Scripts\python.exe
if not exist "%PY%" set PY=python
if "%RESLIB_SUB_HOST%"=="" set RESLIB_SUB_HOST=127.0.0.1
if "%RESLIB_SUB_PORT%"=="" set RESLIB_SUB_PORT=8781
"%PY%" backend\subscription\server.py
