#!/usr/bin/env bash
# Redemarrage de claude-proxy SANS tuer les tours en cours.
#
# Pourquoi ce script existe
#   Les sous-agents `claude` sont des enfants de claude-proxy.service. Un agent
#   qui redemarre ce service tue tous ses confreres ET lui-meme : incident du
#   2026-08-27, trois series d'agents perdues. Le garde-fou bash_guard.py
#   refuse donc tout `systemctl restart claude-proxy` lance a la main, et
#   renvoie ici. Ce fichier etait cite par le garde-fou sans avoir jamais ete
#   ecrit : cree le 2026-09-10.
#
# Ce qu'il fait
#   Attend que plus aucun tour HTTP ne soit ouvert ET que le proxy n'ait plus
#   d'enfant `claude`, puis redemarre. L'agent qui le lance est lui-meme un de
#   ces enfants : le script se detache donc et patiente jusqu'a la fin du tour
#   qui l'a lance.
#
# Usage
#   setsid nohup scripts/redemarrer-au-calme.sh >/tmp/relance-proxy.log 2>&1 &
#
# Variables
#   ATTENTE_MAX_S  plafond d'attente avant abandon (defaut 1800 s)
#   PAS_S          intervalle entre deux verifications (defaut 10 s)
set -uo pipefail

SERVICE="claude-proxy.service"
SANTE="http://127.0.0.1:8000/health"
ATTENTE_MAX_S="${ATTENTE_MAX_S:-1800}"
PAS_S="${PAS_S:-10}"

horodate() { date '+%Y-%m-%d %H:%M:%S'; }

tours_ouverts() {
  curl -s --max-time 5 "$SANTE" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("running",0))' 2>/dev/null \
    || echo 0
}

enfants_claude() {
  local pid
  pid=$(systemctl --user show "$SERVICE" -p MainPID --value 2>/dev/null)
  [ -z "${pid:-}" ] || [ "${pid:-0}" = "0" ] && { echo 0; return; }
  pgrep -P "$pid" -x claude 2>/dev/null | wc -l
}

echo "$(horodate) attente du calme (max ${ATTENTE_MAX_S} s)"
debut=$(date +%s)
while :; do
  r=$(tours_ouverts)
  e=$(enfants_claude)
  if [ "${r:-0}" -eq 0 ] && [ "${e:-0}" -eq 0 ]; then
    echo "$(horodate) calme atteint : 0 tour, 0 sous-agent"
    break
  fi
  ecoule=$(( $(date +%s) - debut ))
  if [ "$ecoule" -ge "$ATTENTE_MAX_S" ]; then
    echo "$(horodate) ABANDON : encore ${r} tour(s) et ${e} sous-agent(s) apres ${ecoule} s"
    exit 1
  fi
  echo "$(horodate) occupe : ${r} tour(s), ${e} sous-agent(s), ${ecoule} s ecoulees"
  sleep "$PAS_S"
done

echo "$(horodate) redemarrage de $SERVICE"
systemctl --user restart "$SERVICE"
sleep 4
etat=$(curl -s --max-time 5 "$SANTE")
echo "$(horodate) sante apres relance : ${etat:-injoignable}"
