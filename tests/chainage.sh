#!/usr/bin/env bash
# Test du chainage --resume : verifie qu'une session se reprend malgre les
# messages d'outils intercales ET la reecriture du dernier message utilisateur
# par Hermes. Lance une instance isolee du proxy avec un faux CLI.
set -euo pipefail
ICI="$(cd "$(dirname "$0")" && pwd)"
HOME=/tmp/proxytest-home PORT=8977 CLAUDE_BIN="$ICI/faux-claude" \
  node "$ICI/../server.js" > /tmp/proxytest.log 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null; rm -rf /tmp/proxytest-home' EXIT
sleep 2
node "$ICI/chainage.mjs"
sleep 1
REPRISES=$(grep -c "\[sess\] reprise" /tmp/proxytest.log || true)
grep "\[sess\]" /tmp/proxytest.log
[ "$REPRISES" -ge 2 ] || { echo "ECHEC : $REPRISES reprises, 2 attendues"; exit 1; }
echo "OK : $REPRISES reprises"
