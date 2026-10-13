#!/usr/bin/env bash
# Un texte d'attente puis la reponse, separes par un outil, ne doivent pas se
# coller (« je te reponds.Voici », rapports 2616 et 2621 du 13/10/2026) :
# le proxy les separe par une ligne vide.
set -uo pipefail
ICI="$(cd "$(dirname "$0")" && pwd)"
T=/tmp/proxytest-segments; rm -rf "${T:?}"; mkdir -p "$T"
HOME="$T" PORT=8981 CLAUDE_BIN="$ICI/faux-claude-segments" node "$ICI/../server.js" > "$T/log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null; rm -rf "${T:?}"' EXIT
sleep 2
FLUX=$(curl -s -N -m 10 http://127.0.0.1:8981/v1/messages -H 'content-type: application/json' \
  -d '{"model":"claude-opus-5","max_tokens":50,"stream":true,"messages":[{"role":"user","content":"fais le tour"}]}')
TEXTE=$(grep '^data:' <<<"$FLUX" | sed 's/^data: //' | node -e '
  let t = ""; require("readline").createInterface({ input: process.stdin }).on("line", (l) => {
    try { const e = JSON.parse(l); if (e.delta && e.delta.type === "text_delta") t += e.delta.text; } catch {}
  }).on("close", () => process.stdout.write(JSON.stringify(t)));')
echo "texte rendu : $TEXTE"
if grep -q 'reponds\.Rapport' <<<"$TEXTE"; then echo "ECHEC : les 2 textes sont colles"; exit 1; fi
if ! grep -q 'reponds\.\\n\\nRapport fini' <<<"$TEXTE"; then echo "ECHEC : separation attendue absente"; exit 1; fi
echo "OK : texte d'attente et reponse separes par une ligne vide"
