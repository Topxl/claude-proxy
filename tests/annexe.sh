#!/usr/bin/env bash
# La revue memoire d'Hermes ne doit pas voler la session du topic (2026-10-07).
set -euo pipefail
ICI="$(cd "$(dirname "$0")" && pwd)"
LOG=/tmp/proxytest-annexe.log
HOME=/tmp/proxytest-home-annexe PORT=8979 CLAUDE_BIN="$ICI/faux-claude" \
  node "$ICI/../server.js" > "$LOG" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null; rm -rf /tmp/proxytest-home-annexe' EXIT
sleep 2
node "$ICI/annexe.mjs"
sleep 1
grep "\[sess\]" "$LOG"
COPIE=$(grep -c "\[sess\] annexe : copie" "$LOG" || true)
[ "$COPIE" -eq 1 ] || { echo "ECHEC : $COPIE copie(s), 1 attendue"; exit 1; }
ID3=$(grep "\[sess\] reprise" "$LOG" | sed -n 1p | awk '{print $3}')
ID4=$(grep "\[sess\] reprise" "$LOG" | tail -1 | awk '{print $3}')
grep -q "repli signature" "$LOG" && { echo "ECHEC : repli par signature, la cle aurait du suffire"; exit 1; }
[ -n "$ID3" ] && [ "$ID3" = "$ID4" ] || { echo "ECHEC : tour 4 sur $ID4, attendu $ID3"; exit 1; }
echo "OK : revue en copie, tour suivant sur la meme session $ID4"
