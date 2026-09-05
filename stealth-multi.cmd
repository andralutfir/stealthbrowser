@echo off
rem Open several browsers at once, each with its own identity, tiled as columns.
setlocal
cd /d "%~dp0"
set /p COUNT="How many browsers? [3] "
if "%COUNT%"=="" set COUNT=3
node "src\index.js" --count %COUNT% %*
if errorlevel 1 pause
