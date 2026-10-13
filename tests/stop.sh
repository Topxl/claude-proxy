#!/usr/bin/env bash
# Test de non-regression : un /stop (client qui raccroche) tue tout ce que le
# tour a lance, meme sous setsid, sauf les demons partages (OpenCLI, Chrome).
set -uo pipefail
ICI="$(cd "$(dirname "$0")" && pwd)"
LOG=/tmp/proxytest-stop.log
HOME=/tmp/proxytest-stop PORT=8979 CLAUDE_BIN="$ICI/faux-claude-stop" \
  node "$ICI/../server.js" > "$LOG" 2>&1 &
PID=$!
nettoyer() { kill $PID 2>/dev/null; for p in $(pgrep -f 'sleep 30[123]$'); do kill "$p"; done; rm -rf /tmp/proxytest-stop; }
trap nettoyer EXIT
sleep 2
curl -sN -m 4 http://127.0.0.1:8979/v1/messages -H 'content-type: application/json' \
  -d '{"model":"claude-opus-5","max_tokens":50,"stream":true,"messages":[{"role":"user","content":"go"}]}' > /dev/null
sleep 2
grep -E '\[coupure\]|\[tuer\]' "$LOG"
ok=1
for n in 301 302; do pgrep -f "sleep $n\$" > /dev/null && { echo "ECHEC : sleep $n survit au /stop"; ok=0; }; done
pgrep -f 'opencli/dist/src/daemon.js' > /dev/null || { echo "ECHEC : le demon partage a ete tue"; ok=0; }
[ $ok = 1 ] && echo "OK : tour tue en entier, demon partage epargne"
[ $ok = 1 ]
