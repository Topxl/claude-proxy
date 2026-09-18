#!/usr/bin/env python3
"""PreToolUse : bloque les commandes qui peuvent couper la prod ou fuiter un secret.

Un hook n'est pas une redite de CLAUDE.md. Ce qui est écrit dans un document
n'est lu que si le document est chargé, et au bon moment ; ce qui est ici est
appliqué, toujours, même dans une session qui n'a jamais ouvert le CLAUDE.md.
D'où le choix de ce qui s'y trouve : uniquement des gestes dont le coût est
immédiat et irréversible (fuite de code, coupure de service, perte de données),
jamais du style ni de la convention.

Exit 2 + message sur stderr = l'appel est bloqué, et Claude lit le message.
Chaque message porte le remède, pas seulement l'interdit : un garde-fou qui dit
« non » sans dire « fais plutôt ceci » se fait contourner.

Socle de départ, repris tel quel de DJ et de passreal. Ce qui suit est ce qui
vaut pour n'importe quel projet. Tout ce qui est propre à CELUI-CI (adresse de
prod, nom d'unité systemd, pile docker, migrations) s'ajoute dans le bloc
« Règles propres au projet », avec sa date et son incident.
"""

import json
import re
import sys

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)

tool = data.get("tool_name", "")
inp = data.get("tool_input", {}) or {}


def deny(msg: str) -> None:
    print(msg, file=sys.stderr)
    sys.exit(2)


if tool != "Bash":
    sys.exit(0)

cmd = inp.get("command", "")

# Les scripts canoniques ont le droit de faire ce qu'ils font : ils portent
# déjà les garde-fous (santé, retour arrière, transfert ciblé).
if re.search(r"scripts/(deploy|check_prod_parity|check)[a-z_]*\.sh", cmd):
    sys.exit(0)

# ── pkill ────────────────────────────────────────────────────────────────────
# 79 incidents mesurés sur DJ : la commande s'auto-tue, ou tue le Chrome de
# Playwright que la session était en train de piloter.
if re.search(r"\bpkill\b", cmd):
    deny(
        "pkill interdit (79 incidents : s'auto-tue, ou tue le Chrome de "
        "Playwright). Viser un PID explicite : lsof -i:PORT puis kill <pid>, "
        "ou TaskStop pour une tâche du harnais."
    )

# ── Secrets en clair dans une commande ───────────────────────────────────────
# Une clé écrite dans une commande finit dans l'historique du shell, dans les
# journaux du harnais et dans le transcript de la session. La révoquer devient
# alors la seule issue.
if re.search(r"\b(sk_live_|rk_live_|whsec_|ghp_|xoxb-)[0-9A-Za-z]{10,}", cmd):
    deny(
        "Une clé secrète est écrite en clair dans cette commande : elle serait "
        "conservée dans l'historique et le transcript, et il faudrait la "
        "révoquer. La lire depuis l'environnement : source .env puis utiliser "
        '"$MA_CLE" dans la commande.'
    )

# ── Effacements catastrophiques ─────────────────────────────────────────────
# Remplace la règle `ask` sur « rm * », retirée du settings.json le 2026-08-07.
# Une règle `ask` interrompt à chaque fois, y compris pour effacer un fichier
# temporaire ; mesurée sur le projet DJ, elle a demandé confirmation 753 fois
# sans avoir jamais rien empêché. Un garde-fou qu'on accepte toujours entraîne
# à valider sans lire, ce qui le rend pire qu'inutile. Ici on ne vise que ce
# qu'un motif par préfixe ne sait pas exprimer : la racine, le home, une
# arborescence système, ou un chemin réduit à un seul niveau, signe habituel
# d'une variable vide en préfixe.
for _seg in re.split(r"&&|\|\||;|\n|\|", cmd):
    _seg = _seg.strip()
    _m = re.match(r"^(?:sudo\s+)?rm\s+(.*)$", _seg)
    if not _m:
        continue
    for _brut in [a for a in _m.group(1).split() if not a.startswith("-")]:
        _a = _brut.strip("\"'").rstrip("/")
        if _a in ("", "/", "~", "$HOME", "/home", "/home/vj", "/*", "~/*", "$HOME/*"):
            deny(
                f"« {_seg[:60]} » vise la racine ou tout le dossier personnel. "
                "Si l'intention est un dossier précis, l'écrire en entier ; si une "
                'variable est en jeu, la vérifier (vide, rm -rf "$D"/ part de la racine).'
            )
        if re.match(r"^/(usr|etc|var|bin|sbin|lib|lib64|boot|opt|srv|proc|sys|root)(/|$)", _a):
            deny(
                f"« {_seg[:60]} » efface dans une arborescence système ({_a}). "
                "Presque toujours une erreur de chemin ou une variable vide."
            )
        # noqa ciblé, jamais au niveau du projet : S108 signale l'ÉCRITURE dans
        # un /tmp prévisible. Ici la chaîne sert à reconnaître un dossier de
        # travail jetable pour le laisser passer, l'inverse d'un risque.
        if re.fullmatch(r"/[a-z][a-z0-9_-]*", _a) and not _a.startswith(("/tmp", "/dev")):  # noqa: S108
            deny(
                f"« {_seg[:60]} » efface un dossier de premier niveau ({_a}). "
                "Si une variable devait le préfixer, elle est vide."
            )

        # ── Variable non protégée en TÊTE de chemin ──────────────────────────
        # VARIABLE_NUE_EN_TETE. Posé dans le kit le 2026-08-27, après mesure :
        # « rm -rf "$D"/ » est le cas que methodes/socle-projet.md cite comme
        # CIBLE VISÉE de tout ce bloc, et il passait sur les 10 projets qui
        # portent la copie générique du kit. La règle existait dans DJ,
        # passreal, readcommons et keep depuis le 2026-08-26, mais n'était
        # jamais remontée ici : une correction posée dans les copies et pas
        # dans la source ne se propage pas, c'est le principe 14 pris en défaut.
        #
        # Le hook voit la commande AVANT substitution : « $D » n'est qu'un
        # texte, donc aucune liste de chemins ne peut le reconnaître.
        # On ne vise que la TÊTE du chemin, là où une variable vide fait
        # remonter l'effacement vers la racine. « rm -rf ./build/$NOM » passe :
        # une variable vide n'y élargit rien, et un garde-fou qui crie pour
        # rien apprend à être ignoré.
        _tete = re.match(r"^\$\{?([A-Za-z_][A-Za-z0-9_]*)", _a)
        if _tete and _tete.group(1) not in ("HOME", "PWD", "TMPDIR", "CLAUDE_PROJECT_DIR"):
            if not re.match(r"^\$\{[A-Za-z_][A-Za-z0-9_]*:[?+-]", _a):
                deny(
                    f"« {_seg[:60]} » commence son chemin par une variable non "
                    f"protégée ({_brut}). Si elle est vide, rm remonte à la racine.\n"
                    "  Remède : écrire ${VAR:?} au lieu de $VAR. bash refuse alors "
                    "de lancer la commande quand la variable est vide ou absente, "
                    "au lieu d'effacer depuis /."
                )

# ── Chaîne de dépendances npm ────────────────────────────────────────────────
# Un `npm install` exécute les scripts preinstall/install/postinstall de TOUTE
# la fermeture transitive, sans que le paquet soit jamais importé dans le code.
# C'est le vecteur des compromissions d'août 2026 (chalk, debug, puis la vague
# via les dépendances profondes d'ESLint) : voler des clés AWS, des jetons
# GitHub, des portefeuilles crypto. La machine y est exposée dès l'installation.
# pnpm, configuré par pnpm-workspace.yaml, impose un délai avant d'accepter une
# version fraîche et refuse par défaut les scripts d'installation non approuvés.
# Le blocage vit ici et pas dans le CLAUDE.md : c'est un geste au coût
# irréversible, et il doit tenir même dans une session qui n'a rien lu.
_GEST = r"(?:install|i|add|ci|update|up|upgrade|exec|create)"
for _seg in re.split(r"&&|\|\||;|\n|\|", cmd):
    _seg = _seg.strip()
    # Amorçage : poser pnpm ou le pare-feu Socket passe forcément par npm -g,
    # et la version y est épinglée. C'est la seule porte laissée ouverte.
    if re.search(r"npm\s+(?:install|i)\s+-g\s+(?:pnpm@[0-9]|sfw\b)", _seg):
        continue
    # Le préfixe sfw (pare-feu Socket) ne rend pas npm acceptable : il ajoute
    # une couche, il ne pose ni délai de publication ni blocage des scripts.
    if re.match(rf"^(?:sudo\s+)?(?:sfw\s+)?(?:npm|yarn|bun)\s+{_GEST}\b", _seg):
        deny(
            f"« {_seg[:60]} » : npm/yarn installe sans délai et exécute les "
            "scripts d'installation de toutes les dépendances transitives "
            "(vecteur des paquets compromis d'août 2026). Ce projet passe par "
            "pnpm, qui porte les garde-fous de pnpm-workspace.yaml.\n"
            "  Remède : pnpm add <paquet>   ·   pnpm install --frozen-lockfile\n"
            "  Si sfw est là, le préfixer : sfw pnpm add <paquet>.\n"
            "  Seule exception légitime : npm install -g pnpm@<version>."
        )
    # npx sans --no-install télécharge puis exécute un paquet arbitraire : même
    # risque qu'une installation, en plus discret car il ne laisse pas de trace
    # dans package.json.
    if re.match(r"^(?:sudo\s+)?npx\b", _seg) and "--no-install" not in _seg:
        deny(
            f"« {_seg[:60]} » : npx télécharge et exécute un paquet arbitraire, "
            "hors du fichier lock et sans délai de publication.\n"
            "  Remède : npx --no-install <outil> si l'outil est déjà une "
            "dépendance du projet, sinon pnpm dlx <outil>, qui respecte "
            "pnpm-workspace.yaml."
        )

# ── Règles propres au projet ─────────────────────────────────────────────────
# À remplir dès que la prod existe. Modèles éprouvés, à adapter puis décommenter :
#
#   systemctl restart/stop d'un service de production
#       -> remède : la bascule bleu-vert de scripts/deploy_*.sh
#   docker compose down sur la machine de prod
#       -> coupe aussi le tunnel, donc le site entier ; restart <service> suffit
#   docker compose sans -f <fichier de prod> sur la machine de prod
#       -> applique la pile de développement, ports exposés, pas de durcissement
#   alembic downgrade en prod
#       -> détruit des colonnes ; faire un dump puis décider
#   rsync --delete vers la prod
#       -> la prod porte des fichiers que le poste n'a pas (.env, volumes)
#   une ancienne adresse IP de serveur, réattribuée depuis
#       -> y envoyer quoi que ce soit livre le code à un tiers
#   lancer le serveur à la main / npm run dev sur un port déjà pris
#       -> 411 relances mesurées, et on teste un VIEUX build sans le savoir
#
# Chaque règle ajoutée porte sa DATE et son INCIDENT. Rien pour le style.

# 2026-08-27 : suicide collectif des sous-agents.
# Incident : quatre sous-agents lances en parallele sur le projet keep sont
# morts trois fois de suite en pleine tache, perdant des heures de travail.
# Cause : les sous-agents `claude` sont des enfants de claude-proxy.service.
# Un agent qui redemarre ce service (ou hermes-gateway, qui l'entraine) tue
# donc tous ses confreres ET lui-meme. Deux sauvegardes d'unite datees du jour
# le prouvent : .bak-autocompact et .bak-cache-ttl.
# Remede : editer l'unite, puis demander a VJ de la recharger, ou passer par
# scripts/redemarrer-au-calme.sh qui attend la fin des tours.
_SERVICES_VITAUX = ("claude-proxy", "hermes-gateway")
if re.search(r"\bsystemctl\b", cmd) and re.search(
    r"\b(restart|stop|kill|reload-or-restart|try-restart)\b", cmd
):
    # Les instances distantes (claude-proxy-marwell sur le Pi) n'hebergent
    # aucun sous-agent de cette machine : elles ne sont pas vitales ici.
    for _svc in _SERVICES_VITAUX:
        if re.search(re.escape(_svc) + r"(?!-marwell)", cmd):
            deny(
                f"« {_svc} » heberge les sous-agents en cours : le redemarrer "
                "les tue tous, y compris celui qui lance la commande. "
                "Incident du 2026-08-27, trois series d'agents perdues. "
                "Edite l'unite si tu veux, mais laisse VJ la recharger."
            )


sys.exit(0)
