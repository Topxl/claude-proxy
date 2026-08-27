#!/usr/bin/env bash
# Surveille claude-proxy. Deux pannes sont traitees :
#   1. le port ne repond plus       -> le process est mort ou fige
#   2. status "degraded"            -> il repond, mais le CLI echoue en serie
# Dans les deux cas, redemarrage du service.
set -uo pipefail

URL="http://localhost:8000/health"
SERVICE="claude-proxy.service"

restart() {
  echo "claude-proxy: $1 — redemarrage"
  systemctl --user restart "$SERVICE"
  exit 0
}

# 1. Joignable ? Deux essais avant de conclure : un pic de charge n'est pas une panne.
body=""
for attempt in 1 2; do
  if body=$(curl -fsS --max-time 5 "$URL" 2>/dev/null); then
    break
  fi
  body=""
  [ "$attempt" -eq 1 ] && sleep 5
done

[ -z "$body" ] && restart "injoignable sur $URL"

# 2. En bonne sante ? "degraded" = 3 echecs CLI d'affilee.
status=$(printf '%s' "$body" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status",""))' 2>/dev/null)

# Garde : un redemarrage en plein tour tue le travail ET la chaine --resume,
# donc l'historique est repaye au tarif creation. On ne redemarre jamais un
# proxy qui travaille : la panne "degraded" attendra le passage suivant.
running=$(printf '%s' "$body" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("running",0))' 2>/dev/null)
if [ "${running:-0}" != "0" ]; then
  echo "claude-proxy: ${running} tour(s) HTTP en cours — pas de redemarrage"
  exit 0
fi

# 2026-08-27 : le compteur "running" ne voit QUE les tours HTTP ouverts. Les
# sous-agents lances en arriere-plan sont des enfants `claude` du proxy qui
# survivent a la fin du tour qui les a lances. Trois series d'agents ont ete
# tuees en pleine tache parce que le healthcheck a redemarre le proxy pendant
# qu'ils travaillaient, invisibles pour lui. On compte donc les enfants reels.
main_pid=$(systemctl --user show "$SERVICE" -p MainPID --value 2>/dev/null)
if [ -n "${main_pid:-}" ] && [ "${main_pid:-0}" != "0" ]; then
  enfants=$(pgrep -P "$main_pid" -x claude 2>/dev/null | wc -l)
  if [ "${enfants:-0}" -gt 0 ]; then
    echo "claude-proxy: ${enfants} sous-agent(s) en cours — pas de redemarrage"
    exit 0
  fi
fi

if [ "$status" = "degraded" ]; then
  detail=$(printf '%s' "$body" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("lastFailure",""))' 2>/dev/null)
  restart "degrade — derniere erreur: ${detail:-inconnue}"
fi

exit 0
