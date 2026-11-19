#!/bin/sh
# One-shot job run by the "ollama-pull" compose service: downloads the chat model and the
# embedding model into the Ollama server's volume, then exits. Models that are already present
# are a quick no-op, so it is safe to run on every `docker compose up`.
#
# Needs OLLAMA_HOST (set by compose to http://ollama:11434) so the CLI talks to the ollama service.
# Model names come from DEFAULT_MODEL / EMBED_MODEL.
set -u

failed=0
for model in "${DEFAULT_MODEL:-}" "${EMBED_MODEL:-}"; do
  [ -n "$model" ] || continue
  attempt=1
  while : ; do
    echo "[ollama-pull] pulling '$model' (attempt $attempt)..."
    if ollama pull "$model"; then
      echo "[ollama-pull] '$model' is ready."
      break
    fi
    if [ "$attempt" -ge 5 ]; then
      echo "[ollama-pull] ERROR: giving up on '$model' after $attempt attempts." >&2
      echo "              Check the internet connection and the model name, then run:" >&2
      echo "              docker compose run --rm ollama-pull" >&2
      failed=1
      break
    fi
    attempt=$((attempt + 1))
    sleep 10
  done
done

exit "$failed"
