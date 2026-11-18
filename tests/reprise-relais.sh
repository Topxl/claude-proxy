#!/usr/bin/env bash
# Test : d'un tour Prime au suivant, le relais reprend la session CLI
# (--resume + dernier message seul) au lieu de renvoyer l'historique aplati.
# Un historique retouche (compactage) doit retomber sur une session neuve.
# Les appels portent la source « prime » dans proxy-usage.jsonl.
set -uo pipefail
ICI="$(cd "$(dirname "$0")" && pwd)"
T=/tmp/proxytest-reprise; rm -rf "${T:?}"; mkdir -p "$T"
HOME="$T" PORT=8979 CLAUDE_BIN="$ICI/faux-claude-args" node "$ICI/../server.js" > "$T/log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null; rm -rf "${T:?}"' EXIT
sleep 2
post() {
  curl -s -m 15 http://127.0.0.1:8979/anthropic/v1/messages -H 'content-type: application/json' -d "{\"model\":\"opus-toolrelay\",\"max_tokens\":50,\"system\":\"prime sys\",\"tools\":[{\"name\":\"ipython\",\"description\":\"x\",\"input_schema\":{\"type\":\"object\"}}],\"messages\":$1}" > /dev/null
}
# Le 1er message porte les blocs qu'Hermes colle pour un seul appel puis retire
# de l'historique (memoire, regles apprises) : la reprise doit les ignorer.
U1='{"role":"user","content":[{"type":"text","text":"premiere demande\n\n<memory-context>\nfait #1\n</memory-context>\n\n<regles-apprises>\n- regle\n</regles-apprises>","cache_control":{"type":"ephemeral"}}]}'
A='{"role":"assistant","content":[{"type":"text","text":"resume ok"}]}'
post "[$U1]"
post "[{\"role\":\"user\",\"content\":\"premiere demande\"},$A,{\"role\":\"user\",\"content\":\"deuxieme\"}]"
post "[{\"role\":\"user\",\"content\":\"premiere demande\"},$A,{\"role\":\"user\",\"content\":\"deuxieme\"},$A,{\"role\":\"user\",\"content\":\"troisieme\"}]"
post "[{\"role\":\"user\",\"content\":\"RESUME COMPACTE\"},$A,{\"role\":\"user\",\"content\":\"quatrieme\"}]"
sleep 1
python3 - "$T/args" "$T/.hermes/proxy-usage.jsonl" <<'PY'
import json, sys
a = [json.loads(l) for l in open(sys.argv[1])]
mode = lambda x: 'resume' if '--resume' in x else ('neuve' if '--session-id' in x else '?')
vu = [mode(x) for x in a]
sid1 = a[0][a[0].index('--session-id') + 1]
faux = []
if vu != ['neuve', 'resume', 'resume', 'neuve']: faux.append(f'modes {vu}')
if '--resume' in a[1] and a[1][a[1].index('--resume') + 1] != sid1: faux.append('tour 2 ne reprend pas la session du tour 1')
src = {json.loads(l)['source'] for l in open(sys.argv[2])}
if src != {'prime'}: faux.append(f'sources {src}')
print('ECHEC', faux) if faux else print('OK : neuve, reprise, reprise, neuve apres compactage ; source prime')
sys.exit(1 if faux else 0)
PY
r=$?; grep "\[relais" "$T/log" | grep -E "demarrage|ratee" | sed "s/.*demarrage, //"; exit $r
