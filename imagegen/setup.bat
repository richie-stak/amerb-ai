@echo off
cd /d "%~dp0"
echo Creating Python virtual environment for AMERB AI image generation...
python -m venv venv
echo Installing PyTorch (CPU build)...
venv\Scripts\python.exe -m pip install --upgrade pip
venv\Scripts\python.exe -m pip install torch --index-url https://download.pytorch.org/whl/cpu
echo Installing diffusers, transformers, and the web service...
venv\Scripts\python.exe -m pip install diffusers transformers accelerate safetensors flask pillow
echo.
echo Setup complete. Run start.bat to launch the service.
echo (The model itself downloads on first use of start.bat, not here.)
