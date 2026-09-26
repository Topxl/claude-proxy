# Journal des modifications

Les dates sont celles des commits. Le détail vit dans `git log`.

## 2026-09-26

- **Relais d'outils MCP** (`tool-relay.js`, suffixe `-toolrelay`) : le client déclare ses propres outils. Le proxy les expose au CLI en MCP et renvoie de vrais blocs `tool_use`. Le processus `claude` reste suspendu sur l'appel, puis reprend quand le client poste le résultat sur `POST /outil`.
- **Arrêt de groupe** : `killpg(-pid)` remplace `child.kill()`. Un arrêt emporte les sous-agents, OpenCLI et Playwright, sans laisser d'orphelins.
- **Familles de conversation** : une empreinte sur la tête du prompt système sépare les conversations concurrentes (calcul du titre contre vraie réponse). Corrige le mélange de sessions du 24/09.
- **Tests** : relais de bout en bout, chaînage, familles, faux `claude`.
- **Docs** : README, wiki et ce journal.

## 2026-09-18

- **Prompt système géant** passé par fichier : fin des erreurs `E2BIG` au lancement du CLI.
- **stderr bénin** filtré : il masquait la vraie cause d'une panne.
- **Garde-fou de redémarrage** : le script de relance s'écrit au calme, les instances distantes passent.
- **Codex** : les mêmes hooks que Claude Code, côté CLI Codex.
- Réglages `supertool` du projet, `.gitignore` complété.

## 2026-09-05

- **`-notools`** : la fausse syntaxe d'appel d'outil est coupée à la source.

## 2026-09-02

- **Open source** : README, licence MIT, dernières corrections.

## 2026-08-27 au 2026-08-30

- **Tours en vol** : registre et endpoint `GET /encours`.
- **Flux silencieux** : le proxy ne les tue plus, et chaque coupure est journalisée. Le plafond de silence forcé par le service est corrigé.
- **Sorties d'outils plafonnées** : images (39 % des tokens vision) et Bash à 8 000 caractères.
- **Sous-agents protégés** d'un redémarrage du proxy.
- **Chaînage des sessions** (`--resume`) : indexation de l'historique privé du dernier message, et traces sur les échecs de recherche.
