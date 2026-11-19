@echo off
rem Removes the AMERB AI Windows service (app files, data and logs are kept).
rem Asks for Administrator rights by itself (UAC prompt), then runs "npm run service:uninstall".
cd /d "%~dp0"
title AMERB AI - remove Windows service

net session >nul 2>&1
if errorlevel 1 (
  echo Administrator rights are needed to remove a service - requesting them now...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  if errorlevel 1 (
    echo.
    echo Could not get Administrator rights. Right-click this file and choose "Run as administrator".
    pause
  )
  exit /b
)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or not on PATH. Install Node.js 22.5 or newer from https://nodejs.org
  pause
  exit /b 1
)

call npm run service:uninstall
echo.
echo Exit code: %errorlevel%
pause
