#!/usr/bin/env bash
# Test du fil en direct (cron Hermes, cron/fil_direct.py) : un prompt qui porte
# <<FIL-DIRECT>> recoit la ligne « → Bash: date » dans le stream ; un prompt
# ordinaire ne recoit que le texte, comme avant.
set -uo pipefail
ICI="$(cd "$(dirname "$0")" && pwd)"
T=/tmp/proxytest-fil; rm -rf "${T:?}"; mkdir -p "$T"
HOME="$T" PORT=8979 CLAUDE_BIN="$ICI/faux-claude-outils" node "$ICI/../server.js" > "$T/log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null; rm -rf "${T:?}"' EXIT
sleep 2
appel() {
  curl -s -N -m 10 http://127.0.0.1:8979/v1/messages -H 'content-type: application/json' \
    -d "{\"model\":\"claude-opus-5\",\"max_tokens\":50,\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"$1\"}]}"
}
AVEC=$(appel '<<FIL-DIRECT>>\nfais le tour')
SANS=$(appel 'fais le tour')
ok=0
grep -q '→ Bash: date' <<<"$AVEC" || { echo "ECHEC : ligne d'outil absente avec la marque"; ok=1; }
grep -q '→ Bash' <<<"$SANS" && { echo "ECHEC : ligne d'outil presente sans la marque"; ok=1; }
grep -q 'Rapport fini' <<<"$SANS" || { echo "ECHEC : texte absent sans la marque"; ok=1; }
[ $ok = 0 ] && echo "OK : journal d'outils emis seulement pour les tours du fil"
exit $ok
