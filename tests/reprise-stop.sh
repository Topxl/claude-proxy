#!/usr/bin/env bash
# Reprise apres un /stop quand la tete du prompt systeme a change (repli par
# signature, limite au topic). Instance isolee du proxy avec un faux CLI.
set -euo pipefail
ICI="$(cd "$(dirname "$0")" && pwd)"
LOG=/tmp/proxytest-reprise-stop.log
HOME=/tmp/proxytest-home-stop PORT=8978 CLAUDE_BIN="$ICI/faux-claude" \
  node "$ICI/../server.js" > "$LOG" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null; rm -rf /tmp/proxytest-home-stop' EXIT
sleep 2
node "$ICI/reprise-stop.mjs"
sleep 1
grep "\[sess\]" "$LOG"
SIG=$(grep -c "repli signature, topic 9001" "$LOG" || true)
REPRISES=$(grep -c "\[sess\] reprise" "$LOG" || true)
[ "$SIG" -eq 1 ] || { echo "ECHEC : $SIG reprise(s) par signature, 1 attendue"; exit 1; }
# Le tour 2 repart neuf, comme dans chainage.sh : la session du tour 1 ne
# contient pas encore de reponse validee a reprendre.
[ "$REPRISES" -eq 1 ] || { echo "ECHEC : $REPRISES reprises, 1 attendue (tour 3)"; exit 1; }
echo "OK : stop repris, autre topic et /undo repartent neufs"
