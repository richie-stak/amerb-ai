# Running AMERB AI with Docker

`docker compose up -d` brings up the whole stack on any machine with Docker — no Node.js, Python or Ollama install needed on the host.

| Service | What it is | Starts |
|---|---|---|
| `ollama` | [Ollama](https://ollama.com) model server (volume `ollama-models`) | always |
| `ollama-pull` | one-shot job that downloads `DEFAULT_MODEL` and `EMBED_MODEL`, then exits | always |
| `app` | AMERB AI itself, HTTPS on port 3000 (volumes `amerb-data`, `amerb-certs`, `amerb-logs`, `amerb-models`) | always |
| `imagegen` | optional Stable Diffusion Turbo image service (volume `imagegen-models`) | only with `--profile imagegen` |

Only the `app` port is published on the host. Ollama and the image service have no authentication, so they are reachable only from inside the Compose network.

## Prerequisites

- Docker Engine 24+ with the **Compose v2 plugin** (`docker compose version`), or Docker Desktop on Windows/macOS.
- Internet access on the first build/run (base images, npm packages, models). Afterwards everything works offline.
- RAM: at least 8 GB for a small chat model on CPU (16 GB+ recommended); the image service needs another ~6–8 GB while generating.
- Disk: ~10 GB for the base stack and a small model; ~15 GB more with image generation.
- The port you choose (default **3000**) open in the host firewall if other PCs will connect (e.g. `sudo ufw allow 3000/tcp`).

## First run

```bash
cp .env.docker.example .env.docker
# edit .env.docker — at least set PUBLIC_HOSTNAMES to the IP / DNS name staff will use
docker compose --env-file .env.docker up -d
```

Then open **https://\<host\>:3000** (see [Trusting the certificate](#trusting-the-certificate)).

What happens, and roughly how long it takes on a typical connection (the first run is dominated by downloads):

1. **Build the `app` image** (~3–6 min): Node 22 + `npm ci`. Needs internet to fetch npm packages, the `xlsx` tarball from `cdn.sheetjs.com`, and the prebuilt `sharp` binary from GitHub.
2. **Pull `ollama/ollama`** (~1–3 GB).
3. **`ollama-pull`** downloads the chat model (`qwen3:4b-instruct` ≈ 2.5 GB by default) and the embedding model (`nomic-embed-text` ≈ 270 MB). This is the slow part — typically 5–30 min. Follow it with `docker compose logs -f ollama-pull`.
4. **`app` starts** as soon as Ollama is healthy (it does not wait for the downloads). Until the chat model has finished downloading, chat replies fail with a "model not found" style error; once `ollama-pull` exits it works. The app preloads the default model only at startup, so after the pull finishes run `docker compose restart app` once if you want it preloaded (optional — the first chat loads it anyway).
5. **Voice input**: the small Whisper model (~40 MB) is downloaded on first use of the microphone button and cached in the `amerb-models` volume. Image OCR needs no download (`eng.traineddata` is baked into the image).

Check status with `docker compose ps` — `app` and `ollama` should become `healthy`; `ollama-pull` shows `Exited (0)` when done.

To create the first admin account, sign up, then follow the "first account" note in the README (the database lives in the volume, see [Where data lives](#where-data-lives)):

```bash
docker compose exec app node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/app/data/amerb-ai.sqlite');console.log(d.prepare(\"UPDATE users SET role='admin' WHERE email=?\").run('you@amenfimanbank.com'))"
```

### Configuration

All settings live in `.env.docker` (documented line by line in [`.env.docker.example`](../.env.docker.example)). Compose passes them to the containers through `environment:` substitutions only — it deliberately does **not** use `env_file:`. This matters if you also run AMERB AI the non-Docker way: that project `.env` contains `OLLAMA_URL=http://127.0.0.1:11434`, which inside a container points at the container itself. `OLLAMA_URL`, `IMAGEGEN_URL`, `HOST` and the container-side port are therefore fixed in `docker-compose.yml`. (Compose also reads a plain `.env` automatically for `${...}` substitution if you do not pass `--env-file`; only the variables listed in `.env.docker.example` are used from it.)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Host port staff open |
| `BIND_ADDRESS` | `0.0.0.0` | Host interface to bind (`127.0.0.1` = this machine only) |
| `PUBLIC_HOSTNAMES` | *(empty)* | Extra IPs/DNS names added to the HTTPS certificate |
| `SESSION_SECRET` | *(empty → generated once, stored in `amerb-data`)* | Signs login cookies |
| `DEFAULT_MODEL`, `EMBED_MODEL` | `qwen3:4b-instruct`, `nomic-embed-text` | Models pulled and used |
| `OLLAMA_KEEP_ALIVE` | `30m` | How long models stay in memory |
| `OLLAMA_NUM_PARALLEL` | `1` | Parallel requests per model |
| `OLLAMA_MAX_LOADED_MODELS` | `2` | Models in memory at once |
| `OLLAMA_NUM_CTX` | `8192` | Context window requested by the app |
| `OLLAMA_IMAGE` | `ollama/ollama:latest` | Pin a version for repeatable installs |
| `IMAGEGEN_MODEL` | `stabilityai/sd-turbo` | Image model (Hugging Face id) |
| `LOG_LEVEL`, `LOG_MAX_MB`, `LOG_KEEP` | `info`, `10`, `5` | Structured app log |
| `DOCKER_LOG_MAX_SIZE`, `DOCKER_LOG_MAX_FILE` | `10m`, `3` | `docker compose logs` rotation |

After editing `.env.docker`, apply with `docker compose --env-file .env.docker up -d` (only affected containers are re-created; data is kept).

**Hostname and certificate.** The `app` container has the fixed hostname `amerb-ai`. The self-signed certificate is regenerated whenever the machine name or `PUBLIC_HOSTNAMES` is not in it, so a stable hostname keeps one certificate across re-creates and upgrades. You may see a log note that the certificate "doesn't cover this machine's current IP" after a re-create: that is the container's internal Docker IP changing and is harmless — open the app by a name/IP listed in `PUBLIC_HOSTNAMES`.

## Enabling image generation

```bash
docker compose --env-file .env.docker --profile imagegen up -d --build
```

The first build downloads PyTorch (CPU build), diffusers and transformers (~3 GB, 10–20 min). The first start then downloads the `sd-turbo` model (~5 GB) into the `imagegen-models` volume; until it is loaded, requests report that the model is still loading. On CPU an image takes roughly 30–40 s. Use `--profile imagegen` on every later `docker compose` command that should include it (or set `COMPOSE_PROFILES=imagegen` in your shell). Without the profile, image generation simply reports that the service is unreachable; everything else works.

`imagegen/service.py` listens on `127.0.0.1` only, so the container runs it through the small wrapper `docker/imagegen_entry.py`, which serves the same Flask app on `0.0.0.0` inside the container.

## GPU for Ollama (NVIDIA)

Install the NVIDIA driver and the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html) on the host, then add the override file to every command:

```bash
docker compose -f docker-compose.yml -f docker-compose.gpu.yml --env-file .env.docker up -d
```

Only Ollama uses the GPU (the image service is a CPU-only PyTorch build). With a GPU you can raise `OLLAMA_NUM_PARALLEL` and pull larger models.

## Trusting the certificate

The app uses a self-signed certificate, so browsers warn on first visit (expected; click through, or trust it once per PC as below). Export it:

```bash
docker compose cp app:/app/certs/server.cert ./amerb-server.cert
```

Import it on each staff PC — Windows: double-click → *Install Certificate* → *Local Machine* → *Trusted Root Certification Authorities*. It only matches the names/IPs it was issued for, so staff must open the app using one of them (`PUBLIC_HOSTNAMES`, `localhost`, or `amerb-ai`).

To issue a fresh certificate (e.g. after changing hostnames — this also happens automatically when `PUBLIC_HOSTNAMES` changes): `docker compose stop app`, `docker run --rm -v amerb-certs:/c alpine sh -c "rm -f /c/*"`, `docker compose up -d`. Everyone must trust the new file.

## Where data lives

| Volume | Mounted at | Contents |
|---|---|---|
| `amerb-data` | `/app/data` | `amerb-ai.sqlite` (users, chats, documents), **`secret.key`**, `session-secret` |
| `amerb-certs` | `/app/certs` | `server.cert`, `server.key` |
| `amerb-logs` | `/app/logs` | `amerb-ai.log` (+ rotated `.1`…) |
| `amerb-models` | `/app/node_modules/@xenova/transformers/.cache` | voice-input model cache |
| `ollama-models` | `/root/.ollama` (ollama) | downloaded LLMs |
| `imagegen-models` | `/models` (imagegen) | Hugging Face cache (image model) |

Volume names are fixed (not prefixed with the project name), so one AMERB AI stack per Docker host. `docker compose down` keeps volumes; `docker compose down -v` **deletes them all, including the database**.

## Backup and restore

`secret.key` encrypts the external-provider API keys stored in the database — **always back up and restore it together with the database.** The commands below use `tar` so both travel together. Stop the app first so the SQLite files are consistent. (The Admin portal → System backup is also fine while running, but it contains only the database, not `secret.key`.)

Backup (Linux/macOS shell; on Windows PowerShell replace `"$PWD/backups"` with `"${PWD}\backups"`):

```bash
mkdir -p backups
docker compose stop app
docker run --rm -v amerb-data:/data:ro -v "$PWD/backups":/backup alpine \
  tar czf /backup/amerb-data-$(date +%F).tar.gz -C /data .
docker compose start app
```

Restore:

```bash
docker compose stop app
docker run --rm -v amerb-data:/data -v "$PWD/backups":/backup alpine sh -c \
  "rm -rf /data/* /data/.[!.]* ; tar xzf /backup/amerb-data-YYYY-MM-DD.tar.gz -C /data && chown -R 1000:1000 /data"
docker compose start app
```

(The app runs as user `node`, uid 1000 — hence the `chown`.) Ollama models and the image model can simply be re-downloaded; to back them up anyway, tar `ollama-models` / `imagegen-models` the same way.

### Moving an existing (non-Docker) install into Docker

1. Stop the old app cleanly (Ctrl+C in its window / stop the service) so SQLite writes everything out.
2. Create the volume and containers without starting them: `docker compose --env-file .env.docker create app`
3. Copy **the database and `secret.key` together** from the old project folder's `data/`:

   ```bash
   docker run --rm -v amerb-data:/data -v "/path/to/old/Amerb AI/data":/old:ro alpine sh -c \
     "cp /old/amerb-ai.sqlite* /old/secret.key /data/ && chmod 600 /data/secret.key && chown 1000:1000 /data/*"
   ```

   (`amerb-ai.sqlite*` also picks up `-wal`/`-shm` files if present. On Windows use e.g. `-v "C:\path\to\Amerb AI\data:/old:ro"`.)
4. `docker compose --env-file .env.docker up -d`. Users stay signed in only if you also set the same `SESSION_SECRET`; otherwise they simply sign in again. The old `certs/` are not needed — staff trust the new certificate once (see above).

## Upgrading

```bash
git pull
docker compose --env-file .env.docker build --pull    # add --profile imagegen if you use it
docker compose --env-file .env.docker up -d           # re-creates changed containers; volumes are kept
docker image prune -f                                 # optional: remove old image layers
```

Database changes are migrated automatically when the new version starts. Take a [backup](#backup-and-restore) first. To also update Ollama itself: `docker compose pull ollama` (or change the pinned `OLLAMA_IMAGE`) and `up -d`.

## Logs and health

```bash
docker compose logs -f app                 # what the server prints (rotated by Docker, see DOCKER_LOG_*)
docker compose logs -f ollama ollama-pull imagegen
docker compose exec app tail -n 100 /app/logs/amerb-ai.log   # structured JSON log (rotated by the app)
docker compose cp app:/app/logs ./amerb-logs-copy            # copy it out for analysis
```

Health: `docker compose ps` shows `healthy`/`unhealthy`. The app container is probed every 30 s on `GET /health` (200 `{"status":"ok"}` = process and database fine, 503 otherwise); you can check it yourself with `curl -k https://localhost:3000/health`. `docker inspect --format '{{json .State.Health}}' amerb-app` shows the last probe results. The container restarts automatically (`restart: unless-stopped`) when the process exits, and after a reboot of the host.

## Troubleshooting

- **App starts but chat says it can't reach Ollama / model not found.** `docker compose ps` — is `ollama` healthy? `docker compose logs ollama-pull` — did the model download finish (or fail)? Re-run it with `docker compose run --rm ollama-pull`. List what's installed: `docker compose exec ollama ollama list`. If the app logs warn that `OLLAMA_URL` points at 127.0.0.1, a wrong value was injected somewhere — it must be `http://ollama:11434` (set in `docker-compose.yml`).
- **`ollama` never becomes healthy.** Check `docker compose logs ollama` (out of memory/disk, or a GPU error — remove `docker-compose.gpu.yml` from the command to test without the GPU).
- **"port is already allocated" / "address already in use".** Another program (maybe a non-Docker AMERB AI) uses port 3000. Stop it, or set `PORT=8443` in `.env.docker`.
- **Browser certificate warning.** Expected with a self-signed certificate — see [Trusting the certificate](#trusting-the-certificate). If it still warns after trusting, you are opening the app by a name/IP that is not in the certificate: add it to `PUBLIC_HOSTNAMES` and re-run `up -d` (new certificate, trust it again).
- **Other PCs can't connect.** Host firewall (open the port), `BIND_ADDRESS` set to `127.0.0.1`, or the wrong IP/name used.
- **`app` is `unhealthy` / restarting.** `docker compose logs --tail 100 app`. A message about `/app/data is not writable` means restored or bind-mounted data has the wrong owner: `docker run --rm -u 0 -v amerb-data:/t alpine chown -R 1000:1000 /t`.
- **Image generation says the service is unreachable or still loading.** Was it started with `--profile imagegen`? `docker compose --profile imagegen logs -f imagegen` — the first start downloads ~5 GB. Out-of-memory kills (`docker inspect amerb-imagegen --format '{{.State.OOMKilled}}'`) mean the machine needs more RAM.
- **Build fails downloading packages.** Needs internet (npm registry, `cdn.sheetjs.com`, GitHub for `sharp`, PyTorch's download server). Behind a proxy, configure Docker's proxy settings. If `npm ci` fails with a *lockfile out of sync* error, run `npm install` on a development machine and commit the updated `package-lock.json`.
- **Start over completely** (deletes the database, models and certificates!): `docker compose --profile imagegen down -v`.
