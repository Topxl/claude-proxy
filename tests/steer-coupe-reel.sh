#!/usr/bin/env bash
# Steer pendant un sous-agent au premier plan : le proxy doit couper le tour,
# puis faire lire le message (2026-10-07, topic Marwell 2). CLI reel, coute un
# vrai tour en haiku. Lance son propre proxy sur 8977, index de sessions a part.
ICI="$(cd "$(dirname "$0")" && pwd)"
LOG=/tmp/proxytest-coupe.log; OUT=/tmp/proxytest-coupe.sse
PORT=8977 CLAUDE_SESSIONS_FICHIER=/tmp/proxytest-coupe-sessions.json \
  PROXY_USAGE_LOG=/tmp/proxytest-coupe-usage.jsonl node "$ICI/../server.js" > "$LOG" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null' EXIT
sleep 2
SYS='Tu es un assistant de test. Source: Telegram (thread: 99998).'
Q="Lance UN sous-agent avec l'outil Agent (subagent_type general-purpose, model haiku, au premier plan, pas en arriere-plan). Sa tache : executer la commande Bash \`timeout 120 tail -f /dev/null\` (attente volontaire de test, autorisee) puis repondre FINI. Attends son retour, puis reponds FINI."
BODY=$(jq -n --arg s "$SYS" --arg q "$Q" '{model:"haiku",stream:true,max_tokens:2000,system:$s,messages:[{role:"user",content:$q}]}')
DEBUT=$(date +%s)
curl -sN -m 200 localhost:8977/v1/messages -H 'content-type: application/json' -d "$BODY" > "$OUT" &
CP=$!
for i in $(seq 1 40); do grep -q "Agent" "$OUT" 2>/dev/null && break; sleep 1; done
sleep 6
echo "steer: $(curl -s -m 5 localhost:8977/steer -H 'content-type: application/json' -d '{"topic":"99998","texte":"Annule, ne fais pas cette attente. Reponds juste POMME."}')"
wait $CP
DUREE=$(( $(date +%s) - DEBUT ))
TEXTE=$(grep -o '"text":"[^"]*"' "$OUT" | sed 's/"text":"//;s/"$//' | tr -d '\n')
echo "texte: $TEXTE"; echo "duree: ${DUREE}s"
grep "\[steer\]" "$LOG"
echo "$TEXTE" | grep -q POMME || { echo "ECHEC : POMME absent"; exit 1; }
[ "$DUREE" -lt 100 ] || { echo "ECHEC : ${DUREE}s, le sous-agent n'a pas ete coupe"; exit 1; }
echo "OK : sous-agent coupe, message lu, ${DUREE}s"
