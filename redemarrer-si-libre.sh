#!/usr/bin/env bash
# Redemarre claude-proxy des qu'aucun tour n'est en cours.
# Un redemarrage en plein tour tue le travail et casse la chaine --resume :
# l'historique est alors repaye au tarif creation (6,25 $/M au lieu de 0,50).
set -uo pipefail
LIMITE=${1:-900}   # attente maximale, en secondes
debut=$(date +%s)
while :; do
  running=$(curl -fsS --max-time 5 http://localhost:8000/health 2>/dev/null \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("running",0))' 2>/dev/null)
  [ "${running:-1}" = "0" ] && break
  [ $(( $(date +%s) - debut )) -ge "$LIMITE" ] && { echo "attente depassee, redemarrage force"; break; }
  sleep 10
done
systemctl --user restart claude-proxy.service
echo "claude-proxy redemarre a $(date +%H:%M:%S)"
