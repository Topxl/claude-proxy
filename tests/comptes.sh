#!/usr/bin/env bash
# Test : plusieurs comptes Claude. Choix par `@nom`, bascule quand un compte
# est a court, compte epuise memorise, erreur claire quand tous le sont.
set -uo pipefail
ICI="$(cd "$(dirname "$0")" && pwd)"
T=/tmp/proxytest-comptes; rm -rf "${T:?}"; mkdir -p "$T/cfg"
echo 'CLAUDE_CODE_OAUTH_TOKEN=jeton-plein' > "$T/cfg/a.env"
echo 'CLAUDE_CODE_OAUTH_TOKEN=jeton-b' > "$T/cfg/b.env"
echo 'CLAUDE_CODE_OAUTH_TOKEN=jeton-c' > "$T/cfg/c.env"
echo '{"comptes":[{"nom":"a","fichier":"a.env"},{"nom":"b","fichier":"b.env"},{"nom":"c","fichier":"c.env"}]}' > "$T/cfg/comptes.json"
HOME="$T" PORT=8979 PROXY_COMPTES_DIR="$T/cfg" PROXY_COMPTES_SANS_ALERTE=1 FAUX_TRACE="$T/trace" \
  CLAUDE_BIN="$ICI/faux-claude-comptes" node "$ICI/../server.js" > "$T/log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null; rm -rf "${T:?}"' EXIT
sleep 2
appel() {
  curl -s -m 15 http://127.0.0.1:8979/v1/messages -H 'content-type: application/json' \
    -d "{\"model\":\"$1\",\"max_tokens\":20,\"messages\":[{\"role\":\"user\",\"content\":\"salut\"}]}" \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); print((d.get("content") or [{}])[0].get("text") or d.get("error",{}).get("message",""))'
}
KO=0
verif() { if [[ "$2" == *"$3"* ]]; then echo "OK : $1"; else echo "ECHEC : $1 -> $2"; KO=1; fi; }
verif "a a court, bascule sur b"        "$(appel claude-haiku-5-5)"   "ok:jeton-b"
: > "$T/trace"; appel claude-haiku-5-5 >/dev/null
verif "a memorise epuise, plus essaye"  "$(tr '\n' ' ' < "$T/trace")" "jeton-b "
[[ "$(cat "$T/trace")" == "jeton-b" ]] || { echo "ECHEC : a encore essaye"; KO=1; }
verif "choix par @c"                    "$(appel claude-haiku-5-5@c)" "ok:jeton-c"
verif "@a epuise, repli sur b"          "$(appel claude-haiku-5-5@a)" "ok:jeton-b"
verif "/health sans jeton"              "$(curl -s http://127.0.0.1:8979/health | python3 -c 'import json,sys; c=json.load(sys.stdin)["comptes"]; print(c[0]["disponible"], c[1]["disponible"], "jeton" in json.dumps(c))')" "False True False"
echo 'CLAUDE_CODE_OAUTH_TOKEN=jeton-plein' > "$T/cfg/b.env"
echo 'CLAUDE_CODE_OAUTH_TOKEN=jeton-plein' > "$T/cfg/c.env"
verif "tous a court : erreur claire"    "$(appel claude-haiku-5-5)"   "every Claude account"
verif "tous a court : plus de lancement" "$(: > "$T/trace"; appel claude-haiku-5-5 >/dev/null; wc -l < "$T/trace")" "0"
grep -q "a court, bascule\|alerte (coupee)" "$T/log" || { echo "ECHEC : rien au journal"; KO=1; }
exit $KO
