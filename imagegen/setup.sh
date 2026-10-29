#!/usr/bin/env sh
# Linux/macOS version of setup.bat: creates the Python environment for local image generation.
cd "$(dirname "$0")" || exit 1

PYTHON=python3
command -v "$PYTHON" >/dev/null 2>&1 || PYTHON=python
if ! command -v "$PYTHON" >/dev/null 2>&1; then
  echo "Python 3 is not installed. Install it (e.g. sudo apt install python3 python3-venv) and run this again."
  exit 1
fi

# A venv made on another OS (e.g. copied from Windows) can't be used here — start fresh.
if [ -d venv ] && [ ! -x venv/bin/python ]; then
  echo "Removing a Python environment that was created on a different operating system..."
  rm -rf venv
fi

echo "Creating Python virtual environment for AMERB AI image generation..."
"$PYTHON" -m venv venv || { echo "Could not create the venv (on Debian/Ubuntu: sudo apt install python3-venv)"; exit 1; }
echo "Installing PyTorch (CPU build)..."
venv/bin/python -m pip install --upgrade pip
venv/bin/python -m pip install torch --index-url https://download.pytorch.org/whl/cpu
echo "Installing diffusers, transformers, and the web service..."
venv/bin/python -m pip install diffusers transformers accelerate safetensors flask pillow
echo
echo "Setup complete. The image service now starts automatically with ../start.sh"
echo "(The model itself downloads on first use, not here.)"
