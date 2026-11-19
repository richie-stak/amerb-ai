@echo off
rem Repairs an AMERB AI service that was installed but left stopped / without its start type and
rem crash-restart policy, then starts it and checks the app answers.
rem Asks for Administrator rights by itself (UAC prompt), then runs "npm run service:repair".
rem Options:  repair-service.bat --no-start
rem (From an Administrator terminal instead:  npm run service:repair -- --no-start)
cd /d "%~dp0"
title AMERB AI - repair Windows service

net session >nul 2>&1
if errorlevel 1 (
  echo Administrator rights are needed to repair a service - requesting them now...
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

call npm run service:repair -- %*
echo.
echo Exit code: %errorlevel%
pause
