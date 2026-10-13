#!/usr/bin/env bash
# Test : une requete `-toolrelay` SANS outils (compactage de Prime Agent) est
# servie en texte seul, au lieu du 400 qui empechait tout resume (2026-10-03).
set -uo pipefail
ICI="$(cd "$(dirname "$0")" && pwd)"
T=/tmp/proxytest-compactage; rm -rf "${T:?}"; mkdir -p "$T"
HOME="$T" PORT=8977 CLAUDE_BIN="$ICI/faux-claude-args" node "$ICI/../server.js" > "$T/log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null; rm -rf "${T:?}"' EXIT
sleep 2
CODE=$(curl -s -o "$T/rep" -w '%{http_code}' -m 15 http://127.0.0.1:8977/v1/messages \
  -H 'content-type: application/json' \
  -d '{"model":"claude-opus-5-toolrelay","max_tokens":50,"messages":[{"role":"user","content":"Resume la conversation."}]}')
ok=1
[ "$CODE" = 200 ] || { echo "ECHEC : HTTP $CODE au lieu de 200"; cat "$T/rep"; ok=0; }
grep -q 'resume ok' "$T/rep" || { echo "ECHEC : texte du modele absent"; ok=0; }
grep -q '"--tools",""' "$T/args" 2>/dev/null || { echo "ECHEC : le CLI a recu des outils"; ok=0; }
grep -q 'mcp__relay\|toolrelay' "$T/args" 2>/dev/null && { echo "ECHEC : le relais MCP a ete monte"; ok=0; }
[ $ok = 1 ] && echo "OK : compactage sans outils servi en texte seul"
[ $ok = 1 ]
