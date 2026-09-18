#!/bin/bash
# playwright_cleanup.sh : balaie les résidus Playwright accumulés par des
# sessions jamais fermées proprement. Depuis l'ajout de --isolated à .mcp.json
# (fin du verrou de profil partagé "browser already in use"), chaque session
# isolée crée un NOUVEAU profil temporaire à chaque lancement de navigateur,
# JAMAIS réutilisé → /tmp grossit sans fin si personne ne balaie derrière.
#
# Ne touche QUE des orphelins réels, jamais une session encore ouverte :
#   - process Chrome/playwright-mcp dont le parent est mort (PPID=1)
#   - dossiers /tmp/playwright_chromiumdev_profile-* sans AUCUN process dessus
# pkill est interdit (cf bash_guard.py, 79 incidents) : ici on ne tue que du
# vraiment mort, un PID exact à la fois, jamais une session encore attachée
# à un process claude vivant (impossible de savoir si elle sert encore).
set -uo pipefail

killed=0
for pid in $(pgrep -f "playwright_chromiumdev_profile|mcp-chrome-" 2>/dev/null || true); do
  ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
  [ -z "$ppid" ] && continue
  if [ "$ppid" = "1" ]; then
    kill -TERM "$pid" 2>/dev/null && killed=$((killed + 1))
  fi
done

removed=0
shopt -s nullglob
for d in /tmp/playwright_chromiumdev_profile-*; do
  [ -d "$d" ] || continue
  if ! pgrep -f -- "user-data-dir=$d([[:space:]]|\$)" >/dev/null 2>&1; then
    rm -rf "$d" && removed=$((removed + 1))
  fi
done

if [ "$killed" -gt 0 ] || [ "$removed" -gt 0 ]; then
  echo "[playwright_cleanup] $killed process orphelin(s) arrêté(s), $removed profil(s) supprimé(s)" >&2
fi
exit 0
