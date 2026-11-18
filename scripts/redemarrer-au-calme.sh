#!/usr/bin/env bash
# Redemarrage de claude-proxy SANS tuer les tours en cours.
#
# Pourquoi ce script existe
#   Les sous-agents `claude` sont des enfants de claude-proxy.service. Un agent
#   qui redemarre ce service tue tous ses confreres ET lui-meme. Le garde-fou
#   bash_guard.py refuse donc tout `systemctl restart claude-proxy` lance a la
#   main, et renvoie ici.
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

# Chaque issue (relance faite, relance ratee, abandon) se dit au QG : VJ ne
# doit pas avoir a demander si le proxy a ete relance (demande du 2026-10-27).
au_qg() {
  command -v qg-attente >/dev/null || return 0
  qg-attente add "$1" --resume "$2" --source redemarrer-au-calme >/dev/null 2>&1 || true
}

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
    au_qg "Proxy NON relance" "Abandon apres ${ecoule} s : encore ${r} tour(s) et ${e} sous-agent(s) en cours. Les changements du proxy restent inactifs."
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
if printf '%s' "$etat" | grep -q '"status":"ok"'; then
  au_qg "Proxy relance" "Relance faite a $(date '+%H:%M'), sans couper aucun tour. Sante : ok."
else
  au_qg "Proxy relance mais injoignable" "Relance a $(date '+%H:%M'), mais la sante ne repond pas : ${etat:-injoignable}. A regarder."
fi
