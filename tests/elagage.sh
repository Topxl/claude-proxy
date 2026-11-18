#!/usr/bin/env bash
# Test : l'elagage des resultats d'outils au demarrage a froid.
set -euo pipefail
ICI="$(cd "$(dirname "$0")" && pwd)"
T=$(mktemp -d /tmp/proxytest-elagage.XXXX)
HOME="$T" PORT=8984 CLAUDE_BIN="$ICI/faux-claude-args" node "$ICI/../server.js" > "$T/log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null; rm -rf "$T"' EXIT
sleep 2
node "$ICI/elagage.mjs"
sleep 1
N=$(grep -c "\[elag\]" "$T/log" || true)
[ "$N" = "1" ] || { echo "ECHEC : $N ligne(s) [elag], attendu 1 (historique long seulement)"; cat "$T/log" | tail -8; exit 1; }
LIGNE=$(grep "\[elag\]" "$T/log")
AV=$(echo "$LIGNE" | sed -E 's/.*prompt ([0-9]+) -> ([0-9]+) car/\1/'); AP=$(echo "$LIGNE" | sed -E 's/.*prompt ([0-9]+) -> ([0-9]+) car/\2/')
[ "$AV" -gt 60000 ] && [ "$AP" -lt $((AV - 15000)) ] || { echo "ECHEC : tailles $AV -> $AP"; exit 1; }
echo "OK : prompt $AV -> $AP car, historique court intact"
