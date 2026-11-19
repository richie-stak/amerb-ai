# AMERB AI — application image (Node.js app only; Ollama and the image service are separate
# containers, see docker-compose.yml).
#
#   docker build -t amerb-ai .
#
# Base: Debian 12 "bookworm" slim (glibc). Alpine/musl is deliberately NOT used: sharp and
# onnxruntime-node (pulled in by @xenova/transformers for voice input) ship glibc binaries.
ARG NODE_VERSION=22

# ---------------------------------------------------------------------------------------------
# Stage 1 — install production dependencies.
# Build tools are only a fallback: sharp normally downloads a prebuilt binary during `npm ci`
# (needs internet at build time), but if that fails it compiles with node-gyp, which needs these.
# None of this ends up in the final image.
# ---------------------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
# --omit=dev: no dev dependencies. xlsx is fetched from cdn.sheetjs.com (see package.json).
RUN npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force

# ---------------------------------------------------------------------------------------------
# Stage 2 — runtime image.
# ---------------------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim

# tini: a proper PID 1, so `docker stop` (SIGTERM) actually stops node and zombies are reaped.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    LOG_DIR=/app/logs \
    AMERB_DB_PATH=/app/data/amerb-ai.sqlite

WORKDIR /app

# Dependencies first (best layer caching), owned by the unprivileged "node" user (uid/gid 1000).
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node server ./server
COPY --chown=node:node public ./public
COPY --chown=node:node docker/entrypoint.sh docker/healthcheck.js ./docker/

# tesseract.js (image OCR, server/documentExtract.js) looks for ./eng.traineddata in the working
# directory (/app) before trying to download English data from a CDN — copying it makes OCR work
# offline and means nothing has to write to /app at runtime.
COPY --chown=node:node eng.traineddata ./eng.traineddata

# Writable locations — each is a named volume in docker-compose.yml. They are created and owned
# by "node" here because Docker copies that ownership into a new, empty named volume.
#   data/   SQLite database, secret.key (encrypts provider API keys), generated session secret
#   certs/  self-signed HTTPS certificate
#   logs/   rotating structured log (LOG_DIR)
#   .cache  Whisper (voice input) model, downloaded once from Hugging Face on first use
RUN mkdir -p /app/data /app/certs /app/logs /app/node_modules/@xenova/transformers/.cache \
 && chown node:node /app/data /app/certs /app/logs /app/node_modules/@xenova/transformers/.cache

USER node
EXPOSE 3000

# /health is public and answers 200 {"status":"ok"} when the process and database are fine, 503
# otherwise. The certificate is self-signed, so the probe skips verification (loopback only).
# start-period is generous: first boot creates the database and the HTTPS certificate.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD ["node", "/app/docker/healthcheck.js"]

# Run through `sh` so the entrypoint works even if the executable bit was lost (e.g. checkout on Windows).
ENTRYPOINT ["tini", "--", "sh", "/app/docker/entrypoint.sh"]
# Starts server/index.js directly — NOT scripts/launch.js, which tries to start ollama/python itself.
CMD ["node", "server/index.js"]
