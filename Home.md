# Claude Proxy : documentation

Proxy local qui expose le CLI `claude` (Claude Code) derrière une API HTTP compatible Anthropic Messages.

## Architecture

```
Client HTTP → POST /v1/messages → proxy → CLI `claude` → réponse Anthropic
                                   ↕
                              /outil (mode relais MCP)
```

## Endpoints

| Méthode | Chemin | Rôle |
|---|---|---|
| `POST` | `/v1/messages` | Tour de conversation |
| `POST` | `/anthropic/v1/messages` | Alias (compatibilité SDK) |
| `POST` | `/outil` | Traitement d'outil MCP suspendu |
| `POST` | `/v1/messages/count_tokens` | Comptage de tokens |
| `GET` | `/encours` | Tours en vol |
| `GET` | `/health` | État du proxy |

## Fonctionnalités

### Relais d'outils MCP
Le process `claude` survit à la réponse HTTP quand il est suspendu sur un appel d'outil. L'outil est servi via `/outil`, sans process ni socket supplémentaires. Timeout : 16 minutes.

### Kill de groupe
`killpg(-pid)` au lieu de `child.kill()`. Emporte les descendants (sous-agents, OpenCLI, Playwright) et ne laisse plus d'orphelins.

### Familles de conversation
Empreinte sur la tête du prompt système pour séparer les conversations concurrentes. Évite les corruptions quand deux chaînes partagent les mêmes messages (ex. calcul du titre vs réponse réelle). Corrige le bug du 24/09/2026 (topic « marwell 3 »).

### Chaînage de sessions
Chaque tour est relié au précédent via `--resume`, reconstruit à partir de l'historique. La table des chaînons survit à un redémarrage (persistée sur disque).

## Configuration

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `8000` | Port d'écoute |
| `CLAUDE_BIN` | `claude` | Binaire du CLI |
| `CLAUDE_SETTINGS` | `./claude-settings.json` | Réglages du CLI |
| `CLAUDE_TIMEOUT_MS` | `300000` | Timeout streaming |
| `CLAUDE_TIMEOUT_RELAIS_MS` | `960000` | Timeout relais MCP |
| `CLAUDE_MAX_CONCURRENCY` | auto | Plafond de concurrence |
| `CLAUDE_RESERVE_GB` | `6` | RAM réservée au système |
| `CLAUDE_EFFORT` | vide | Niveau de raisonnement |

## Suffixes de modèle

- `-<effort>` (ex. `-high`) : niveau de raisonnement
- `-notools` : cible en texte seul, sans outils
- `-toolrelay` : le client exécute ses outils, relayés en MCP (`tool-relay.js`)

## Journal

Voir la page [[Changelog]].

## Licence

MIT.