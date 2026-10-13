#!/usr/bin/env bash
# Test : chaque appel du CLI ecrit une ligne de consommation reelle dans
# proxy-usage.jsonl, et Hermes recoit la vraie sortie (pas chars/4).
set -uo pipefail
ICI="$(cd "$(dirname "$0")" && pwd)"
T=/tmp/proxytest-usage; rm -rf "${T:?}"; mkdir -p "$T"
HOME="$T" PORT=8978 CLAUDE_BIN="$ICI/faux-claude-usage" node "$ICI/../server.js" > "$T/log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null; rm -rf "${T:?}"' EXIT
sleep 2
REP=$(curl -s -m 10 http://127.0.0.1:8978/v1/messages -H 'content-type: application/json' \
  -d '{"model":"claude-opus-5","max_tokens":50,"system":"Source: Telegram (group: Hermes QG, thread: 4242)","messages":[{"role":"user","content":"[IMPORTANT: You are running as a scheduled cron job. go"}]}')
sleep 1
L="$T/.hermes/proxy-usage.jsonl"
[ -s "$L" ] || { echo "ECHEC : aucune ligne ecrite"; tail -5 "$T/log"; exit 1; }
python3 - "$L" "$REP" <<'PY'
import json, sys
l = json.loads(open(sys.argv[1]).read().splitlines()[-1]); r = json.loads(sys.argv[2])
attendu = {'source': 'cron', 'topic': '4242', 'entree': 7, 'sortie': 33, 'cache_lu': 1000,
           'cache_ecrit': 200, 'cout_usd': 0.0123, 'statut': 'ok', 'outils': {'Bash': 2, 'Read': 1, 'Skill': 1},
           'skills': {'recherche-thai': 1, 'marwell-index': 1}}
faux = {k: (l.get(k), v) for k, v in attendu.items() if l.get(k) != v}
if r['usage']['output_tokens'] != 33: faux['reponse.output_tokens'] = (r['usage']['output_tokens'], 33)
print('ECHEC', faux) if faux else print('OK : ligne complete, sortie reelle rendue a Hermes')
sys.exit(1 if faux else 0)
PY
