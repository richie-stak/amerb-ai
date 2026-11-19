#!/usr/bin/env sh
# Installs AMERB AI as a systemd service (starts at boot, restarts on crash).
#
#   sudo sh deploy/install-systemd.sh [--user NAME] [--no-start]
#   sudo sh deploy/install-systemd.sh --uninstall
#
# --user NAME   Linux account to run the app as (default: the user who invoked sudo, never root unless
#               you say so). It needs write access to this folder (data/, certs/, logs/, node_modules/).
# --no-start    enable at boot but do not start it now.
# --uninstall   stop, disable and remove the unit.
# --no-firewall skip opening the port (by default ufw/firewalld is opened when one is active).
set -eu

UNIT_NAME=amerb-ai.service
UNIT_DEST="/etc/systemd/system/$UNIT_NAME"
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
APP_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
APP_USER=${SUDO_USER:-}
START=1
UNINSTALL=0
FIREWALL=1

while [ $# -gt 0 ]; do
  case "$1" in
    --user) APP_USER=${2:?--user needs a name}; shift 2 ;;
    --no-start) START=0; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --no-firewall) FIREWALL=0; shift ;;
    -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root:  sudo sh $0 $*" >&2
  exit 1
fi
if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemd (systemctl) was not found - this script is for systemd-based Linux." >&2
  exit 1
fi

if [ "$UNINSTALL" -eq 1 ]; then
  systemctl disable --now "$UNIT_NAME" 2>/dev/null || true
  rm -f "$UNIT_DEST"
  systemctl daemon-reload
  echo "Removed $UNIT_NAME (the app files, data/ and logs/ were not touched)."
  exit 0
fi

if [ -z "$APP_USER" ]; then
  echo "Could not tell which user to run as (not started through sudo). Pass one, e.g.:  sudo sh $0 --user amerb" >&2
  exit 1
fi
if [ "$APP_USER" = root ]; then
  echo "WARNING: running the service as root is not recommended; use --user <name> for a normal account." >&2
fi
if ! id "$APP_USER" >/dev/null 2>&1; then
  echo "User '$APP_USER' does not exist." >&2
  exit 1
fi

# systemd does not read your shell profile, so nvm-style installs are not on its PATH. /usr/bin/env node
# in the unit works for a system-wide Node (apt/NodeSource/dnf); warn if it will not.
if [ ! -x /usr/bin/node ] && [ ! -x /usr/local/bin/node ]; then
  echo "WARNING: node is not in /usr/bin or /usr/local/bin. systemd's default PATH will not find it (e.g. nvm installs)." >&2
  echo "         Install Node.js 22.5+ system-wide, or edit $UNIT_DEST and give ExecStart the full path to node." >&2
fi

if [ ! -f "$APP_DIR/scripts/launch.js" ]; then
  echo "Cannot find $APP_DIR/scripts/launch.js - run this from the AMERB AI folder." >&2
  exit 1
fi

# Escape characters that are special in a sed replacement.
esc() { printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'; }
sed -e "s|@APP_DIR@|$(esc "$APP_DIR")|g" -e "s|@APP_USER@|$(esc "$APP_USER")|g" \
  "$SCRIPT_DIR/amerb-ai.service" > "$UNIT_DEST"
chmod 644 "$UNIT_DEST"

# The service user must own the writable folders (first run creates node_modules, .env, data, certs, logs).
if [ "$(stat -c %U "$APP_DIR" 2>/dev/null || echo "$APP_USER")" != "$APP_USER" ]; then
  echo "NOTE: $APP_DIR is owned by '$(stat -c %U "$APP_DIR")', not '$APP_USER'. If the app can't write there, run:"
  echo "      sudo chown -R $APP_USER: '$APP_DIR'"
fi

systemctl daemon-reload
if [ "$START" -eq 1 ]; then
  systemctl enable --now "$UNIT_NAME"
else
  systemctl enable "$UNIT_NAME"
fi

PORT_NUMBER=$(sed -n "s/^PORT=\([0-9]\{1,5\}\).*/\1/p" "$APP_DIR/.env" 2>/dev/null | tail -1)
PORT_NUMBER=${PORT_NUMBER:-3000}

# Other computers need the port open. Opening it here means one command sets the app up end to
# end; --no-firewall is for when IT manages the firewall centrally.
if [ "$FIREWALL" -eq 1 ]; then
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    ufw allow "${PORT_NUMBER}/tcp" >/dev/null && echo "Firewall: opened TCP ${PORT_NUMBER} in ufw."
  elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
    firewall-cmd --permanent --add-port="${PORT_NUMBER}/tcp" >/dev/null && firewall-cmd --reload >/dev/null && echo "Firewall: opened TCP ${PORT_NUMBER} in firewalld."
  else
    echo "Firewall: no active ufw/firewalld - if other PCs cannot connect, open TCP ${PORT_NUMBER} yourself."
  fi
fi

echo
echo "Installed $UNIT_DEST (user: $APP_USER, folder: $APP_DIR)."
echo "  Status : systemctl status amerb-ai          Logs: journalctl -u amerb-ai -f   (and $APP_DIR/logs/service.log)"
echo "  Health : curl -k https://localhost:3000/health"
echo "  Stop   : sudo systemctl stop amerb-ai       Remove: sudo sh $0 --uninstall"
( cd "$APP_DIR" && node scripts/networking.js "$PORT_NUMBER" ) || echo "  (run: node scripts/networking.js to list the addresses staff can use)"
