# claude-proxy

Proxy local qui expose le CLI `claude` (Claude Code) derriere une API HTTP
compatible avec l'API Messages d'Anthropic. Tout client qui sait parler a
Anthropic (SDK, passerelle, outil de test) peut ainsi piloter le CLI sans
connaitre son protocole propre.

## Pourquoi

Le CLI `claude` gere l'authentification, l'abonnement et l'execution d'outils,
mais ne parle pas l'API HTTP d'Anthropic. Ce proxy fait le pont : il recoit une
requete `POST /v1/messages`, lance un process `claude` par tour, et renvoie la
reponse au format attendu, en streaming (SSE) ou en JSON.

## Ce qu'il apporte

- **Compatibilite API** : `POST /v1/messages` et `/v1/messages/count_tokens`,
  streaming SSE ou reponse JSON unique.
- **Chainage de sessions** : chaque tour est relie au precedent via `--resume`,
  reconstruit a partir de l'historique envoye par le client. La table des
  chainons survit a un redemarrage du proxy (persistee sur disque).
- **Economie de contexte** : le socle systeme est restreint aux outils reellement
  utilises, les sorties d'outils sont plafonnees, les images normalisees.
- **Dossier de travail par sujet** : un topic peut pointer vers son propre
  dossier de projet (donc son `CLAUDE.md` et ses hooks), resolu a chaque tour.
- **Concurrence dimensionnee** : plafond calcule sur la RAM et la pression CPU
  (PSI), file d'attente FIFO, refus net (HTTP 529) plutot qu'attente infinie.
- **Robustesse** : retry sur pannes transitoires, detection des erreurs fatales
  (auth, credit), timeout d'inactivite rearme a chaque signe de vie.

## Prerequis

- Node.js >= 18
- Le CLI `claude` installe et authentifie (`claude` dans le PATH)

## Demarrage

Installer la seule dependance (express) avec le gestionnaire de paquets de ton
choix, en respectant le lockfile fourni, puis lancer :

```bash
npm start
```

Le proxy ecoute sur le port `8000` par defaut.

## Configuration (variables d'environnement)

| Variable | Defaut | Role |
|---|---|---|
| `PORT` | `8000` | Port d'ecoute |
| `CLAUDE_BIN` | `claude` | Binaire du CLI |
| `CLAUDE_SETTINGS` | `./claude-settings.json` | Reglages passes au CLI |
| `CLAUDE_TIMEOUT_MS` | `300000` | Timeout d'un tour |
| `CLAUDE_MAX_CONCURRENCY` | auto | Force le plafond de concurrence |
| `CLAUDE_RESERVE_GB` | `6` | RAM reservee au systeme |
| `CLAUDE_EFFORT` | vide | Niveau de raisonnement par defaut |

## Modele et suffixes

Le nom de modele accepte deux suffixes optionnels :

- `-<effort>` (ex. `-high`) : niveau de raisonnement.
- `-notools` : la cible repond en texte seul, sans acces aux outils.

## Endpoints

- `POST /v1/messages` (et `/anthropic/v1/messages`)
- `POST /v1/messages/count_tokens`
- `GET /encours` : tours en vol
- `GET /health` : etat du proxy

## Licence

MIT. Voir [LICENSE](LICENSE).
