#!/usr/bin/env python3
"""UserPromptSubmit : détecte les signaux de blocage (erreurs en série,
interruptions, frustration, demandes répétées) et injecte une directive de
prise de hauteur. Cooldown 20 min pour ne pas harceler."""

import json
import os
import re
import sys
import time

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(0)

prompt = data.get("prompt", "") or ""
session = data.get("session_id", "nosession")
tpath = data.get("transcript_path", "")

FRUSTRATION = re.compile(
    r"(toujours pas|marche (toujours )?pas|ça ne marche|encore (pareil|cassé|le même)"
    r"|même (erreur|problème|bug)|rien ne marche|tourne[sz]? en rond|n'importe quoi"
    r"|c'est (toujours )?pas ça|tu (recommences|refais)|on avait dit|je t'ai (déjà )?dit"
    r"|pour la (2|3|deuxième|troisième)e? fois|still (not|broken)|arrête)",
    re.I,
)

# --- cooldown ---
# noqa ciblé : S108 vise l'écriture de DONNÉES dans un /tmp prévisible. Ici le
# fichier ne porte qu'un horodatage de cooldown, ni valeur ni secret.
state = f"/tmp/claude_stuck_{session[:12]}"  # noqa: S108
now = time.time()
try:
    if now - os.path.getmtime(state) < 1200:
        sys.exit(0)
except OSError:
    pass

# --- fenêtre récente du transcript (dernier ~400 Ko) ---
n_err = n_int = n_user = 0
recent_user: list[str] = []
if tpath and os.path.exists(tpath):
    try:
        size = os.path.getsize(tpath)
        with open(tpath, "rb") as f:
            f.seek(max(0, size - 400_000))
            tail = f.read().decode("utf-8", errors="replace").splitlines()
        err_rx = re.compile(r'"is_error"\s*:\s*true')
        for line in tail:
            if err_rx.search(line):
                n_err += 1
            if "[Request interrupted by user" in line:
                n_int += 1
            if '"type":"user"' in line:
                try:
                    rec = json.loads(line)
                    c = (rec.get("message") or {}).get("content")
                    if isinstance(c, str) and len(c) > 5:
                        n_user += 1
                        recent_user.append(c[:300])
                except Exception:  # noqa: S110
                    # Une ligne de transcript illisible ne doit jamais empêcher un
                    # message de partir : le hook se tait et continue.
                    pass
    except Exception:  # noqa: S110
        pass

# --- score ---
frustre = bool(FRUSTRATION.search(prompt))
norm = re.sub(r"\s+", " ", prompt.lower().strip())[:120]
repete = (
    any(norm and norm in re.sub(r"\s+", " ", u.lower()) for u in recent_user[-8:-1])
    and len(norm) > 25
)
score = (
    (2 if frustre else 0)
    + (2 if n_err >= 6 else 1 if n_err >= 3 else 0)
    + (2 if n_int >= 2 else 0)
    + (2 if repete else 0)
)

if score < 3:
    sys.exit(0)

open(state, "w").close()
sig = []
if frustre:
    sig.append("frustration exprimée")
if n_err >= 3:
    sig.append(f"{n_err} erreurs d'outils récentes")
if n_int >= 2:
    sig.append(f"{n_int} interruptions utilisateur")
if repete:
    sig.append("demande déjà formulée quasi à l'identique")

print(f"""🧭 DÉTECTEUR DE BLOCAGE (hook, signaux : {", ".join(sig)}).
La session patine : NE PAS repartir tête baissée dans la même direction.
Avant de traiter ce message, fais une prise de hauteur VISIBLE et courte :
1. Reformule en UNE phrase l'objectif initial de la session (pas la dernière rustine).
2. Liste en 2-3 lignes ce qui a été tenté et POURQUOI ça n'a pas marché (fait, pas hypothèse).
3. Propose UN pas de côté concret : approche différente, périmètre réduit,
   retour au dernier état qui marchait, ou reporter et avancer sur l'essentiel.
4. Demande à l'utilisateur de valider ce réalignement avant d'exécuter.
Interdit : relancer une 3e fois la même approche à l'identique.""")
sys.exit(0)
