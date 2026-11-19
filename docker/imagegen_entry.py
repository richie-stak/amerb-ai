"""
Container entry point for the AMERB AI image generation service.

imagegen/service.py hardcodes `app.run(host="127.0.0.1", ...)` in its __main__ block, which would
make it unreachable from the other containers. Importing the module does NOT run that block, so
this wrapper imports it, starts the same background model load that __main__ would, and serves the
very same Flask app on all interfaces instead. service.py itself is not modified.

Environment:
  AMERB_IMAGEGEN_HOST   bind address (default 0.0.0.0)
  AMERB_IMAGEGEN_PORT   port (read by service.py, default 7861)
  AMERB_IMAGEGEN_MODEL  Hugging Face model id (read by service.py, default stabilityai/sd-turbo)
"""

import os
import sys
import threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import service  # noqa: E402  (must come after the sys.path tweak)

HOST = os.environ.get("AMERB_IMAGEGEN_HOST", "0.0.0.0")

if __name__ == "__main__":
    print(f"AMERB AI image generation service starting on {HOST}:{service.PORT} (container)...", flush=True)
    print("Loading model in the background so the first real request doesn't time out the caller.", flush=True)
    threading.Thread(target=service.get_pipeline, daemon=True).start()
    # threaded: /health must keep answering while a (slow, CPU-bound) generation is running.
    service.app.run(host=HOST, port=service.PORT, threaded=True)
