@echo off
cd /d "%~dp0"
rem A venv made on another OS (e.g. copied from Linux) can't be used here - start fresh.
if exist "venv" if not exist "venv\Scripts\python.exe" (
  echo Removing a Python environment that was created on a different operating system...
  rmdir /s /q venv
)
echo Creating Python virtual environment for AMERB AI image generation...
python -m venv venv
echo Installing PyTorch (CPU build)...
venv\Scripts\python.exe -m pip install --upgrade pip
venv\Scripts\python.exe -m pip install torch --index-url https://download.pytorch.org/whl/cpu
echo Installing diffusers, transformers, and the web service...
venv\Scripts\python.exe -m pip install diffusers transformers accelerate safetensors flask pillow
echo.
echo Setup complete. The image service now starts automatically with ..\start.bat
echo (The model itself downloads on first use, not here.)
