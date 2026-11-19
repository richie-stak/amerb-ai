# AMERB AI — local image generation service (Stable Diffusion Turbo on CPU).
# Build context is the PROJECT ROOT (see docker-compose.yml); the root .dockerignore allow-list
# keeps imagegen/venv and everything else out.
#
#   docker build -f docker/imagegen.Dockerfile -t amerb-imagegen .
#
# Heavy: PyTorch + diffusers + transformers, roughly 2-3 GB of wheels. Only built when the compose
# profile "imagegen" is enabled. The model itself (stabilityai/sd-turbo, ~5 GB) is downloaded from
# Hugging Face on first start into the /models volume — not into the image.
ARG PYTHON_VERSION=3.12
FROM python:${PYTHON_VERSION}-slim-bookworm

# libgomp1: OpenMP runtime used by PyTorch's CPU kernels (normally bundled in the wheel, installed
# anyway as cheap insurance). ca-certificates: HTTPS downloads from Hugging Face.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgomp1 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HOME=/models/huggingface \
    AMERB_IMAGEGEN_HOST=0.0.0.0 \
    AMERB_IMAGEGEN_PORT=7861

WORKDIR /app

# Python dependencies, using the same pinned versions as the native setup (imagegen/requirements.txt).
#  - torch must come from PyTorch's CPU-only index (the default PyPI Linux wheel is the multi-GB CUDA
#    build). requirements.txt pins "torch==X+cpu" (Windows wheel naming); on Linux x86_64 the CPU index
#    serves "X+cpu" and on arm64 plain "X", so the "+cpu" suffix is stripped and pip picks whichever exists.
#  - everything else comes from PyPI at the pinned versions.
#  - if a pinned version cannot be installed on this platform, fall back to unpinned latest versions
#    (what imagegen/setup.sh does) instead of failing the build. The build log says when this happens.
COPY imagegen/requirements.txt /tmp/requirements.txt
RUN set -eux; \
    TORCH_SPEC="$(grep -E '^torch==' /tmp/requirements.txt | head -n 1 | sed 's/+.*$//')"; \
    grep -v -E '^torch==' /tmp/requirements.txt > /tmp/requirements-no-torch.txt; \
    pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu "${TORCH_SPEC:-torch}"; \
    if ! pip install --no-cache-dir -r /tmp/requirements-no-torch.txt; then \
      echo "WARNING: pinned requirements failed to install - falling back to unpinned versions"; \
      pip install --no-cache-dir diffusers transformers accelerate safetensors flask pillow; \
    fi; \
    rm -f /tmp/requirements.txt /tmp/requirements-no-torch.txt

# Unprivileged user. /models is the Hugging Face cache (named volume "imagegen-models"); it is
# created and owned here so Docker hands the volume the same ownership on first use.
RUN useradd --system --uid 10001 --create-home --shell /usr/sbin/nologin amerb \
 && mkdir -p /models/huggingface \
 && chown -R amerb:amerb /models /app

COPY --chown=amerb:amerb imagegen/service.py /app/service.py
# service.py binds 127.0.0.1 only; this wrapper serves the same app on 0.0.0.0 (see its docstring).
COPY --chown=amerb:amerb docker/imagegen_entry.py /app/imagegen_entry.py

USER amerb
EXPOSE 7861

# /health answers 200 as soon as Flask is up (JSON says whether the model is loaded yet), so
# "healthy" means the service is reachable, not that the model has finished downloading.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:7861/health', timeout=4)"]

CMD ["python", "/app/imagegen_entry.py"]
