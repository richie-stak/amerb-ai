#!/usr/bin/env sh
# Starts only the image generation service (port 7861). Normally ../start.sh starts it for you.
cd "$(dirname "$0")" || exit 1
if [ ! -x venv/bin/python ]; then
  echo "Image generation isn't set up on this machine yet — run ./setup.sh first."
  exit 1
fi
echo "Starting AMERB AI image generation service..."
echo "First run downloads model weights (a few GB) - this can take a while."
exec venv/bin/python service.py
