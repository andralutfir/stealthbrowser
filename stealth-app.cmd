@echo off
rem Open the control panel: settings and launcher in one window.
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (
  echo.
  echo   Node.js 18 or newer is required and was not found on PATH.
  echo   Install it from https://nodejs.org and run this again.
  echo.
  pause
  exit /b 1
)
node src\index.js --app %*
