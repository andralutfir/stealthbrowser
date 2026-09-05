@echo off
rem Build StealthBrowser.exe using the C# compiler that ships with Windows.
rem No SDK, no toolchain, no packages - same zero-dependency rule as the rest
rem of the project. Run this once; the .exe is then self-contained.
setlocal
cd /d "%~dp0"

set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" (
  echo.
  echo   csc.exe not found. It ships with the .NET Framework 4 that is built
  echo   into Windows 8 and later. On older systems, install .NET Framework 4.
  echo.
  pause
  exit /b 1
)

set "REFS=/reference:System.dll /reference:System.Core.dll /reference:System.Drawing.dll /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll"

echo Building StealthBrowser.exe ...
"%CSC%" /nologo /target:winexe /optimize+ /out:StealthBrowser.exe %REFS% "gui\StealthBrowser.cs"
if errorlevel 1 (
  echo.
  echo   Build failed.
  if not "%~1"=="/quiet" pause
  exit /b 1
)

echo.
echo   Done: %CD%\StealthBrowser.exe
echo   Double-click it to configure and launch.
echo.
if not "%~1"=="/quiet" pause
