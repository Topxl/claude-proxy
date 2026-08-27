#!/usr/bin/env bash
# Vérification complète du dépôt, en local.
# ==========================================
#
# Pose depuis ~/Bureau/Projets/contexte/methodes/kit-garde-fous/scripts/check.sh.
# Les etapes se taillent au projet ; la structure ne se reinvente pas.
#
# C'est LE filet du projet, et le seul. Il se lance À LA MAIN, avant toute
# livraison et avant tout déploiement. Aucun hook git ne le cache.
#
# PROTECTION RÉELLE DE CE DÉPÔT (à tenir à jour, ne jamais décrire une
# protection qui n'existe pas) :
#   remote git  : aucun pour l'instant (dépôt local). Tant qu'il n'y a pas de push, ce script est la seule protection.
#   CI          : aucune pour l'instant. Le jour où il y en a une, elle lance
#                 EXACTEMENT ce script, sinon « vert en local » et « vert en
#                 CI » cessent de vouloir dire la même chose.
#
# Usage :
#   scripts/check.sh            tout (défaut)
#   scripts/check.sh --fast     sans réseau, c'est ce que le déploiement lance
#   scripts/check.sh py         Python seulement
#   scripts/check.sh web        front seulement
#   scripts/check.sh sec        sécurité seulement
#   scripts/check.sh --strict   les avertissements deviennent bloquants
#
# Codes de sortie : 0 vert, 1 rouge, 2 une autre vérification tourne.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

# ── Un seul check à la fois, toutes sessions confondues ──────────────────────
# Plusieurs sessions Claude Code peuvent travailler sur le dépôt en parallèle.
# Deux suites de tests simultanées ne vont pas deux fois plus vite : elles se
# volent la machine. On ATTEND plutôt que de refuser, parce qu'une session qui
# vérifie veut son résultat, pas une erreur.
#
#   CHECK_NOWAIT=1   rend la main tout de suite si un check tourne (code 2)
#   CHECK_WAIT=1800  plafond d'attente en secondes (défaut 30 min)
# Le nom du verrou vient du dossier : rien a renommer en posant ce fichier.
PROJET="$(basename "$PWD")"
LOCK="${TMPDIR:-/tmp}/${PROJET}_check.lock"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK" 2>/dev/null
  if ! flock -n 9; then
    depuis=""
    [ -r "$LOCK.pid" ] && depuis=$(ps -o etime= -p "$(cat "$LOCK.pid")" 2>/dev/null | tr -d ' ')
    printf '\033[1m-> Une vérification tourne déjà%s\033[0m\n' "${depuis:+ (depuis $depuis)}"
    if [ "${CHECK_NOWAIT:-0}" = "1" ]; then
      printf '  Rien lancé : la lancer en double la rendrait plus lente, pas plus sûre.\n'
      exit 2
    fi
    printf '  J'\''attends qu'\''elle finisse plutôt que d'\''en lancer une deuxième.\n\n'
    if ! flock -w "${CHECK_WAIT:-1800}" 9; then
      printf '\033[31mx Toujours occupée après %s s.\033[0m Relancer plus tard.\n' "${CHECK_WAIT:-1800}"
      exit 2
    fi
  fi
  echo $$ >"$LOCK.pid" 2>/dev/null
  trap 'rm -f "$LOCK.pid" 2>/dev/null' EXIT
fi

CIBLE="all"
STRICT=0
for arg in "$@"; do
  case "$arg" in
    --strict) STRICT=1 ;;
    *)        CIBLE="$arg" ;;
  esac
done

ROUGE=$'\033[31m'; VERT=$'\033[32m'; JAUNE=$'\033[33m'; GRAS=$'\033[1m'; RAZ=$'\033[0m'
ECHECS=0

# Ne s'arrête PAS au premier échec : on veut la liste complète en un passage.
etape() {   # etape "libellé" commande...
  local titre="$1"; shift
  printf '%s-> %s%s\n' "$GRAS" "$titre" "$RAZ"
  if "$@"; then
    printf '  %sok%s\n\n' "$VERT" "$RAZ"
  else
    printf '  %sÉCHEC%s\n\n' "$ROUGE" "$RAZ"
    ECHECS=$((ECHECS + 1))
  fi
}

avertir() {  # comme etape, mais un échec n'invalide pas la livraison
  local titre="$1"; shift
  printf '%s-> %s%s\n' "$GRAS" "$titre" "$RAZ"
  if "$@"; then
    printf '  %sok%s\n\n' "$VERT" "$RAZ"
  elif [ "$STRICT" = "1" ]; then
    printf '  %sÉCHEC (--strict)%s\n\n' "$ROUGE" "$RAZ"
    ECHECS=$((ECHECS + 1))
  else
    printf '  %sà regarder, non bloquant%s\n\n' "$JAUNE" "$RAZ"
  fi
}

# ── Python ───────────────────────────────────────────────────────────────────
PY=".venv/bin/python"
[ -x "$PY" ] || PY="python3"   # repli ; le venv porte les dépendances du projet

# Python de VALIDATION SYNTAXIQUE = celui de la PRODUCTION, pas celui du poste.
# Un venv récent laisserait passer une syntaxe que l'image de prod refuse, et on
# ne s'en apercevrait qu'au health-check, après le déploiement.
# Renseigner PY_PROD_VERSION dès que la version de la prod est connue.
PY_PROD_VERSION="${PY_PROD_VERSION:-3.11}"
PY_CHECK=""
for _c in "$(command -v "python$PY_PROD_VERSION" 2>/dev/null)" \
          "/usr/bin/python$PY_PROD_VERSION" \
          "$HOME"/.local/share/uv/python/cpython-"$PY_PROD_VERSION"*/bin/"python$PY_PROD_VERSION"; do
  if [ -n "$_c" ] && [ -x "$_c" ]; then PY_CHECK="$_c"; break; fi
done

if [ "$CIBLE" = "all" ] || [ "$CIBLE" = "py" ] || [ "$CIBLE" = "--fast" ]; then
  # Lint d'abord : un import mort se voit en 2 s, inutile de payer la suite.
  # Le jeu de règles est dans pyproject.toml. Une règle ne passe en `ignore`
  # que pour une raison écrite : taire du bruit aveugle le linter, et c'est
  # comme ça que 22 vrais noms non définis sont partis en prod sur DJ.
  # Un outil absent n'est pas un contrôle vert : ce serait exactement le
  # mensonge qu'on répare. Il compte pour un échec, et le message porte le remède.
  outil_absent() { ! "$PY" -m "$1" --version >/dev/null 2>&1; }
  manque() {
    printf '%s-> %s : outil absent%s\n' "$GRAS" "$1" "$RAZ"
    printf '  Remède : python3 -m venv .venv && .venv/bin/pip install ruff pytest\n\n'
    ECHECS=$((ECHECS + 1))
  }

  if outil_absent ruff; then
    manque "Lint et format Python (ruff)"
  else
    etape "Lint Python (ruff)"   "$PY" -m ruff check .
    etape "Format Python (ruff)" "$PY" -m ruff format --check .
  fi

  if [ -n "$PY_CHECK" ]; then
    etape "Syntaxe à la version de la prod ($("$PY_CHECK" -V 2>&1))" \
          "$PY_CHECK" -m compileall -q "${PKG_PROD:-.}"
  else
    printf '%s-> Syntaxe prod ignorée%s : aucun python%s sur le poste.\n\n' \
           "$GRAS" "$RAZ" "$PY_PROD_VERSION"
  fi

  # Les dépendances implicites se disent AVANT, sinon un service éteint se lit
  # comme une régression. Modèle, à décommenter le jour où Redis entre en jeu :
  # if ! (exec 3<>/dev/tcp/127.0.0.1/6379) 2>/dev/null; then
  #   printf '%s-> Redis absent%s : N tests vont échouer, ce n'\''est pas une régression.\n\n' "$GRAS" "$RAZ"
  # fi

  # tests/regression/ est exclu à dessein : il exige des fixtures générées et
  # se lance à part (scripts/check.sh reg). Les tests marqués `slow` sortent du
  # passage rapide : un filet qu'on n'ose plus lancer ne protège plus rien.
  # pytest sort 5 quand il ne collecte RIEN. Une suite vide n'est pas une suite
  # verte : c'est le défaut de --passWithNoTests, qu'on refuse ici aussi.
  tests_courants() {
    "$PY" -m pytest tests/unit tests/integration -q -m "not slow"
    local code=$?
    if [ "$code" = "5" ]; then
      echo "  Aucun test collecté. Le filet ne protège rien tant qu'il est vide :"
      echo "  écrire le premier test dans tests/unit/."
      return 1
    fi
    return "$code"
  }
  if outil_absent pytest; then
    manque "Tests"
  else
    etape "Tests (unit + integration)" tests_courants
  fi
fi

if [ "$CIBLE" = "reg" ]; then
  etape "Tests de régression" "$PY" -m pytest tests/regression -q
fi

if [ "$CIBLE" = "slow" ]; then
  etape "Tests lents" "$PY" -m pytest tests -q -m slow
fi
# ── Front ────────────────────────────────────────────────────────────────────
if [ "$CIBLE" = "all" ] || [ "$CIBLE" = "web" ] || [ "$CIBLE" = "--fast" ]; then
  if [ -d node_modules ]; then
    # Pas de --max-warnings arbitraire : le cliquet se met en place le jour où
    # la dette existe, en figeant une baseline, pas en inventant un seuil.
    etape "Lint front (ESLint)"  npx --no-install eslint .
    etape "Typecheck TypeScript" npx --no-install tsc --noEmit
    # Jamais --passWithNoTests : il fait passer une suite vide en silence.
    etape "Tests front (vitest)" npx --no-install vitest run
  else
    printf '%s-> Front ignoré%s : node_modules absent (pnpm install --frozen-lockfile).\n\n' "$GRAS" "$RAZ"
  fi

  # ── Chaîne de dépendances ──────────────────────────────────────────────
  # Le fichier lock est la seule chose qui rend une installation reproductible :
  # il fige aussi les dépendances TRANSITIVES, celles qu'on n'a jamais choisies
  # et par où sont passées les compromissions d'août 2026. Il se commite.
  if [ -f pnpm-lock.yaml ]; then
    # --frozen-lockfile refuse de MODIFIER le lock : si package.json a bougé
    # sans que le lock suive, ça échoue au lieu de résoudre en silence.
    etape "Lock gelé (pnpm)" pnpm install --frozen-lockfile --dry-run
    # Un audit n'est pas un antivirus : il ne voit que les failles DÉJÀ
    # publiées, jamais un paquet compromis ce matin. C'est le délai de
    # publication de pnpm-workspace.yaml qui couvre ce trou, pas cette étape.
    etape "Audit dépendances" pnpm audit --audit-level high
  elif [ -f package-lock.json ] || [ -f yarn.lock ]; then
    lock_etranger() {
      echo "  package-lock.json ou yarn.lock présent : ce projet est en pnpm."
      echo "  Deux locks qui coexistent, c'est deux arbres de dépendances possibles."
      echo "  Remède : supprimer le lock étranger, puis pnpm install."
      return 1
    }
    etape "Un seul gestionnaire" lock_etranger
  fi

  # Cliquet de dette design, quand il y a une UI : audit_ui.mjs + sa baseline,
  # échoue seulement si un compteur MONTE. Voir la section 6 du socle.
  if [ -f scripts/audit_ui.mjs ]; then
    etape "Cliquet design (audit_ui)" node scripts/audit_ui.mjs
  fi
fi
# ── Sécurité ─────────────────────────────────────────────────────────────────
# Instantané et hors réseau, donc présent même en --fast : c'est le contrôle
# qu'on regrette le plus d'avoir sauté.
if [ "$CIBLE" = "all" ] || [ "$CIBLE" = "sec" ] || [ "$CIBLE" = "--fast" ]; then
  secrets_propres() {
    if git grep -nIE '(sk_live_[0-9A-Za-z]{20,}|rk_live_[0-9A-Za-z]{20,}|whsec_[0-9A-Za-z]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)' \
         -- . ':!scripts/check.sh'; then
      echo "  Un secret est commité dans l'arbre de travail : le révoquer, le retirer, en régénérer un."
      return 1
    fi
    return 0
  }
  etape "Aucun secret commité" secrets_propres

  # Règle ferme de VJ : le tiret cadratin et le tiret demi-cadratin sont
  # interdits partout. Le remède est dans le message : le script sait corriger.
  if command -v python3 >/dev/null 2>&1 && [ -f scripts/no_long_dashes.py ]; then
    tirets_propres() {
      if ! python3 scripts/no_long_dashes.py --check; then
        echo "  Remède : python3 scripts/no_long_dashes.py"
        return 1
      fi
      return 0
    }
    etape "Aucun tiret long" tirets_propres
  fi
fi

if [ "$ECHECS" -eq 0 ]; then
  printf '%s%sTout est vert.%s\n' "$GRAS" "$VERT" "$RAZ"
  exit 0
fi
printf '%s%s%d étape(s) en échec.%s\n' "$GRAS" "$ROUGE" "$ECHECS" "$RAZ"
exit 1
