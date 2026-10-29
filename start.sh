#!/usr/bin/env sh
# Starts AMERB AI on Linux/macOS. All the real work (installing dependencies for this machine,
# checking Ollama, starting the image service) is in scripts/launch.js, shared with start.bat.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install Node.js 22.5 or newer (https://nodejs.org, or your distro's"
  echo "NodeSource package) and run this again."
  exit 1
fi

exec node scripts/launch.js "$@"
