#!/usr/bin/env bash
# Remonte le verdict du dernier deploiement automatique dans la conversation.
# Lance par le hook UserPromptSubmit : ce que ce script ecrit sur stdout entre
# dans le contexte de Claude.
#
# Pourquoi ce hook existe : quand le deploiement part en arriere-plan ou depuis
# le hook Stop, un echec ne se voit nulle part. C'est exactement le defaut qui a
# coute trente-et-un deploiements silencieux a DJ entre juin et aout 2026, dont
# trois nuits d'affilee. Un journal que personne n'ouvre n'est pas une alerte.
#
# CE QUI PARLE, ET CE QUI SE TAIT (principe 6 du socle : alerter sur la duree,
# pas sur l'evenement). Revu le 2026-08-26, apres avoir mesure sur DJ que le
# deploiement part a CHAQUE Stop : annoncer chaque succes aurait ajoute une
# ligne de contexte a chaque message de la session, pour une information que
# personne n'attend. Donc :
#   echec      -> annonce, une seule fois par verdict
#   en cours   -> annonce a chaque message tant que ca tourne (info vivante)
#   succes     -> SILENCE, sauf si le verdict precedent etait un echec, auquel
#                 cas une seule ligne de retablissement
# Un hook bavard a vide coute du contexte a chaque message ; un hook muet sur un
# echec ne sert a rien. Ces trois regles sont le seul reglage entre les deux.
#
# DEUX CONTRATS DE FICHIER D'ETAT, tous deux acceptes en LECTURE :
#   {"state":"done|failed|aborted|running","at":...,"reason":...}   kit, keep
#   {"ok":true|false,"at":...,"since":...,"reason":...}             DJ
# DJ ecrit `ok` depuis l'origine et son veilleur (scripts/deploy_watch.py, cron
# toutes les 15 min) lit `since` dans ce meme fichier. Reecrire le contrat pour
# faire joli aurait touche un script de mise en production ; lire les deux ne
# touche rien. Un nouveau projet ecrit `state`.

set -uo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
STATUS_FILE="${PROJECT_DIR}/.claude/deploy_status.json"
SEEN_FILE="${PROJECT_DIR}/.claude/.deploy_reported"

[ -f "$STATUS_FILE" ] || exit 0

STATUS=$(cat "$STATUS_FILE" 2>/dev/null) || exit 0
AT=$(printf '%s' "$STATUS"     | grep -oP '"at"\s*:\s*"\K[^"]*'     || true)
STATE=$(printf '%s' "$STATUS"  | grep -oP '"state"\s*:\s*"\K[^"]*'  || true)
REASON=$(printf '%s' "$STATUS" | grep -oP '"reason"\s*:\s*"\K[^"]*' || true)
SINCE=$(printf '%s' "$STATUS"  | grep -oP '"since"\s*:\s*"\K[^"]*'  || true)

# Contrat DJ : pas de champ `state`, un booleen `ok`. Traduit vers le vocabulaire
# du kit pour que la suite du script n'ait qu'un seul cas a traiter.
if [ -z "$STATE" ]; then
  case "$STATUS" in
    *'"ok":true'*|*'"ok": true'*)   STATE="done" ;;
    *'"ok":false'*|*'"ok": false'*) STATE="failed" ;;
  esac
fi

# Un deploiement en cours est une information vivante, pas un verdict : elle
# echappe a la deduplication, parce que la seule chose qui compte est qu'elle
# soit vraie au moment ou on la lit.
if [ "$STATE" = "running" ]; then
    echo "[deploiement auto] En cours depuis $AT. La prod sert encore l'ancien code."
    exit 0
fi

[ -n "$AT" ] || exit 0

# Le marqueur garde DEUX choses : l'horodatage deja annonce, et l'etat annonce.
# L'etat est ce qui permet de dire un mot de retablissement : sans lui, on ne
# saurait pas qu'on sort d'une serie rouge, et le retour au vert passerait
# inapercu comme le reste des succes.
VU_AT=""; VU_STATE=""
if [ -r "$SEEN_FILE" ]; then
  VU_AT=$(sed -n '1p' "$SEEN_FILE" 2>/dev/null)
  VU_STATE=$(sed -n '2p' "$SEEN_FILE" 2>/dev/null)
fi
[ "$VU_AT" = "$AT" ] && exit 0

case "$STATE" in
  done)
    # Silence, sauf retablissement. On n'ecrit le marqueur qu'ici aussi : sans
    # ca, un succes non annonce ne serait jamais enregistre et le premier succes
    # apres un echec serait annonce plusieurs fois.
    printf '%s\ndone\n' "$AT" > "$SEEN_FILE"
    if [ "$VU_STATE" = "failed" ] || [ "$VU_STATE" = "aborted" ]; then
      echo "[deploiement auto] Retabli a $AT. La prod sert de nouveau le code courant."
    fi
    ;;
  failed|aborted)
    printf '%s\nfailed\n' "$AT" > "$SEEN_FILE"
    echo "[deploiement auto] ECHEC a $AT : la prod n'a PAS ete mise a jour."
    [ -n "$REASON" ] && echo "[deploiement auto] Raison : $REASON"
    # `since` porte l'instant du PREMIER echec de la serie. Sans lui, un blocage
    # de trois heures ressemble indefiniment a un blocage tout neuf.
    if [ -n "$SINCE" ] && [ "$SINCE" != "$AT" ]; then
      echo "[deploiement auto] Rouge sans interruption depuis $SINCE."
    fi
    echo "[deploiement auto] Le dire a l'utilisateur au lieu de conclure que c'est en ligne. Journal : .claude/deploy.log"
    ;;
esac

exit 0
