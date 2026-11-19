@echo off
rem Installs AMERB AI as a Windows service (starts at boot, restarts on crash).
rem Asks for Administrator rights by itself (UAC prompt), then runs "npm run service:install".
rem Extra options are passed through, e.g.:  install-service.bat --user ".\name" --password "..." --no-start
rem (For passwords containing quotes or special characters, use an Administrator terminal instead:
rem  npm run service:install -- --user "DOMAIN\name" --password "...")
cd /d "%~dp0"
title AMERB AI - install Windows service

net session >nul 2>&1
if errorlevel 1 (
  echo Administrator rights are needed to install a service - requesting them now...
  if "%~1"=="" (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  ) else (
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -ArgumentList '%*' -Verb RunAs"
  )
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

call npm run service:install -- %*
echo.
echo Exit code: %errorlevel%
pause
