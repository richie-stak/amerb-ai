@echo off
cd /d "%~dp0"

echo ============================================
echo   Starting AMERB AI
echo ============================================
echo.

if not exist "node_modules" (
  echo node_modules not found - running "npm install" first...
  call npm install
  echo.
)

if exist "imagegen\venv\Scripts\python.exe" (
  echo Starting the image generation service in its own window...
  start "AMERB AI - Image Generation" cmd /k "cd /d "%~dp0imagegen" && venv\Scripts\python.exe service.py"
) else (
  echo Image generation isn't set up yet - skipping it.
  echo ^(Run imagegen\setup.bat once if you want local image generation. Everything else works without it.^)
)

echo.
echo Starting the main AMERB AI server in its own window...
start "AMERB AI - Server" cmd /k "cd /d "%~dp0" && node server\index.js"

echo Waiting for it to come up, then opening https://localhost:3000 ...
ping -n 4 127.0.0.1 >nul
start "" "https://localhost:3000"

echo.
echo ============================================
echo   AMERB AI is starting in separate windows:
echo     - "AMERB AI - Server"            (the app itself - keep this open)
echo     - "AMERB AI - Image Generation"  (only needed to generate images)
echo   Make sure Ollama is running too (it usually starts automatically).
echo   Close those windows, or Ctrl+C inside them, to stop AMERB AI.
echo.
echo   AMERB AI now runs over HTTPS with a self-signed certificate.
echo   Your browser will show a security warning the first time -
echo   this is expected for a self-signed cert. See README.md for
echo   how to trust it (recommended if other staff will use this too).
echo ============================================
echo.
pause
