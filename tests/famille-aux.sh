#!/usr/bin/env bash
# Test (2026-10-28) : un appel auxiliaire a texte seul (vision, verdict, ping)
# part sans outils ni CLAUDE.md, et sa famille sort dans proxy-usage.jsonl.
# Un chantier garde ses outils. Un appel inconnu ne change pas.
set -uo pipefail
ICI="$(cd "$(dirname "$0")" && pwd)"
T=/tmp/proxytest-famille; rm -rf "${T:?}"; mkdir -p "$T"
HOME="$T" PORT=8981 CLAUDE_BIN="$ICI/faux-claude-args" node "$ICI/../server.js" > "$T/log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null; rm -rf "${T:?}"' EXIT
sleep 2
for p in "Concisely describe this image in 2-4 sentences" "hi" "Fully describe and explain everything about this image" "## Chantier : Idea  la suite" "Bonjour, une question libre"; do
  curl -s -m 10 http://127.0.0.1:8981/v1/messages -H 'content-type: application/json' \
    -d "{\"model\":\"claude-sonnet-5-5\",\"max_tokens\":50,\"messages\":[{\"role\":\"user\",\"content\":\"$p\"}]}" >/dev/null
  sleep 1
done
python3 - "$T/args" "$T/.hermes/proxy-usage.jsonl" <<'PY'
import json, sys
a = [json.loads(x) for x in open(sys.argv[1])]
l = [json.loads(x) for x in open(sys.argv[2])]
vide = lambda x: x[x.index('--tools') + 1] == '' and '--setting-sources' in x
attendu = [(True, 'vision'), (True, 'ping'), (False, 'vision-question'), (False, 'chantier'), (False, None)]
obtenu = [(vide(x), y.get('famille')) for x, y in zip(a, l)]
ok = len(a) == 5 and obtenu == attendu
print('OK : texte seul sans outils, chantier et inconnu inchanges' if ok else f'ECHEC {obtenu}')
sys.exit(0 if ok else 1)
PY
