#!/usr/bin/env python3
"""Banc : les listes de skills du contexte servent-elles encore ?

Cas = vrais tours Hermes ou l'agent a charge seul une skill que l'aiguilleur
n'avait pas injectee (usage-skills.py --hors-aiguilleur). Chaque cas est
rejoue 2 fois, message seul, sur les premiers pas du tour :
  avec : prompt de production (liste Hermes + outil Skill de Claude Code)
  sans : liste Hermes retiree et outil Skill retire (Read sur SKILL.md reste)
On note si la meme skill est chargee. Lecture seule, rien ne part.

  banc-skills.py cas [--jours 7] [--max 15] [--min 80] [--exclure ID]
  banc-skills.py rejouer [--paralleles 3] [--versions demande] [--ids a,b]
  demande : sans liste, une ligne qui renvoie a ~/bin/skill-cherche
  banc-skills.py bilan
Dossier : ~/.hermes/cache/scratch/banc-skills. Conso dans resultats/*.json.
"""
import argparse, json, os, re, sqlite3, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ICI = Path(__file__).resolve().parent.parent
BANC = Path.home() / '.hermes/cache/scratch/banc-skills'
RES = BANC / 'resultats'
MODELE, EFFORT = 'claude-opus-5-5', 'medium'
OUTILS = {'avec': 'Bash,Read,WebSearch,WebFetch,Agent,Skill,ToolSearch',
          'sans': 'Bash,Read,WebSearch,WebFetch,Agent,ToolSearch',
          'demande': 'Bash,Read,WebSearch,WebFetch,Agent,ToolSearch'}
# version « demande » : pas de liste, une ligne qui renvoie a l'aiguilleur a la demande
CONSIGNE_DEMANDE = ("\n## Skills\nAvant une etape qui demande un savoir-faire precis (connexion a un "
                    "site, mail, usine, document Marwell...), lance `~/bin/skill-cherche \"<l'etape>\"` "
                    "puis lis le SKILL.md qu'il donne.\n")
INJ = re.compile(r"\[Skill router: the skill '([^']+)'")
GARDE = ("\n\n(Banc de test : lecture seule. N'envoie, ne publie, ne modifie "
         "et ne lance rien qui change un etat.)")


def nom_skill(b):
    n, e = b.get('name'), b.get('input') or {}
    if n == 'Skill':
        return (e.get('skill') or '').split(':')[-1].split('/')[-1]
    if n == 'Read' and str(e.get('file_path', '')).endswith('/SKILL.md'):
        return Path(e['file_path']).parent.name
    if n == 'Bash':
        m = re.search(r'/([\w.-]+)/SKILL\.md', str(e.get('command', '')))
        return m.group(1) if m else None
    return None


def texte(c):
    if isinstance(c, str):
        return c
    return '\n'.join(b.get('text', '') for b in c or [] if isinstance(b, dict) and b.get('type') == 'text')


def cas(a):
    """1 cas par session : le message [Vin] juste avant le 1er chargement autonome."""
    lim = time.time() - a.jours * 86400
    out = []
    for f in (Path.home() / '.claude/projects').glob('*/*.jsonl'):
        if f.stat().st_mtime < lim:
            continue
        injectees, dernier = set(), None
        for l in f.open(errors='ignore'):
            try:
                d = json.loads(l)
            except ValueError:
                continue
            m = d.get('message') or {}
            if d.get('type') == 'user' and not d.get('isSidechain'):
                t = texte(m.get('content'))
                injectees |= set(INJ.findall(t))
                if t.startswith('[Vin]'):
                    dernier = re.split(r'\n\n<|\n\[System:|\n\[Skill router', t, maxsplit=1)[0]
            if d.get('type') == 'assistant' and isinstance(m.get('content'), list) and dernier:
                for b in m['content']:
                    if b.get('type') == 'tool_use':
                        n = nom_skill(b)
                        if n and n not in injectees:
                            out.append({'id': f.stem[:8], 'skill': n, 'prompt': dernier})
                            break
                else:
                    continue
                break
    vus, garde = set(), []
    for c in out:  # un message court (« Oui ») ne se rejoue pas sans son fil
        if len(c['prompt']) >= a.min and c['prompt'] not in vus and c['id'] != a.exclure:
            vus.add(c['prompt']); garde.append(c)
    out = garde[: a.max]
    BANC.mkdir(parents=True, exist_ok=True)
    (BANC / 'cas.json').write_text(json.dumps(out, ensure_ascii=False, indent=1))
    print(f"{len(out)} cas")
    for c in out:
        print(c['id'], c['skill'], c['prompt'][:70].replace('\n', ' '))


def systeme(version):
    db = sqlite3.connect(f'file:{Path.home()}/.hermes/state.db?mode=ro', uri=True)
    (p,) = db.execute('select prompt from system_prompts order by rowid desc limit 1').fetchone()
    p = re.sub(r'<!-- CONTEXTE:DEBUT[\s\S]*?<!-- CONTEXTE:FIN -->\n?', '', p, count=1)
    if version in ('sans', 'demande'):
        p = re.sub(r'## Skills\n[\s\S]*?</available_skills>\n\s*Only proceed[^\n]*\n(?:\(A copy of[^\n]*\n)?', '', p, count=1)
    js = f"import('{ICI}/directive-delegation.js').then(m=>process.stdout.write(m.directiveGroupage('v1')))"
    d = subprocess.run(['node', '-e', js], capture_output=True, text=True, check=True).stdout
    if version == 'demande':
        p += CONSIGNE_DEMANDE
    return f"{p}\n{d}"


def rejouer_un(c, v, sysfile):
    sortie = RES / f"{c['id']}-{v}.json"
    if sortie.exists():
        return sortie.name + ' deja fait'
    args = ['claude', '-p', '--output-format', 'stream-json', '--verbose',
            '--model', MODELE, '--effort', EFFORT, '--max-turns', '4',
            '--settings', str(ICI / 'claude-settings.json'),
            '--tools', OUTILS[v], '--disallowedTools', 'Write,Edit,NotebookEdit',
            '--mcp-config', '{"mcpServers":{}}', '--strict-mcp-config',
            '--system-prompt-file', str(sysfile)]
    try:
        r = subprocess.run(args, input=c['prompt'] + GARDE, capture_output=True, text=True,
                           timeout=600, cwd=Path.home() / '.hermes/workspace',
                           env=dict(os.environ, CLAUDE_TIMEOUT_MS='600000'))
        lignes = r.stdout.splitlines()
    except subprocess.TimeoutExpired:
        lignes = []
    charge, cout, appels = [], None, []
    for l in lignes:
        try:
            d = json.loads(l)
        except ValueError:
            continue
        if d.get('type') == 'assistant':
            for b in d['message'].get('content') or []:
                if b.get('type') == 'tool_use':
                    appels.append(f"{b['name']}:{str(b.get('input'))[:80]}")
                    n = nom_skill(b)
                    if n:
                        charge.append(n)
        if d.get('type') == 'result':
            cout = d.get('total_cost_usd')
    res = {'id': c['id'], 'version': v, 'attendue': c['skill'], 'chargees': charge,
           'trouvee': c['skill'] in charge, 'cout_usd': cout, 'appels': appels}
    sortie.write_text(json.dumps(res, ensure_ascii=False))
    return f"{c['id']} {v} {c['skill']} {'OUI' if res['trouvee'] else 'non'} {charge} {cout}"


def rejouer(a):
    RES.mkdir(parents=True, exist_ok=True)
    tous = json.loads((BANC / 'cas.json').read_text())
    fichiers = {}
    for v in (a.versions.split(',') if a.versions else OUTILS):
        fichiers[v] = BANC / f'systeme-{v}.txt'
        fichiers[v].write_text(systeme(v))
    print('taille systeme', {v: len(f.read_text()) for v, f in fichiers.items()}, flush=True)
    vs = a.versions.split(',') if a.versions else list(OUTILS)
    ids = set(a.ids.split(',')) if a.ids else None
    travaux = [(c, v) for c in tous for v in vs if not ids or c['id'] in ids]
    with ThreadPoolExecutor(a.paralleles) as ex:
        for m in ex.map(lambda cv: rejouer_un(cv[0], cv[1], fichiers[cv[1]]), travaux):
            print(m, flush=True)


def bilan(_a):
    r = [json.loads(f.read_text()) for f in RES.glob('*.json')]
    for v in OUTILS:
        x = [e for e in r if e['version'] == v]
        if x:
            ok = sum(e['trouvee'] for e in x)
            print(f"{v} : skill retrouvee {ok}/{len(x)} · cout {sum(e['cout_usd'] or 0 for e in x):.2f} $")
    par = {}
    for e in r:
        par.setdefault(e['id'], {})[e['version']] = e
    for i, d in sorted(par.items()):
        if len({e['trouvee'] for e in d.values()}) > 1:
            print(f"  ecart {i} {next(iter(d.values()))['attendue']} : " + ' '.join(f"{v}={e['chargees']}" for v, e in d.items()))


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    sp = p.add_subparsers(dest='cmd', required=True)
    c = sp.add_parser('cas'); c.add_argument('--jours', type=int, default=7); c.add_argument('--max', type=int, default=15)
    c.add_argument('--min', type=int, default=80); c.add_argument('--exclure', default='')
    r = sp.add_parser('rejouer'); r.add_argument('--paralleles', type=int, default=3)
    r.add_argument('--versions', default=''); r.add_argument('--ids', default='')
    sp.add_parser('bilan')
    a = p.parse_args()
    {'cas': cas, 'rejouer': rejouer, 'bilan': bilan}[a.cmd](a)
