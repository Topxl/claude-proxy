#!/usr/bin/env python3
"""Ban the em dash and the en dash from every tracked file.

Only the keyboard hyphen is allowed. `--check` reports without writing, which is
what the pre-flight script calls; without it, the files are rewritten.

The substitution is not a blind character swap: an em dash that introduced an
explanation becomes a colon, one that joined two numbers becomes a hyphen, and
one used as a bullet becomes a middle dot. What matters is that the sentence
still reads correctly afterwards.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
from pathlib import Path

# Écrits en échappement, pas en littéral : le fichier qui bannit ces caractères
# serait sinon le seul à en contenir, et son propre contrôle le signalerait.
EM = "\u2014"  # tiret cadratin
EN = "\u2013"  # tiret demi-cadratin

# Les entit\u00e9s HTML comptent autant que les caract\u00e8res : celle du cadratin
# s'affiche comme un tiret dans un navigateur et dans un client mail. Ne
# chercher que les caract\u00e8res laissait passer treize occurrences, dont une dans
# le pied de page de chaque email envoy\u00e9.
ENTITES = r"&(?:mdash|ndash|#8212|#8211|#x2014|#x2013|#X2014|#X2013);"
BANNED = re.compile(f"[{EM}{EN}]|{ENTITES}")

# Extensions worth rewriting. Anything else (images, fonts, corpora) is skipped
# even when it happens to contain the bytes.
TEXT_SUFFIXES = {
    ".py",
    ".md",
    ".html",
    ".sh",
    ".yml",
    ".yaml",
    ".json",
    ".txt",
    ".toml",
    ".ini",
    ".cfg",
    ".css",
    ".js",
    ".tsv",
    ".csv",
    ".webmanifest",
    ".example",
    ".pi",
    ".worker",
    ".gitignore",
    ".sql",
    ".xml",
}
EXTRA_NAMES = {"Dockerfile.pi", "Dockerfile.worker.pi", ".gitignore", ".env.example"}


def _rewrite(text: str) -> str:
    """Swap both dashes for the keyboard hyphen, and nothing else.

    A first version guessed at punctuation: a colon when the clause explained,
    a bullet at the start of a line. On 874 occurrences it produced real
    contresens ("SMTP is not configured : cannot deliver") and turned asides
    into lists. A hyphen never changes what a sentence means. Where a colon or
    a comma genuinely reads better, that is a human edit, made on the files a
    visitor actually sees.
    """
    # Between two digits it is a range: 60-75 keeps no surrounding spaces.
    text = re.sub(rf"(?<=\d)\s*(?:[{EM}{EN}]|{ENTITES})\s*(?=\d)", "-", text)
    return BANNED.sub("-", text)


def _dans_perimetre(name: str, prefixe: str) -> bool:
    return name == prefixe or name.startswith(prefixe.rstrip("/") + "/")


def _tracked_files(root: Path, scope: list[str] | None = None) -> list[Path]:
    # Chemin résolu plutôt que « git » nu, que ruff refuse (S607). Le seul gain
    # est l'erreur explicite ci-dessous quand git manque : shutil.which lit le
    # même PATH que subprocess, il ne sécurise rien de plus. S603 se déclenche
    # parce que l'argument est devenu une variable ; la ligne de commande est
    # écrite entièrement ici, rien n'y entre du dehors.
    git = shutil.which("git")
    if git is None:
        raise RuntimeError("git est introuvable dans le PATH")
    out = subprocess.run(  # noqa: S603
        [git, "ls-files", "-z"], cwd=root, capture_output=True, text=True, check=True
    )
    files = []
    for name in out.stdout.split("\0"):
        if not name:
            continue
        if scope and not any(_dans_perimetre(name, p) for p in scope):
            continue
        path = root / name
        if path.suffix in TEXT_SUFFIXES or path.name in EXTRA_NAMES:
            files.append(path)
    return files


def main() -> int:
    """Sans argument de chemin : tout le suivi. Avec : ce périmètre seulement.

    Le périmètre existe pour les dépôts CLONÉS d'un amont tiers. Mesuré le
    2026-08-26 en portant le socle : `autodan-turbo` (clone d'un dépôt
    académique) porte 11 932 tirets longs et `claude-code-best-practice` 2 440,
    tous écrits en amont. Les réécrire mettrait le dépôt en conflit à chaque
    `git pull`, pour une typographie dont nous ne sommes pas l'auteur, et le
    contrôle passerait sa vie au rouge : un filet qu'on n'ose plus lancer ne
    protège plus rien. La règle des tirets vaut pour ce que NOUS écrivons ;
    sur un clone, `check.sh` passe donc la liste des chemins qui sont à nous,
    et son en-tête dit lesquels et pourquoi.
    """
    check_only = "--check" in sys.argv
    scope = [a for a in sys.argv[1:] if not a.startswith("-")]
    root = Path(__file__).resolve().parent.parent

    fichiers = _tracked_files(root, scope)

    # Un périmètre qui ne désigne rien doit ÉCHOUER, jamais sortir vert : un
    # chemin renommé ferait taire le contrôle en silence, et « aucun tiret
    # long » se lirait comme une protection alors que rien n'a été lu. C'est
    # le même mensonge que le venv absent qui laisse le lint passer.
    if scope:
        suivis = subprocess.run(  # noqa: S603
            [shutil.which("git") or "git", "ls-files", "-z"],
            cwd=root,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.split("\0")
        for p in scope:
            if not any(n and _dans_perimetre(n, p) for n in suivis):
                print(f"Périmètre « {p} » : aucun fichier suivi par git ne correspond.")
                print("  Le contrôle ne porterait sur rien et se lirait pourtant comme vert.")
                print("  Remède : corriger le chemin dans scripts/check.sh, ou le retirer.")
                return 2

    touched, total = [], 0
    for path in fichiers:
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, FileNotFoundError):
            continue
        count = len(BANNED.findall(text))
        if not count:
            continue
        total += count
        touched.append((path.relative_to(root), count))
        if not check_only:
            path.write_text(_rewrite(text), encoding="utf-8")

    # Le périmètre s'affiche TOUJOURS quand il est restreint, y compris au vert :
    # un contrôle qui ne dit pas sur quoi il a porté se lit comme s'il avait tout vu.
    ou = f" dans {', '.join(scope)}" if scope else ""

    if not touched:
        print(f"Aucun tiret long{ou}. C'est ce qu'on veut.")
        return 0

    for rel, count in sorted(touched, key=lambda t: -t[1])[:20]:
        print(f"  {count:4d}  {rel}")
    if len(touched) > 20:
        print(f"  ... et {len(touched) - 20} autre(s) fichier(s)")
    verb = "trouvé" if check_only else "remplacé"
    print(f"\n{total} tiret(s) long(s) {verb} dans {len(touched)} fichier(s){ou}.")
    return 1 if check_only else 0


if __name__ == "__main__":
    raise SystemExit(main())
