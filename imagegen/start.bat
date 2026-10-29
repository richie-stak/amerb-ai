@echo off
cd /d "%~dp0"
echo Starting AMERB AI image generation service...
echo First run downloads model weights (a few GB) - this can take a while.
venv\Scripts\python.exe service.py
