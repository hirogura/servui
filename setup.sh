#!/bin/bash
# ============================================================
# serv-UI Setup Script for Ubuntu Server
# ============================================================
# Usage: sudo bash setup.sh [--branch <name>] [--no-restart]
#
# Options:
#   --branch <name>   Install from the given branch (default: main)
#   --no-restart      Deploy files only; restart serv-UI manually
#
# This script:
# 1. Installs system dependencies
# 2. Creates a dedicated user for serv-UI
# 3. Sets up sudoers for systemctl commands
# 4. Clones from GitHub and deploys serv-UI
# 5. Creates systemd service
# 6. Configures Tailscale serve (HTTPS)
# ============================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

APP_NAME="serv-ui"
APP_DIR="/opt/servui"
APP_USER="servui"
APP_PORT=3355
REPO_URL="https://github.com/hirogura/servui.git"
BRANCH="main"
NO_RESTART=0

log() { echo -e "${GREEN}[✔]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err() { echo -e "${RED}[✘]${NC} $1"; exit 1; }
info() { echo -e "${CYAN}[i]${NC} $1"; }

# --- Parse arguments ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch)
      [[ $# -ge 2 ]] || err "--branch requires a value"
      BRANCH="$2"
      shift 2
      ;;
    --no-restart)
      NO_RESTART=1
      shift
      ;;
    *)
      err "Unknown option: $1"
      ;;
  esac
done

# --- Root check ---
if [[ $EUID -ne 0 ]]; then
  err "This script must be run as root (sudo bash setup.sh)"
fi

info "Installing serv-UI from branch: ${BRANCH}"

# --- Check Tailscale is installed ---
if ! command -v tailscale &>/dev/null; then
  warn "Tailscale is not installed. Installing now..."
  curl -fsSL https://tailscale.com/install.sh | sh
fi

# --- Check Tailscale is connected ---
if ! tailscale status &>/dev/null; then
  warn "Tailscale is not connected. Please run 'tailscale up' first."
  warn "After connecting, re-run this script."
  exit 1
fi

# --- System updates ---
log "Updating package lists..."
apt update -qq

# --- Install dependencies ---
log "Installing system dependencies..."
DEBIAN_FRONTEND=noninteractive apt install -y -qq python3 python3-pip python3-venv git network-manager iw wpasupplicant

# --- Create app user ---
if ! id "$APP_USER" &>/dev/null; then
  log "Creating user: $APP_USER"
  useradd -r -m -s /bin/bash "$APP_USER"
else
  info "User $APP_USER already exists"
fi

# --- Sudoers: allow management commands for servui user ---
SUDOERS_FILE="/etc/sudoers.d/servui-systemctl"
log "Configuring sudoers for $APP_USER..."
cat > "$SUDOERS_FILE" << 'EOF'
# serv-UI: allow management and maintenance commands without password
Defaults:servui env_keep += "DEBIAN_FRONTEND"
servui ALL=(ALL) NOPASSWD: /usr/bin/systemctl, \
    /usr/bin/apt, \
    /usr/bin/apt-get, \
    /usr/bin/dpkg, \
    /usr/sbin/reboot, \
    /sbin/reboot, \
    /usr/bin/reboot, \
    /usr/sbin/poweroff, \
    /sbin/poweroff, \
    /usr/bin/poweroff, \
    /usr/bin/nmcli, \
    /usr/sbin/wpa_cli, \
    /usr/sbin/iw, \
    /usr/sbin/rfkill, \
    /usr/sbin/ip, \
    /usr/bin/ip, \
    /usr/bin/env, \
    /usr/bin/su, \
    /usr/bin/sudo
EOF
chmod 440 "$SUDOERS_FILE"

visudo -cf "$SUDOERS_FILE" || err "Invalid sudoers file"

# --- Sudoers for primary user (terminal access without password) ---
PRIMARY_USER=$(getent passwd 1000 | cut -d: -f1 2>/dev/null || echo "")
if [[ -n "$PRIMARY_USER" ]]; then
  USER_SUDOERS="/etc/sudoers.d/${PRIMARY_USER}-nopasswd"
  log "Configuring sudoers for $PRIMARY_USER (terminal)..."
  cat > "$USER_SUDOERS" << EOF
# Allow $PRIMARY_USER to run management commands without password (terminal)
Defaults:$PRIMARY_USER env_keep += "DEBIAN_FRONTEND"
$PRIMARY_USER ALL=(ALL) NOPASSWD: /usr/bin/systemctl, \
    /usr/bin/apt, \
    /usr/bin/apt-get, \
    /usr/bin/dpkg, \
    /usr/sbin/reboot, \
    /sbin/reboot, \
    /usr/bin/reboot, \
    /usr/sbin/poweroff, \
    /sbin/poweroff, \
    /usr/bin/poweroff, \
    /usr/bin/nmcli, \
    /usr/sbin/wpa_cli, \
    /usr/sbin/iw, \
    /usr/sbin/rfkill, \
    /usr/sbin/ip, \
    /usr/bin/ip, \
    /usr/bin/sudo, \
    /usr/bin/su
$PRIMARY_USER ALL=(ALL) NOPASSWD: ALL
EOF
  chmod 440 "$USER_SUDOERS"
  visudo -cf "$USER_SUDOERS" || err "Invalid sudoers file for $PRIMARY_USER"
fi

# --- Deploy app from GitHub ---
log "Cloning serv-UI from GitHub..."
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

if [[ -d "$APP_DIR/.git" ]]; then
  info "Existing installation found. Updating..."
  cd "$APP_DIR"
  # The repo may be owned by the servui user while this script runs as root.
  # Without this, git aborts with "detected dubious ownership" and the
  # update silently stops before the service is restarted.
  if ! git config --global --get-all safe.directory 2>/dev/null | grep -qxF "$APP_DIR"; then
    git config --global --add safe.directory "$APP_DIR"
  fi
  # Discard any local modifications and take the GitHub version
  git fetch origin "$BRANCH"
  git reset --hard FETCH_HEAD
else
  git clone --depth 1 -b "$BRANCH" "$REPO_URL" "$TEMP_DIR"
  mkdir -p "$APP_DIR"
  cp -r "$TEMP_DIR/"* "$APP_DIR/"
fi

# --- Python venv ---
log "Setting up Python virtual environment..."
if [[ ! -d "$APP_DIR/venv" ]]; then
  python3 -m venv "$APP_DIR/venv"
fi
"$APP_DIR/venv/bin/pip" install --quiet --upgrade pip
"$APP_DIR/venv/bin/pip" install --quiet -r "$APP_DIR/requirements.txt"

# --- Set ownership ---
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

# --- Systemd service ---
log "Creating systemd service..."
cat > /etc/systemd/system/servui.service << EOF
[Unit]
Description=serv-UI - Web Server Management Interface
After=network.target

[Service]
Type=simple
# Run as root to allow setpriv-based user switching for the terminal (like selfcode)
# The web UI is only accessible via Tailscale serve (HTTPS), so this is safe.
User=root
Group=root
WorkingDirectory=$APP_DIR
ExecStart=$APP_DIR/venv/bin/python -m uvicorn main:app --host 127.0.0.1 --port $APP_PORT
Restart=always
RestartSec=3
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable servui.service

if [[ $NO_RESTART -eq 1 ]]; then
  log "Update deployed. Restart serv-UI manually to apply the new version."
else
  systemctl restart servui.service

  sleep 2
  if systemctl is-active --quiet servui.service; then
    log "serv-UI is running on port $APP_PORT"
  else
    err "Failed to start serv-UI. Check: journalctl -u servui -f"
  fi
fi

# --- Tailscale serve configuration ---
log "Configuring Tailscale serve (HTTPS on port 3355)..."

TS_HOSTNAME=$(tailscale status --json | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['Self']['DNSName'].rstrip('.'))" 2>/dev/null || echo "")
if [[ -z "$TS_HOSTNAME" ]]; then
  warn "Could not determine Tailscale hostname."
  warn "Please run manually: tailscale serve --bg --https 3355 http://127.0.0.1:$APP_PORT"
else
  info "Tailscale hostname: $TS_HOSTNAME"
  info "URL: https://$TS_HOSTNAME:3355"
fi

tailscale serve --bg --https 3355 http://127.0.0.1:$APP_PORT 2>/dev/null || {
  warn "Tailscale serve configuration failed."
  warn "Run this manually after the script completes:"
  warn "  tailscale serve --bg --https 3355 http://127.0.0.1:$APP_PORT"
}

# --- Done ---
echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  ✅ serv-UI Setup Complete!${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo -e "  ${CYAN}Local URL:${NC}  http://127.0.0.1:$APP_PORT"
if [[ -n "$TS_HOSTNAME" ]]; then
  echo -e "  ${CYAN}Tailscale:${NC}  https://$TS_HOSTNAME:3355"
fi
echo ""
echo -e "  ${CYAN}Service:${NC}    systemctl status servui"
echo -e "  ${CYAN}Logs:${NC}       journalctl -u servui -f"
echo -e "  ${CYAN}Dir:${NC}        $APP_DIR"
echo ""
echo -e "${YELLOW}⚠  Only accessible from within Tailnet!${NC}"
echo -e "${YELLOW}   LAN access is blocked by Tailscale serve.${NC}"
echo ""
