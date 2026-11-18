#!/usr/bin/env bash
# Test : en relais, la revue annexe d'Hermes (skills, memoire) part sur une
# copie de la session du tour (--resume + --fork-session) au lieu d'une session
# neuve, et le vrai tour suivant reprend toujours la chaine principale.
set -uo pipefail
ICI="$(cd "$(dirname "$0")" && pwd)"
T=/tmp/proxytest-annexe-relais; rm -rf "${T:?}"; mkdir -p "$T"
HOME="$T" PORT=8981 CLAUDE_BIN="$ICI/faux-claude-args" node "$ICI/../server.js" > "$T/log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null; rm -rf "${T:?}"' EXIT
sleep 2
post() {
  curl -s -m 15 http://127.0.0.1:8981/anthropic/v1/messages -H 'content-type: application/json' -d "{\"model\":\"opus-toolrelay\",\"max_tokens\":50,\"system\":\"sys\",\"tools\":[{\"name\":\"skill_view\",\"description\":\"x\",\"input_schema\":{\"type\":\"object\"}}],\"messages\":$1}" > /dev/null
}
U1='{"role":"user","content":"premiere demande"}'
A='{"role":"assistant","content":[{"type":"text","text":"resume ok"}]}'
U2='{"role":"user","content":"deuxieme"}'
REV='{"role":"user","content":"Review the conversation above and update the skill library."}'
MEM='{"role":"user","content":"Review the conversation above and consider saving to memory."}'
post "[$U1]"
post "[$U1,$A,$REV]"
post "[$U1,$A,$MEM]"
post "[$U1,$A,$U2]"
post "[$U1,$A,$U2,$A,$REV]"
sleep 1
python3 - "$T/args" <<'PY'
import json, sys
a = [json.loads(l) for l in open(sys.argv[1])]
def mode(x):
    if '--fork-session' in x: return 'copie'
    return 'resume' if '--resume' in x else ('neuve' if '--session-id' in x else '?')
vu = [mode(x) for x in a]
sid1 = a[0][a[0].index('--session-id') + 1]
cible = lambda x: x[x.index('--resume') + 1] if '--resume' in x else None
faux = []
if vu != ['neuve', 'copie', 'copie', 'resume', 'copie']: faux.append(f'modes {vu}')
for i in (1, 2, 3):
    if cible(a[i]) != sid1: faux.append(f'appel {i + 1} ne vise pas la session du tour 1')
if cible(a[4]) != sid1: faux.append('revue du tour 2 ne vise pas la chaine principale')
print('ECHEC', faux) if faux else print('OK : neuve, copie, copie, reprise, copie ; chaine principale intacte')
sys.exit(1 if faux else 0)
PY
r=$?; grep "\[relais" "$T/log" | grep -E "demarrage|ratee" | sed "s/.*demarrage, //"; exit $r
