#!/usr/bin/env bash
# One-command installer for a Linux VPS (Debian/Ubuntu best supported).
#
#   ssh -t user@server 'bash -c "$(curl -fsSL https://raw.githubusercontent.com/akinmirik/test/claude/keen-wright-ihifhp/lethal-quota/deploy/install.sh)"'
#
# What it does:
#   1. Installs Node.js 22 (system-wide with sudo, otherwise into ~/.local/node)
#   2. Clones/updates the game into ~/lethal-quota-app and installs dependencies
#   3. Runs it as a service on 127.0.0.1:$PORT (systemd with sudo, otherwise nohup + @reboot cron)
#   4. With sudo: installs Caddy as an HTTPS reverse proxy on https://<ip-with-dashes>.sslip.io
#      (browsers only allow microphones on HTTPS, so voice chat needs this)
#
# Re-run it any time to update to the latest commit.
set -euo pipefail

REPO="${REPO:-https://github.com/akinmirik/test.git}"
BRANCH="${BRANCH:-claude/keen-wright-ihifhp}"
APP_DIR="${APP_DIR:-$HOME/lethal-quota-app}"
PORT="${PORT:-3000}"

log() { printf '\n\033[1;33m==> %s\033[0m\n' "$*"; }

PUBLIC_IP="${PUBLIC_IP:-$(curl -fsS --max-time 5 https://api.ipify.org || hostname -I | awk '{print $1}')}"
DOMAIN="${DOMAIN:-$(echo "$PUBLIC_IP" | tr . -).sslip.io}"

SUDO=""
if [ "$(id -u)" -eq 0 ]; then
  SUDO=" "
elif command -v sudo >/dev/null && sudo -v 2>/dev/null; then
  SUDO="sudo"
else
  log "No sudo access: installing for this user only (no HTTPS proxy, no firewall changes)."
fi
run_root() { if [ "$SUDO" = " " ]; then "$@"; else sudo "$@"; fi; }
HAS_APT=0; command -v apt-get >/dev/null && HAS_APT=1

# ------------------------------------------------------------------ Node.js
node_major() { node -v 2>/dev/null | sed 's/v\([0-9]*\).*/\1/' || echo 0; }
export PATH="$HOME/.local/node/bin:$PATH"
if [ "$(node_major)" -lt 18 ] 2>/dev/null || ! command -v node >/dev/null; then
  if [ -n "$SUDO" ] && [ "$HAS_APT" = 1 ]; then
    log "Installing Node.js 22 (NodeSource)"
    run_root apt-get update -y
    run_root apt-get install -y ca-certificates curl gnupg git
    curl -fsSL https://deb.nodesource.com/setup_22.x | run_root bash -
    run_root apt-get install -y nodejs
  else
    log "Installing Node.js 22 into ~/.local/node"
    ARCH=$(uname -m); case "$ARCH" in x86_64) ARCH=x64;; aarch64|arm64) ARCH=arm64;; esac
    VER=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/ | grep -o "node-v22[0-9.]*-linux-$ARCH.tar.xz" | head -1)
    mkdir -p "$HOME/.local/node"
    curl -fsSL "https://nodejs.org/dist/latest-v22.x/$VER" | tar -xJ --strip-components=1 -C "$HOME/.local/node"
  fi
fi
command -v git >/dev/null || { [ -n "$SUDO" ] && [ "$HAS_APT" = 1 ] && run_root apt-get install -y git; }
command -v git >/dev/null || { echo "git is required. Please install it and re-run."; exit 1; }
NODE_BIN="$(command -v node)"
log "Using node $(node -v) at $NODE_BIN"

# ------------------------------------------------------------------ code
if [ -d "$APP_DIR/.git" ]; then
  log "Updating $APP_DIR"
  git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$APP_DIR" reset --hard FETCH_HEAD
else
  log "Cloning into $APP_DIR"
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$APP_DIR"
fi
cd "$APP_DIR/lethal-quota"
npm ci --omit=dev --no-audit --no-fund

# ------------------------------------------------------------------ service
if [ -n "$SUDO" ] && command -v systemctl >/dev/null; then
  log "Installing systemd service lethal-quota"
  run_root tee /etc/systemd/system/lethal-quota.service >/dev/null <<EOF
[Unit]
Description=Lethal Quota game server
After=network.target

[Service]
User=$(id -un)
WorkingDirectory=$APP_DIR/lethal-quota
Environment=PORT=$PORT
Environment=HOST=$([ "$HAS_APT" = 1 ] && echo 127.0.0.1 || echo 0.0.0.0)
Environment=NODE_ENV=production
ExecStart=$NODE_BIN server/index.js
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
  run_root systemctl daemon-reload
  run_root systemctl enable lethal-quota >/dev/null 2>&1
  run_root systemctl restart lethal-quota
else
  log "Starting with nohup (and an @reboot cron entry)"
  [ -f "$APP_DIR/server.pid" ] && kill "$(cat "$APP_DIR/server.pid")" 2>/dev/null || true
  START="cd $APP_DIR/lethal-quota && PORT=$PORT nohup $NODE_BIN server/index.js >> $APP_DIR/server.log 2>&1 & echo \$! > $APP_DIR/server.pid"
  bash -c "$START"
  ( crontab -l 2>/dev/null | grep -v lethal-quota; echo "@reboot $START" ) | crontab - 2>/dev/null || true
fi

sleep 2
curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null && log "Game server is up on port $PORT" || { echo "Server failed to start"; exit 1; }

# ------------------------------------------------------------------ HTTPS via Caddy
if [ -n "$SUDO" ] && [ "$HAS_APT" = 1 ]; then
  if ! command -v caddy >/dev/null; then
    log "Installing Caddy (automatic HTTPS)"
    run_root apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | run_root gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | run_root tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
    run_root apt-get update -y
    run_root apt-get install -y caddy
  fi
  log "Configuring Caddy for https://$DOMAIN"
  run_root tee /etc/caddy/Caddyfile >/dev/null <<EOF
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:$PORT
}
EOF
  if command -v ufw >/dev/null && run_root ufw status | grep -q "Status: active"; then
    run_root ufw allow 80/tcp >/dev/null; run_root ufw allow 443/tcp >/dev/null
  fi
  run_root systemctl enable caddy >/dev/null 2>&1
  run_root systemctl restart caddy
  log "Waiting for the HTTPS certificate..."
  for i in $(seq 1 30); do
    if curl -fsS --max-time 5 "https://$DOMAIN/health" >/dev/null 2>&1; then break; fi
    sleep 2
  done
  if curl -fsS --max-time 5 "https://$DOMAIN/health" >/dev/null 2>&1; then
    log "DONE! Play at:  https://$DOMAIN"
  else
    log "Caddy is running but HTTPS isn't answering yet. Make sure ports 80 and 443 are open in your provider's firewall, then check: sudo journalctl -u caddy -n 50"
    echo "Target URL: https://$DOMAIN"
  fi
else
  log "DONE (HTTP only). Play at:  http://$PUBLIC_IP:$PORT"
  echo "Note: without HTTPS, browsers block the microphone for everyone except localhost."
  echo "Re-run this script as a user with sudo to get automatic HTTPS."
fi
