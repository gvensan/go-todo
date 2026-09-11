#!/bin/bash
# Remove TodoNow from this Mac.
#   ./uninstall.sh            stop and remove the login agent and the ~/.todonow link; keep your data
#   ./uninstall.sh --purge    also delete your todos, settings, logs and backups (asks first)
#   ./uninstall.sh --purge --yes    no questions
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PURGE=0; YES=0
for a in "$@"; do case "$a" in --purge) PURGE=1 ;; --yes|-y) YES=1 ;; *) echo "unknown option: $a"; exit 1 ;; esac; done

TODONOW_HOME="${TODONOW_HOME:-$ROOT}"
DOMAIN="gui/$(id -u)"

echo "Uninstalling TodoNow from $ROOT"

# 1. Remove the agent, plist and links (data untouched).
if [ -x "$ROOT/bin/todonow" ]; then
  "$ROOT/bin/todonow" uninstall || true
else
  launchctl bootout "$DOMAIN/dev.todonow" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/dev.todonow.plist"
  [ -L "$HOME/.todonow" ] && rm -f "$HOME/.todonow"
fi
rm -f "$ROOT/bin/node"

# 2. Make sure nothing from this folder is still running.
pkill -f "$ROOT/server.js" 2>/dev/null || true

# 3. Optionally remove personal data.
if [ "$PURGE" = 1 ]; then
  echo
  echo "This will permanently delete:"
  echo "  $TODONOW_HOME/data   (todos, folders, settings, reminder ledger, backups)"
  echo "  $ROOT/logs"
  if [ "$YES" != 1 ]; then
    read -r -p "Type DELETE to confirm: " answer
    [ "$answer" = "DELETE" ] || { echo "kept your data"; PURGE=0; }
  fi
  if [ "$PURGE" = 1 ]; then
    rm -rf "$TODONOW_HOME/data" "$ROOT/logs"
    echo "data deleted"
  fi
else
  echo "Your data is untouched in $TODONOW_HOME/data (use --purge to delete it)."
fi

cat <<MSG

TodoNow is uninstalled. Things macOS keeps, remove by hand if you want:
  - Notification permission for "Script Editor" under System Settings > Notifications (harmless to leave)
  - This folder: rm -rf "$ROOT"
MSG
