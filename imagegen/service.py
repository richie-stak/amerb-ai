"""
AMERB AI local image generation service.

A small, standalone Flask API around a Stable Diffusion Turbo pipeline (diffusers).
Runs entirely on-device (CPU by default) — no data or prompts leave this machine.

Run:
    venv\\Scripts\\python.exe service.py

The first request after startup downloads the model weights from Hugging Face
(a few GB, one-time) and can take several minutes; after that, weights are cached
locally under the venv's huggingface cache and startup is fast.
"""

import base64
import io
import os
import threading
import time

from flask import Flask, jsonify, request

app = Flask(__name__)

MODEL_ID = os.environ.get("AMERB_IMAGEGEN_MODEL", "stabilityai/sd-turbo")
PORT = int(os.environ.get("AMERB_IMAGEGEN_PORT", "7861"))
MAX_PROMPT_LEN = 800

_pipe = None
_pipe_lock = threading.Lock()
_load_error = None


def get_pipeline():
    """Lazily loads the diffusion pipeline on first use (heavy import + weight download)."""
    global _pipe, _load_error
    with _pipe_lock:
        if _pipe is not None or _load_error is not None:
            return _pipe
        try:
            import torch
            from diffusers import AutoPipelineForText2Image

            print(f"Loading model '{MODEL_ID}' (first run downloads weights, please wait)...")
            pipe = AutoPipelineForText2Image.from_pretrained(
                MODEL_ID, torch_dtype=torch.float32
            )
            pipe.to("cpu")
            _pipe = pipe
            print("Model loaded. Ready to generate images.")
        except Exception as exc:  # noqa: BLE001 - surface any load failure to callers
            _load_error = str(exc)
            print(f"Failed to load model: {exc}")
    return _pipe


@app.get("/health")
def health():
    return jsonify(
        {
            "ready": _pipe is not None,
            "loading": _pipe is None and _load_error is None,
            "error": _load_error,
            "model": MODEL_ID,
        }
    )


@app.post("/generate")
def generate():
    data = request.get_json(force=True, silent=True) or {}
    prompt = str(data.get("prompt", "")).strip()
    if not prompt:
        return jsonify({"error": "prompt is required"}), 400
    if len(prompt) > MAX_PROMPT_LEN:
        prompt = prompt[:MAX_PROMPT_LEN]

    steps = int(data.get("steps", 2))
    steps = max(1, min(steps, 4))  # sd-turbo is designed for 1-4 steps
    size = int(data.get("size", 512))
    size = max(256, min(size, 768))
    size = (size // 8) * 8  # must be a multiple of 8

    pipe = get_pipeline()
    if pipe is None:
        if _load_error:
            return jsonify({"error": f"Model failed to load: {_load_error}"}), 500
        return jsonify({"error": "Model is still loading, try again shortly"}), 503

    start = time.time()
    try:
        image = pipe(
            prompt=prompt,
            num_inference_steps=steps,
            guidance_scale=0.0,  # sd-turbo does not use classifier-free guidance
            height=size,
            width=size,
        ).images[0]
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": f"Generation failed: {exc}"}), 500
    elapsed = time.time() - start

    buf = io.BytesIO()
    image.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")

    return jsonify({"image_base64": b64, "seconds": round(elapsed, 1)})


if __name__ == "__main__":
    print(f"AMERB AI image generation service starting on port {PORT}...")
    print("Loading model in the background so the first real request doesn't time out the caller.")
    threading.Thread(target=get_pipeline, daemon=True).start()
    app.run(host="127.0.0.1", port=PORT)
