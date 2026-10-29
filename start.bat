@echo off
rem Starts AMERB AI on Windows. All the real work (installing dependencies for this machine,
rem checking Ollama, starting the image service) is in scripts\launch.js, shared with start.sh.
cd /d "%~dp0"
title AMERB AI

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install Node.js 22.5 or newer from https://nodejs.org and run this again.
  pause
  exit /b 1
)

node scripts\launch.js %*
echo.
echo AMERB AI has stopped.
pause
