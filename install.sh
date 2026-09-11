#!/bin/bash
# One-step install for TodoNow: run inside the folder after downloading or cloning it.
#   bash install.sh
set -euo pipefail
if [ "$(uname)" != "Darwin" ]; then echo "TodoNow runs on macOS only."; exit 1; fi
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Zip extraction can drop execute bits; git and tar keep them. Fix either way.
chmod +x "$ROOT/bin/todonow" "$ROOT/install.sh" "$ROOT/uninstall.sh" 2>/dev/null || true

echo "Installing TodoNow from $ROOT"
"$ROOT/bin/todonow" install
echo
echo "Opening the setup checklist in your browser."
TODONOW_HOME="${TODONOW_HOME:-$ROOT}"
PORT="${TODONOW_PORT:-$(sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$TODONOW_HOME/data/settings.json" 2>/dev/null | head -1)}"
sleep 1
open "http://127.0.0.1:${PORT:-7778}/#/settings/setup"
cat <<MSG

Done. TodoNow runs locally at http://127.0.0.1:${PORT:-7778} and starts at every login.
Next steps are on the setup page, in short:
  1. Send a test notification and allow it in System Settings if it does not show.
  2. Set the daily summary time under Settings.
  3. Optionally add todos from Terminal with bin/todonow add "title".

Commands (from $ROOT, or from anywhere as ~/.todonow/bin/todonow):
  bin/todonow status | doctor | stop | start | restart | open
  ./uninstall.sh [--purge]
MSG
