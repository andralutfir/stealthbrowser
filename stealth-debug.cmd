@echo off
rem Open one browser and record its activity into the logs\ folder.
setlocal
cd /d "%~dp0"
node "src\index.js" --debug %*
if errorlevel 1 pause
