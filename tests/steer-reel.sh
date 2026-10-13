#!/usr/bin/env bash
# Test du steer : tour long (sleep 20), message injecte a 6 s.
# CLI reel, coute un vrai tour. Lancer un proxy de test sur $P avant (voir README).
P=${P:-8011}
SYS='Tu es un assistant de test. Source: Telegram (thread: 99999).'
BODY=$(jq -n --arg s "$SYS" '{model:"sonnet",stream:true,max_tokens:2000,system:$s,messages:[{role:"user",content:"Lance la commande Bash `sleep 20 && echo fini`, puis dis en une phrase ce que tu as fait."}]}')
curl -sN -m 240 localhost:$P/v1/messages -H 'content-type: application/json' -d "$BODY" > /tmp/steer-test/sortie.sse &
CP=$!
sleep 6
echo "steer: $(curl -s -m 5 localhost:$P/steer -H 'content-type: application/json' -d '{"topic":"99999","texte":"Termine ta reponse par le mot BANANE en majuscules."}')"
wait $CP
grep -o '"text":"[^"]*"' /tmp/steer-test/sortie.sse | sed 's/"text":"//;s/"$//' | tr -d '\n'; echo
echo "message_stop: $(grep -c message_stop /tmp/steer-test/sortie.sse)"
