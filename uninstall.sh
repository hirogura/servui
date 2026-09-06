#!/bin/bash
# ============================================================
# serv-UI Uninstall Script
# ============================================================
# Usage: sudo bash uninstall.sh
#
# This script:
# 1. Stops and disables the systemd service
# 2. Removes the systemd service file
# 3. Removes sudoers configuration
# 4. Removes the app directory (/opt/servui)
# 5. Optionally removes the servui user
# ============================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

APP_DIR="/opt/servui"
APP_USER="servui"
SUDOERS_FILE="/etc/sudoers.d/servui-systemctl"
SERVICE_FILE="/etc/systemd/system/servui.service"

log() { echo -e "${GREEN}[✔]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err() { echo -e "${RED}[✘]${NC} $1"; exit 1; }
info() { echo -e "${CYAN}[i]${NC} $1"; }

# --- Root check ---
if [[ $EUID -ne 0 ]]; then
  err "This script must be run as root (sudo bash uninstall.sh)"
fi

echo ""
echo -e "${YELLOW}⚠  This will completely remove serv-UI from this server.${NC}"
echo -e "${YELLOW}   The servui user will also be removed.${NC}"
echo ""
read -p "Are you sure? (y/N): " CONFIRM
if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
  echo "Aborted."
  exit 0
fi

# --- Stop & disable service ---
if systemctl is-active --quiet servui.service 2>/dev/null; then
  log "Stopping servui service..."
  systemctl stop servui.service
fi
if systemctl is-enabled --quiet servui.service 2>/dev/null; then
  log "Disabling servui service..."
  systemctl disable servui.service
fi

# --- Remove systemd service file ---
if [[ -f "$SERVICE_FILE" ]]; then
  log "Removing systemd service file..."
  rm -f "$SERVICE_FILE"
  systemctl daemon-reload
fi

# --- Remove Tailscale serve config ---
if command -v tailscale &>/dev/null; then
  log "Removing Tailscale serve configuration..."
  tailscale serve --https=3355 --bg off 2>/dev/null || true
fi

# --- Remove sudoers ---
if [[ -f "$SUDOERS_FILE" ]]; then
  log "Removing sudoers configuration..."
  rm -f "$SUDOERS_FILE"
fi

# --- Remove primary user sudoers ---
PRIMARY_USER=$(getent passwd 1000 | cut -d: -f1 2>/dev/null || echo "")
if [[ -n "$PRIMARY_USER" && -f "/etc/sudoers.d/${PRIMARY_USER}-nopasswd" ]]; then
  log "Removing sudoers for $PRIMARY_USER..."
  rm -f "/etc/sudoers.d/${PRIMARY_USER}-nopasswd"
fi

# --- Remove app directory ---
if [[ -d "$APP_DIR" ]]; then
  log "Removing application directory ($APP_DIR)..."
  rm -rf "$APP_DIR"
fi

# --- Remove user ---
if id "$APP_USER" &>/dev/null; then
  log "Removing user: $APP_USER"
  userdel -r "$APP_USER" 2>/dev/null || userdel "$APP_USER" 2>/dev/null || true
fi

# --- Done ---
echo ""
echo -e "${GREEN}============================================${NC}"
echo -e "${GREEN}  ✅ serv-UI Uninstalled${NC}"
echo -e "${GREEN}============================================${NC}"
echo ""
echo -e "  ${CYAN}Removed:${NC}"
echo -e "    - Systemd service: servui.service"
echo -e "    - Sudoers: $SUDOERS_FILE"
echo -e "    - Application: $APP_DIR"
echo -e "    - User: $APP_USER"
echo -e "    - Tailscale serve: HTTPS:3355"
echo ""
