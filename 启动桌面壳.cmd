@echo off
setlocal
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo [资源库] 首次启动需要安装桌面壳依赖……
  call npm ci
  if errorlevel 1 (
    echo [资源库] 依赖安装失败，请检查 Node.js 和网络设置。
    pause
    exit /b 1
  )
  if not exist "node_modules\electron\dist\electron.exe" call npm rebuild electron --foreground-scripts
  if not exist "node_modules\electron\dist\electron.exe" (
    echo [资源库] Electron 下载未完成，请重新运行此启动文件。
    pause
    exit /b 1
  )
)
call npm run build
if errorlevel 1 (
  echo [资源库] 界面构建失败，请检查错误信息后重试。
  pause
  exit /b 1
)
call npm run desktop
