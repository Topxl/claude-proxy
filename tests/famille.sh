#!/usr/bin/env bash
# Test de non-regression : une conversation ne reprend jamais la session CLI
# d'une requete annexe (titre) qui partageait son premier message.
set -euo pipefail
ICI="$(cd "$(dirname "$0")" && pwd)"
LOG=/tmp/proxytest-famille.log
HOME=/tmp/proxytest-famille PORT=8978 CLAUDE_BIN="$ICI/faux-claude" \
  node "$ICI/../server.js" > "$LOG" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null; rm -rf /tmp/proxytest-famille' EXIT
sleep 2
node "$ICI/famille.mjs"
sleep 1
grep "\[sess\]" "$LOG"
TITRE=$(grep -m1 "\[sess\] neuve" "$LOG" | awk '{print $3}')
if grep -q "\[sess\] reprise $TITRE" "$LOG"; then
  echo "ECHEC : la conversation a repris la session du titre ($TITRE)"; exit 1
fi
echo "OK : la session du titre ($TITRE) reste a part"
