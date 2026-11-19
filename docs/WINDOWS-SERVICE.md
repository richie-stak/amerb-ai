# Running AMERB AI as a service

Normally AMERB AI runs in a console window opened by `start.bat`, and it stops when that window is
closed or the computer restarts. A *service* starts it automatically at boot, keeps it running
after everyone logs out, and restarts it if it crashes.

- **Windows** — via [node-windows](https://github.com/coreybutler/node-windows) (a small service
  wrapper, installed as a dependency; nothing else to download).
- **Linux** — via systemd (unit file in `deploy/`).

The service runs the same launcher as `start.bat` (`scripts/launch.js --service`), so it still
starts Ollama, pulls a missing model and starts the image service. Service mode differs in four
ways: it never opens a browser or waits for a keypress, it copies everything it prints to
`logs/service.log`, it keeps retrying Ollama for ten minutes if Ollama starts slowly after boot, and
it exits non-zero when the server dies so the supervisor restarts it.

## Windows: install

1. Right-click **`install-service.bat`** → *Run as administrator* (or open an Administrator
   terminal in this folder and run `npm run service:install`).
2. It prints each step and finishes with the service state. Open <https://localhost:3000> to check.

Useful variants:

```bat
npm run service:install -- --dry-run          REM show exactly what would be installed (no admin needed)
npm run service:install -- --no-start         REM install but don't start it yet
npm run service:install -- --user ".\amerb" --password "..."   REM run as a specific Windows account
```

Check on it at any time, from any terminal:

```bat
npm run service:status        REM installed? running? start type?
sc.exe query amerbai.exe      REM same thing, the long way
```

If the installer ever stops part-way (the window closed, antivirus interfered) the service can be left
registered but **stopped, with the default start type and no crash-restart policy**. Finish it without
reinstalling:

```bat
repair-service.bat            REM self-elevates: fixes the settings, starts it, checks /health
npm run service:repair -- --no-start      REM only fix the settings
```

`repair-service.bat` also refuses to start the service while something else holds port 3000 (usually a
copy started by `start.bat`) and tells you which process to close — otherwise the service would fail
to bind and restart over and over, which looks like a broken install rather than a port conflict.

The service appears in **services.msc** as **AMERB AI**, set to *Automatic (Delayed Start)*, with
failure actions so Windows restarts it if the wrapper itself dies.

## Which account should it run as?

By default the service runs as **LocalSystem**. That is fine if Ollama is installed for all users,
but **most Ollama installs are per-user**: `ollama serve` lives in
`%LOCALAPPDATA%\Programs\Ollama`, which LocalSystem cannot see, so the launcher can't start Ollama
and the app comes up without a model.

Two good options:

- **Run the service as the account that installed Ollama** —
  `npm run service:install -- --user "DOMAIN\name" --password "..."`. The account needs "Log on as a
  service" rights (Windows grants this to the account used, via the installer).
- **Run Ollama as its own service** (recommended) — install Ollama for all users, then run
  `ollama serve` as a service too, so both start at boot independently. The AMERB AI service then
  stays on LocalSystem.

Whichever you choose, the launcher waits up to ten minutes for Ollama after boot and logs a clear
warning if it never appears.

## Logs

| What | Where |
| --- | --- |
| Launcher + server + image-service output | `logs\service.log` (rotates at 10 MB, keeps 5 files) |
| Structured server log (JSON, one line per event) | `logs\amerb-ai.log` (rotates at 10 MB, keeps 5 files; `LOG_DIR`/`LOG_LEVEL`/`LOG_MAX_MB`/`LOG_KEEP` in `.env`) |
| Service wrapper logs (winsw) | `daemon\*.out.log` / `daemon\*.err.log` / `daemon\*.wrapper.log` |
| In the admin portal | **Admin → Operations → Recent warnings and errors** |

The `logs\` and `daemon\` folders are created on first run and are git-ignored.

## Verify after a reboot

```powershell
npm run service:status
curl.exe -k https://localhost:3000/health            # {"status":"ok",...}
curl.exe -k "https://localhost:3000/health?deep=1"   # also checks Ollama
```

`/health` returns HTTP 200 when the app and database are fine, and 503 when the database or a
strict check fails. `?deep=1` adds Ollama; a missing Ollama reports `"degraded"` (still 200, because
restarting the app wouldn't help), and `?deep=1&strict=1` turns that into a 503 for monitors that
want to alert on it.

If other PCs can't connect, Windows Firewall is blocking TCP 3000 — allow Node.js when prompted, or
have IT open the port.

## Update, stop, remove

```bat
npm run service:status        REM is it running?
net stop "AMERB AI"           REM stop (admin terminal)
net start "AMERB AI"          REM start
uninstall-service.bat         REM remove it (admin; asks for confirmation)
```

To update the app: stop the service, replace the folder contents (`node_modules`, `certs` and
`data` can stay), then start it again. The launcher reinstalls dependencies if they were built for
another OS.

## Linux: systemd

```bash
sudo deploy/install-systemd.sh          # fills in the path/user, installs, enables and starts it
systemctl status amerb-ai
journalctl -u amerb-ai -f
```

The unit restarts on failure (`Restart=always`, `RestartSec=5`) and starts after
`network-online.target` and `ollama.service`. Logs still go to `logs/service.log` in the project
folder as well as the journal.

## Troubleshooting

- **"The service is installed but nothing happens / it never started."** Run `repair-service.bat`
  (elevated). An installer that lost node-windows' "installed" message leaves exactly that state:
  registered, stopped, with no boot start or crash recovery.
- **"The service is installed but the app isn't answering."** Check `logs\service.log` — the most
  common causes are a port already in use (another copy started by `start.bat`), Ollama not
  reachable from the service account (see above), or `node_modules` installed on another machine.
- **Service stops immediately after starting.** Run `node scripts\launch.js --service` in a normal
  terminal to see the same output without the wrapper.
- **Browser shows a certificate warning.** Expected — the app uses a self-signed certificate; see
  the README section *HTTPS and the security warning*.
- **The wrapper restarts it over and over.** Something makes the server exit at once (port in use is
  the usual culprit). The reason is in `logs\service.log` and `daemon\*.err.log`; `repair-service.bat`
  checks the port before starting and names the process holding it.
