#!/usr/bin/env python3
"""Banc de la regle de delegation aux sous-agents (v1 contre v2).

Rejoue de vraies demandes de VJ a Hermes avec le meme prompt systeme et la
meme directive que le proxy, en changeant seulement la regle de delegation
(directive-delegation.js). Un juge Opus compare ensuite les 2 reponses a
l'aveugle (ordre tire au sort). Le bilan donne la qualite et le cout.

  banc-delegation.py rejouer [--limite N] [--paralleles 3] [--versions v1,v2]
  banc-delegation.py juger   [--paralleles 3]
  banc-delegation.py bilan

Dossier de travail : ~/.hermes/cache/scratch/banc (taches.json, resultats/).
Lecture seule : Write et Edit sont retires, la consigne interdit tout envoi.
Le banc appelle le CLI en direct : sa conso est dans resultats/*.json
(total_cost_usd, modelUsage) et dans banc-conso.jsonl.
"""
import argparse, json, os, random, re, sqlite3, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ICI = Path(__file__).resolve().parent.parent
BANC = Path(os.environ.get('BANC_DIR', Path.home() / '.hermes/cache/scratch/banc'))
RES = BANC / 'resultats'
MODELE = 'claude-opus-5-5'
EFFORT = 'medium'  # effort reel des topics (journal proxy, 2026-10-27)
OUTILS = 'Bash,Read,WebSearch,WebFetch,Agent,Skill,ToolSearch'
GARDE = ("\n\n(Banc de test : lecture seule. N'envoie, ne publie, ne modifie "
         "et ne lance rien qui change un etat. Si une action serait utile, "
         "dis ce que tu ferais.)")


def directive(version):
    js = (f"import('{ICI}/directive-delegation.js')"
          f".then(m=>process.stdout.write(m.directiveGroupage('{version}')))")
    return subprocess.run(['node', '-e', js], capture_output=True, text=True,
                          check=True).stdout


def prompt_systeme():
    db = sqlite3.connect(f'file:{Path.home()}/.hermes/state.db?mode=ro', uri=True)
    (p,) = db.execute('select prompt from system_prompts order by rowid desc limit 1').fetchone()
    # Meme retrait que le proxy (sansBlocContexte, server.js) : le CLI recharge
    # deja la carte par ~/.claude/CLAUDE.md.
    return re.sub(r'<!-- CONTEXTE:DEBUT[\s\S]*?<!-- CONTEXTE:FIN -->\n?', '', p, count=1)


def journal(ligne):
    with open(BANC / 'banc-conso.jsonl', 'a') as f:
        f.write(json.dumps(ligne, ensure_ascii=False) + '\n')


def claude(args, entree, timeout=900):
    env = dict(os.environ, CLAUDE_TIMEOUT_MS=str(timeout * 1000))
    t0 = time.time()
    r = subprocess.run(['claude', '-p', '--output-format', 'json', *args],
                       input=entree, capture_output=True, text=True,
                       timeout=timeout, env=env, cwd=Path.home() / '.hermes/workspace')
    try:
        d = json.loads(r.stdout)
    except json.JSONDecodeError:
        d = {'is_error': True, 'result': (r.stdout + r.stderr)[-2000:]}
    d['_duree_s'] = round(time.time() - t0, 1)
    return d


def rejouer_un(tache, version, sysfile):
    sortie = RES / f"{tache['id']}-{version}.json"
    if sortie.exists():
        return f"{sortie.name} deja fait"
    args = ['--model', MODELE, '--effort', EFFORT,
            '--settings', str(ICI / 'claude-settings.json'),
            '--tools', OUTILS, '--disallowedTools', 'Write,Edit,NotebookEdit',
            '--mcp-config', '{"mcpServers":{}}', '--strict-mcp-config',
            '--system-prompt-file', str(sysfile)]
    try:
        d = claude(args, f"[VJ] {tache['prompt']}{GARDE}")
    except subprocess.TimeoutExpired:
        d = {'is_error': True, 'result': 'timeout', '_duree_s': 900}
    d['_tache'], d['_version'] = tache['id'], version
    sortie.write_text(json.dumps(d, ensure_ascii=False, indent=1))
    journal({'ts': time.time(), 'etape': 'rejeu', 'tache': tache['id'], 'version': version,
             'cout_usd': d.get('total_cost_usd'), 'erreur': d.get('is_error')})
    return f"{sortie.name} {d.get('total_cost_usd')} $ {d['_duree_s']} s"


def rejouer(a):
    RES.mkdir(parents=True, exist_ok=True)
    taches = json.load(open(BANC / 'taches.json'))[: a.limite]
    base = prompt_systeme()
    fichiers = {}
    for v in a.versions.split(','):
        fichiers[v] = BANC / f'systeme-{v}.txt'
        # v1b = v1 rejoue une 2e fois : mesure le bruit d'un run a l'autre
        fichiers[v].write_text(f"{base}\n{directive(v.rstrip('b'))}")
    travaux = [(t, v) for t in taches for v in fichiers]
    with ThreadPoolExecutor(a.paralleles) as ex:
        for msg in ex.map(lambda tv: rejouer_un(tv[0], tv[1], fichiers[tv[1]]), travaux):
            print(msg, flush=True)


JUGE = """Tu es juge d'un banc a l'aveugle. VJ (francophone, dyslexique, chef d'entreprise
en Thailande) a pose la demande ci-dessous a son assistant. 2 reponses ont ete produites.

Note chacune de 1 a 10 sur ce qui compte pour VJ :
- exactitude et preuve : chaque constat porte sa source, rien d'invente ;
- completude : la demande est traitee en entier ;
- utilite : VJ peut trancher ou agir apres l'avoir lue ;
- forme : reponse en tete, courte, lisible.
Si les 2 reponses se contredisent sur un fait qui compte, VERIFIE-le avec tes outils
(lecture seule : Read, Bash sans rien modifier) avant de trancher, et cite ta preuve.
Ne crois aucune reponse sur parole.

Reponds par UN objet JSON seul, sans texte autour :
{"note_A": n, "note_B": n, "meilleur": "A"|"B"|"egal", "contradiction": "..." ou "", "raison": "1 phrase"}

## Demande
<<D>>

## Reponse A
<<A>>

## Reponse B
<<B>>
"""


def juger_un(tache, paire=('v1', 'v2')):
    pa, pb = paire
    sortie = RES / f"{tache['id']}-juge{'' if paire == ('v1', 'v2') else '-' + pa + pb}.json"
    if sortie.exists():
        return json.loads(sortie.read_text())
    r1 = json.loads((RES / f"{tache['id']}-{pa}.json").read_text())
    r2 = json.loads((RES / f"{tache['id']}-{pb}.json").read_text())
    v1_en_a = random.random() < 0.5
    a, b = (r1, r2) if v1_en_a else (r2, r1)
    texte = (JUGE.replace('<<D>>', tache['prompt'])
             .replace('<<A>>', str(a.get('result', ''))).replace('<<B>>', str(b.get('result', ''))))
    d = claude(['--model', MODELE, '--effort', 'high', '--tools', 'Read,Bash',
                '--disallowedTools', 'Write,Edit,NotebookEdit',
                '--settings', str(ICI / 'claude-settings.json'),
                '--mcp-config', '{"mcpServers":{}}', '--strict-mcp-config'],
               texte, timeout=900)
    brut = str(d.get('result', ''))
    try:
        v = json.loads(brut[brut.index('{'): brut.rindex('}') + 1])
    except ValueError:
        v = {'erreur': brut[:300]}
    if 'note_A' in v:
        n1, n2 = (v['note_A'], v['note_B']) if v1_en_a else (v['note_B'], v['note_A'])
        m = v.get('meilleur')
        g = 'egal' if m == 'egal' else ('v1' if (m == 'A') == v1_en_a else 'v2')
        v.update(note_v1=n1, note_v2=n2, gagnant=g)
    v['cout_juge_usd'] = d.get('total_cost_usd')
    sortie.write_text(json.dumps(v, ensure_ascii=False, indent=1))
    journal({'ts': time.time(), 'etape': 'juge', 'tache': tache['id'], 'cout_usd': d.get('total_cost_usd')})
    return v


def juger(a):
    paire = tuple(a.paire.split(','))
    taches = [t for t in json.load(open(BANC / 'taches.json'))
              if all((RES / f"{t['id']}-{v}.json").exists() for v in paire)]
    with ThreadPoolExecutor(a.paralleles) as ex:
        for t, v in zip(taches, ex.map(lambda t: juger_un(t, paire), taches)):
            print(t['id'], v.get('note_v1'), v.get('note_v2'), v.get('gagnant'), flush=True)


def couts(d):
    mu = d.get('modelUsage') or {}
    out = {'total': d.get('total_cost_usd') or 0}
    for nom, u in mu.items():
        cle = 'opus' if 'opus' in nom else 'sonnet' if 'sonnet' in nom else 'haiku' if 'haiku' in nom else nom
        out[cle] = out.get(cle, 0) + (u.get('costUSD') or 0)
    return out


def bilan(_a):
    taches = json.load(open(BANC / 'taches.json'))
    lignes, s1, s2, c1, c2, gagne = [], 0, 0, {}, {}, {'v1': 0, 'v2': 0, 'egal': 0}
    for t in taches:
        j = RES / f"{t['id']}-juge.json"
        if not j.exists():
            continue
        v = json.loads(j.read_text())
        if 'note_v1' not in v:
            continue
        r1 = couts(json.loads((RES / f"{t['id']}-v1.json").read_text()))
        r2 = couts(json.loads((RES / f"{t['id']}-v2.json").read_text()))
        for c, r in ((c1, r1), (c2, r2)):
            for k, x in r.items():
                c[k] = c.get(k, 0) + x
        s1 += v['note_v1']; s2 += v['note_v2']; gagne[v['gagnant']] += 1
        lignes.append(f"{t['id']:>6} {t['type']:<8} v1 {v['note_v1']:>2} v2 {v['note_v2']:>2} "
                      f"{r1['total']:6.2f} $ -> {r2['total']:6.2f} $  {v.get('raison', '')[:70]}")
    n = len(lignes)
    if not n:
        print('rien de juge'); return
    print('\n'.join(lignes))
    print(f"\n{n} taches · note moyenne v1 {s1/n:.2f} · v2 {s2/n:.2f} · ratio {s2/s1:.3f} (seuil 0.95)")
    print(f"gagnant : v1 {gagne['v1']} · v2 {gagne['v2']} · egal {gagne['egal']}")
    print(f"cout v1 {c1.get('total',0):.2f} $ ({json.dumps({k: round(x,2) for k,x in c1.items()})})")
    print(f"cout v2 {c2.get('total',0):.2f} $ ({json.dumps({k: round(x,2) for k,x in c2.items()})})")
    if c1.get('total'):
        print(f"ecart de cout : {100*(c2['total']/c1['total']-1):+.1f} %")
    bruit = [json.loads(f.read_text()) for f in RES.glob('*-juge-v1v1b.json')]
    bruit = [b for b in bruit if 'note_v1' in b]
    if bruit:
        e = sum(abs(b['note_v1'] - b['note_v2']) for b in bruit) / len(bruit)
        print(f"bruit (v1 contre v1 rejoue, {len(bruit)} taches) : ecart moyen {e:.2f} point")


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    sp = p.add_subparsers(dest='cmd', required=True)
    r = sp.add_parser('rejouer'); r.add_argument('--limite', type=int, default=99)
    r.add_argument('--paralleles', type=int, default=3); r.add_argument('--versions', default='v1,v2')
    j = sp.add_parser('juger'); j.add_argument('--paralleles', type=int, default=3)
    j.add_argument('--paire', default='v1,v2')
    sp.add_parser('bilan')
    a = p.parse_args()
    {'rejouer': rejouer, 'juger': juger, 'bilan': bilan}[a.cmd](a)
