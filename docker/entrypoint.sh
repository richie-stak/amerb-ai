#!/bin/sh
# AMERB AI container entrypoint (runs as the unprivileged "node" user, under tini).
#
#   1. checks that the volumes are writable
#   2. makes sure there is a SESSION_SECRET (generated once and kept in the data volume)
#   3. warns about obviously wrong settings
#   4. exec's the server (default CMD: node server/index.js)
set -eu

# --- 1. volumes -----------------------------------------------------------------------------
for dir in /app/data /app/certs /app/logs; do
  if [ ! -w "$dir" ]; then
    echo "ERROR: $dir is not writable by uid $(id -u) (the 'node' user)." >&2
    echo "       If you restored or bind-mounted data here, fix its ownership with:" >&2
    echo "         docker run --rm -u 0 -v <volume-or-path>:/target alpine chown -R $(id -u):$(id -g) /target" >&2
    exit 1
  fi
done

# --- 2. session secret ----------------------------------------------------------------------
# SESSION_SECRET signs the login cookies. Use the value from the environment when the operator
# set a real one; otherwise generate a random one ONCE and keep it in the data volume, so logins
# survive container re-creation. The .env.example placeholders are treated as "not set".
SECRET_FILE=/app/data/session-secret
case "${SESSION_SECRET:-}" in
  "" | "change-this-to-a-random-string" | "dev-only-secret-change-me")
    if [ ! -s "$SECRET_FILE" ]; then
      (umask 077 && node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))" > "$SECRET_FILE")
      echo "[entrypoint] Generated a new random SESSION_SECRET and saved it to $SECRET_FILE (data volume)."
    else
      echo "[entrypoint] SESSION_SECRET not provided - using the one stored in $SECRET_FILE."
    fi
    SESSION_SECRET="$(cat "$SECRET_FILE")"
    export SESSION_SECRET
    ;;
  *)
    echo "[entrypoint] Using SESSION_SECRET from the environment."
    ;;
esac

# --- 3. sanity warnings ---------------------------------------------------------------------
case "${OLLAMA_URL:-}" in
  *127.0.0.1* | *localhost* | *"[::1]"*)
    echo "[entrypoint] WARNING: OLLAMA_URL=$OLLAMA_URL points at this container itself, where no Ollama runs." >&2
    echo "             In docker-compose it should be http://ollama:11434 (a copy of the non-Docker .env leaked in?)." >&2
    ;;
esac

echo "[entrypoint] Starting AMERB AI as $(id -un) on hostname '${HOSTNAME:-unknown}' (HTTPS port ${PORT:-3000}, Ollama at ${OLLAMA_URL:-unset})."
exec "$@"
