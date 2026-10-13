#!/usr/bin/env bash
# Test : tout appel Prime (`-toolrelay`) plus lourd que Sonnet part en Sonnet,
# avec ou sans effort, compactage (sans outils) compris. Haiku reste Haiku.
# Un appel Hermes (sans `-toolrelay`) en Opus reste en Opus.
set -uo pipefail
ICI="$(cd "$(dirname "$0")" && pwd)"
T=/tmp/proxytest-prime-sonnet; rm -rf "${T:?}"; mkdir -p "$T"
PRIME_MODELE=sonnet HOME="$T" PORT=8978 CLAUDE_BIN="$ICI/faux-claude-args" node "$ICI/../server.js" > "$T/log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null; rm -rf "${T:?}"' EXIT
sleep 2
OUTILS='"tools":[{"name":"ipython","description":"x","input_schema":{"type":"object"}}],'
post() {
  curl -s -m 15 http://127.0.0.1:8978/anthropic/v1/messages -H 'content-type: application/json' \
    -d "{\"model\":\"$1\",\"max_tokens\":50,\"system\":\"sys $1\",$2\"messages\":[{\"role\":\"user\",\"content\":\"demande $1 $RANDOM\"}]}" > /dev/null
}
post opus-toolrelay "$OUTILS"
post opus-high-toolrelay "$OUTILS"
post opus-toolrelay ""
post haiku-toolrelay "$OUTILS"
post opus ""
sleep 1
python3 - "$T/args" <<'PY'
import json, sys
a = [json.loads(l) for l in open(sys.argv[1])]
vu = [x[x.index('--model') + 1] if '--model' in x else '?' for x in a]
attendu = ['sonnet', 'sonnet', 'sonnet', 'haiku', 'opus']
print(('OK : ' if vu == attendu else 'ECHEC : ') + ', '.join(vu))
sys.exit(0 if vu == attendu else 1)
PY
