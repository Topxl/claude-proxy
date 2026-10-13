#!/usr/bin/env bash
# Test : un topic liste dans ~/.hermes/topics-relais.json passe en relais
# d'outils sans suffixe `-toolrelay`, si et seulement si des outils sont
# declares. Les autres topics restent sur le chemin normal, Prime aussi.
set -uo pipefail
ICI="$(cd "$(dirname "$0")" && pwd)"
T=/tmp/proxytest-relais-topic; rm -rf "${T:?}"; mkdir -p "$T/.hermes"
echo '["23422"]' > "$T/.hermes/topics-relais.json"
HOME="$T" PORT=8979 CLAUDE_BIN="$ICI/faux-claude-args" node "$ICI/../server.js" > "$T/log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null; rm -rf "${T:?}"' EXIT
sleep 2
OUTILS='"tools":[{"name":"terminal","description":"x","input_schema":{"type":"object"}}],'
post() {
  curl -s -m 15 http://127.0.0.1:8979/anthropic/v1/messages -H 'content-type: application/json' \
    -d "{\"model\":\"$1\",\"max_tokens\":50,\"system\":\"Source: Telegram (group: Hermes QG, thread: $2)\",$3\"messages\":[{\"role\":\"user\",\"content\":\"demande $RANDOM\"}]}" > /dev/null
}
post claude-opus-5-5 23422 "$OUTILS"
post claude-opus-5-5 23422 ""
post claude-opus-5-5 2 "$OUTILS"
post opus-toolrelay 2 "$OUTILS"
# Chemin du QG (qg-envoyer.sh) : prompt stocke sans topic, puis le cadre
# ajoute par l'api_server d'Hermes, qui porte « thread: N ».
postsys() {
  curl -s -m 15 http://127.0.0.1:8979/anthropic/v1/messages -H 'content-type: application/json' \
    -d "{\"model\":\"claude-opus-5-5\",\"max_tokens\":50,\"system\":\"$1\",$OUTILS\"messages\":[{\"role\":\"user\",\"content\":\"demande $RANDOM\"}]}" > /dev/null
}
postsys "Tu es Hermes. Source: api_server.\\n\\nSource: Telegram (thread: 23422). Message de VJ, poste dans ce topic Telegram."
postsys "Tu es Hermes. Source: api_server.\\n\\nMessage de VJ, poste dans ce topic Telegram."
sleep 1
python3 - "$T/args" <<'PY'
import json, sys
a = [json.loads(l) for l in open(sys.argv[1])]
vu = ['relais' if any('mcp__relay__' in x for x in args) else 'normal' for args in a]
attendu = ['relais', 'normal', 'normal', 'relais', 'relais', 'normal']
print(('OK : ' if vu == attendu else 'ECHEC : ') + ', '.join(vu))
sys.exit(0 if vu == attendu else 1)
PY
