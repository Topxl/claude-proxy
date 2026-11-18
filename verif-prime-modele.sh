#!/usr/bin/env bash
# Mise en service de Prime en Opus effort auto (= medium, defaut du modele) (VJ, 2026-10-04).
# Attend 3 vrais tours Prime apres la relance de 18:21 et depose dans le QG
# leur modele, leur effort et leur cout.
set -uo pipefail
# Proxy et pont relances au calme a 18:21 (11:21 UTC) : on compte a partir de la.
# Le pont a pris `opus-medium-toolrelay`, identique a Auto (medium est le defaut d'Opus).
DEBUT=2026-10-04T11:21:27

# Les 3 premiers vrais tours Prime, 24 h au plus.
for _ in $(seq 1 1440); do
  N=$(python3 -c "
import json,os,sys
n=0
for l in open(os.path.expanduser('~/.hermes/proxy-usage.jsonl')):
    if '\"prime\"' in l:
        o=json.loads(l); n+= o.get('source')=='prime' and o['ts']>='$DEBUT'
print(n)")
  [ "$N" -ge 3 ] && break
  sleep 60
done

BILAN=$(python3 - "$DEBUT" <<'PY'
import json, os, sys
G = {"opus": (5, 25, 6.25, .5), "sonnet": (3, 15, 3.75, .3), "haiku": (1, 5, 1.25, .1)}
L = [json.loads(l) for l in open(os.path.expanduser("~/.hermes/proxy-usage.jsonl"))]
L = [o for o in L if o.get("source") == "prime" and o["ts"] >= sys.argv[1]]
usd = lambda o: sum(a * b for a, b in zip((o["entree"], o["sortie"], o["cache_ecrit"], o["cache_lu"]),
                                          G.get(o.get("modele") or "opus", G["opus"]))) / 1e6
reglages = sorted({f'{o.get("modele")} effort {o.get("effort") or "auto"}' for o in L})
lignes = [f"{len(L)} tours Prime depuis la relance : {', '.join(reglages) or 'aucun'}."]
for nom, ts in (("repris", [o for o in L if o.get("reprise")]), ("neuf", [o for o in L if not o.get("reprise")])):
    if ts:
        lignes.append(f"Tour {nom} : {sum(map(usd, ts)) / len(ts):.2f} $ en moyenne sur {len(ts)}.")
lignes.append("Repère avant la relance : 0,17 $ repris, 0,79 $ neuf.")
ok = L and all(o.get("modele") == "opus" for o in L if "haiku" not in str(o.get("modele")))
lignes.append("OK : tout en Opus." if ok else "A VOIR : un tour sort d'Opus.")
print("\n".join(lignes))
PY
)
echo "$BILAN"
qg-attente add "Prime en Opus : vérifié sur tes tours" --source prime-modele --resume "$BILAN"
