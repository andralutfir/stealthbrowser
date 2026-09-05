@echo off
rem Open one disposable browser. All arguments are passed to the launcher.
rem Example: stealth.cmd https://duckduckgo.com --interface wifi
setlocal
cd /d "%~dp0"
node "src\index.js" %*
if errorlevel 1 pause
