import express from 'express';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import {
  readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, readdirSync,
} from 'node:fs';
import { unlinkSync, statSync, appendFile, appendFileSync } from 'node:fs';

// Prompts systeme trop gros pour argv (voir E2BIG plus bas). Purge au
// demarrage de tout ce qui date de plus de 24 h : ces fichiers ne servent
// qu'a la duree de vie des sessions en cours.
const DOSSIER_PROMPTS = path.join(os.tmpdir(), 'claude-proxy-prompts');
try {
  mkdirSync(DOSSIER_PROMPTS, { recursive: true });
  const limite = Date.now() - 24 * 3600 * 1000;
  for (const f of readdirSync(DOSSIER_PROMPTS)) {
    const c = path.join(DOSSIER_PROMPTS, f);
    if (statSync(c).mtimeMs < limite) unlinkSync(c);
  }
} catch (e) { console.warn('[sys] purge prompts impossible:', e.message); }

const HERE = path.dirname(fileURLToPath(import.meta.url));

// --- Dossier de travail par topic ------------------------------------------
// Le CLI fige son "dossier de projet" au lancement : c'est lui qui decide quel
// CLAUDE.md est lu et quels hooks de .claude/settings.json se declenchent. Tant
// que tout tournait dans HERE, un topic dedie a un projet ne voyait ni sa
// doctrine ni son hook de deploiement.
//
// La resolution est refaite a CHAQUE tour, jamais mise en cache : ecrire la
// table pendant une conversation deplace donc le topic des le message suivant,
// sans redemarrer le proxy. C'est ce qui rend le changement de dossier en
// cours de route possible ("on passe sur un autre projet") et l'entree dans
// un dossier tout neuf immediate.
//
// Trois etages, du plus explicite au plus devinable :
//   1. ~/.hermes/topics-cwd.json    { "4469": "/home/vj/Bureau/Projets/MonProjet" }
//   2. ~/.hermes/qg-noms.json       { "4469": "MonProjet" } -> ~/Bureau/Projets/MonProjet
//      (le nom du topic sert de nom de dossier, casse ignoree : un topic
//       nomme comme son projet n'a rien a declarer)
//   3. HERE, le dossier du proxy.
// Un dossier absent ou illisible retombe a l'etage suivant, jamais d'echec dur.
const TABLE_CWD = path.join(os.homedir(), '.hermes', 'topics-cwd.json');
const TABLE_NOMS = path.join(os.homedir(), '.hermes', 'qg-noms.json');
// Topics Hermes passes en relais d'outils (2026-10-10). Liste d'ids de thread,
// relue a chaque requete : ajouter ou retirer un topic ne demande aucun
// redemarrage. Voir topicEnRelais().
const TABLE_RELAIS = path.join(os.homedir(), '.hermes', 'topics-relais.json');
// Consommation reelle : une ligne JSON par appel du CLI, lue par
// ~/.claude/outils/conso-hermes.py. Les chiffres viennent de l'evenement
// `result` du CLI (usage + total_cost_usd), pas d'une estimation chars/4.
const FICHIER_USAGE = process.env.PROXY_USAGE_LOG
  || path.join(os.homedir(), '.hermes', 'proxy-usage.jsonl');

function journaliserUsage(ligne) {
  try {
    mkdirSync(path.dirname(FICHIER_USAGE), { recursive: true });
    appendFile(FICHIER_USAGE, `${JSON.stringify(ligne)}\n`, (e) => {
      if (e) console.warn('[usage] ecriture impossible:', e.message);
    });
  } catch (e) { console.warn('[usage] ecriture impossible:', e.message); }
}

// Nature de l'appel. Un cron Hermes porte cette phrase dans son prompt ;
// un topic Telegram porte `thread: N` dans le prompt systeme.
function sourceDe(system, prompt) {
  if (/You are running as a scheduled cron job/.test(prompt || '')) return 'cron';
  if (topicDe(system)) return 'topic';
  if (/\*\*Source:\*\*/.test(system || '')) return 'chat';
  return 'auxiliaire';
}
// Familles d'appels auxiliaires, reconnues au debut du prompt (2026-10-28).
// Mesure du 21 au 28/10 : ces appels a texte seul chargeaient quand meme le
// socle d'outils et les CLAUDE.md (~33k tokens ecrits a froid pour 300 car.
// de question). Vision 198 appels 20,6 $, verdict d'enquete 66 appels 11,7 $,
// pings « hi » 93 appels 5,7 $. Avec sansOutils, le CLI part en texte seul.
// La compression (<conversation>) et les chantiers gardent leurs outils :
// la revue de fond d'Hermes y appelle fact_store, Bash, Edit.
const FAMILLES_AUX = [
  { nom: 'vision', motif: /^Concisely describe this image/, sansOutils: true },
  // Vision avec question : garde ses outils. 11 cas sur 394 du 21 au 28/10
  // zoomaient l'image avec PIL (texte fin, mesure du curseur d'un captcha).
  { nom: 'vision-question', motif: /^Fully describe and explain everything about/, sansOutils: false },
  { nom: 'resume-contexte', motif: /^You are a summarization agent/, sansOutils: true },
  { nom: 'enquete-verdict', motif: /^Voici un verdict de recherche/, sansOutils: true },
  { nom: 'ping', motif: /^(hi|ping|test)\s*$/i, sansOutils: true },
  { nom: 'mail-resume', motif: /^(Resume ce mail recu|Read this email received)/, sansOutils: true },
  { nom: 'reel', motif: /^Tu viens de recevoir la transcription d'un Reel/, sansOutils: true },
  { nom: 'compression', motif: /^<conversation>/, sansOutils: false },
  { nom: 'chantier', motif: /^## Chantier :/, sansOutils: false },
];
// Regle inversee (2026-11-13). Un appel auxiliaire que personne ne signe, sans
// famille connue et a consigne courte, part en texte seul. Mesure du 30/10 au
// 13/11 sur ces appels : 987 n'ont appele aucun outil, et les 20 qui en ont
// appele sous 2 000 caracteres de consigne venaient d'`enquete` (passe en
// `-notools` depuis) ou d'essais a la main. Chacun payait pourtant le socle
// d'outils et les CLAUDE.md. Les consignes longues (agents Hermes hors topic)
// gardent leurs outils : ce sont elles qui s'en servent. Garder les outils
// malgre tout : se nommer par `metadata.user_id`, ou suffixe de modele `-tools`.
const CONSIGNE_COURTE = Number(process.env.PROXY_ANONYME_COURT_CAR ?? 2000);
function anonymeCourt(spec, system, prompt) {
  return CONSIGNE_COURTE > 0 && !spec.client && !spec.relais && !spec.appelant
    && !spec.outilsVoulus && sourceDe(system, prompt) === 'auxiliaire'
    && (system || '').length < CONSIGNE_COURTE;
}
function familleAux(system, prompt) {
  if (typeof prompt !== 'string' || sourceDe(system, prompt) !== 'auxiliaire') return null;
  const tete = prompt.trimStart();
  return FAMILLES_AUX.find((f) => f.motif.test(tete)) || null;
}
const RACINE_PROJETS = path.join(os.homedir(), 'Bureau', 'Projets');

function lireJson(fichier) {
  try { return JSON.parse(readFileSync(fichier, 'utf8')); } catch { return {}; }
}

function dossierParNom(nom) {
  if (!nom) return null;
  const direct = path.join(RACINE_PROJETS, nom);
  if (existsSync(direct)) return direct;
  // Casse libre : un topic nomme "MonProjet" trouve le dossier "monprojet".
  // Les projets sont ranges par univers et famille (Projets/<univers>/<famille>/<nom>)
  // depuis le 2026-10-24 : on cherche en largeur, jusqu'a 3 niveaux, liens exclus.
  const cible = nom.toLowerCase();
  let niveau = [RACINE_PROJETS];
  for (let prof = 0; prof < 3 && niveau.length; prof++) {
    const suivant = [];
    for (const dossier of niveau) {
      try {
        for (const e of readdirSync(dossier, { withFileTypes: true })) {
          if (!e.isDirectory() || e.name.startsWith('.')) continue;
          const chemin = path.join(dossier, e.name);
          if (e.name.toLowerCase() === cible) return chemin;
          suivant.push(chemin);
        }
      } catch {}
    }
    niveau = suivant;
  }
  return null;
}

function topicDe(system) {
  const m = system && /thread:\s*(\d+)/.exec(system);
  return m ? m[1] : null;
}

function topicEnRelais(system) {
  const topic = topicDe(system);
  if (!topic) return false;
  const liste = lireJson(TABLE_RELAIS);
  return Array.isArray(liste) && liste.map(String).includes(topic);
}

function cwdPourTopic(system) {
  const topic = topicDe(system);
  if (!topic) return HERE;
  const declare = lireJson(TABLE_CWD)[topic];
  if (declare && existsSync(declare)) return declare;
  return dossierParNom(lireJson(TABLE_NOMS)[topic]) || HERE;
}

const PORT = Number(process.env.PORT) || 8000;
import * as toolRelay from './tool-relay.js';
import * as comptes from './comptes.js';
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const CLAUDE_SETTINGS = process.env.CLAUDE_SETTINGS || path.join(HERE, 'claude-settings.json');
const TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS) || 300_000;
// Filet de securite du mode relais, volontairement plus long que son TTL.
const TIMEOUT_RELAIS_MS = 16 * 60 * 1000;
// Concurrence : dimensionnee sur la machine, pas sur une constante.
// Chaque requete = un process `claude` complet. Le facteur limitant est la RAM,
// pas le CPU : un process tient ~0,3 Go au repos et pointe vers 0,7 Go sur une
// tache longue. On garde RESERVE_GB pour le systeme et le
// reste des services, et on plafonne aussi par les coeurs pour ne pas noyer
// l'ordonnanceur. CLAUDE_MAX_CONCURRENCY force la valeur si besoin.
const PROCESS_GB = Number(process.env.CLAUDE_PROCESS_GB) || 0.7;
const RESERVE_GB = Number(process.env.CLAUDE_RESERVE_GB) || 6;
const CONCURRENCY_FLOOR = Number(process.env.CLAUDE_CONCURRENCY_FLOOR) || 3;
// Contention CPU au-dela de laquelle on arrete d'ouvrir des creneaux, en %.
// Un process `claude` qui attend l'API coute 2-3 % de CPU, mais le meme process
// qui lance un build ou un ffmpeg via son outil bash en coute beaucoup plus, et
// ces enfants vivent dans le meme cgroup. Compter les process ne distingue pas
// les deux cas.
//
// La mesure est PSI (/proc/pressure/cpu, champ `some avg10`) et non la load
// average : une load de 55 pour 24 coeurs peut se voir alors que rien n'etait
// reellement bloque : la load compte l'attente disque, PSI compte le temps
// pendant lequel une tache attend vraiment un coeur. Meme raison que
// MemAvailable plutot que freemem.
const CPU_PRESSURE_CEILING = Number(process.env.CLAUDE_CPU_PRESSURE_CEILING) || 90;
const CONCURRENCY_CEILING = Number(process.env.CLAUDE_CONCURRENCY_CEILING) || 64;

/** Go reellement disponibles (MemAvailable, pas freemem qui ignore le cache). */
function availableGb() {
  try {
    const meminfo = readFileSync('/proc/meminfo', 'utf8');
    const m = meminfo.match(/^MemAvailable:\s+(\d+) kB$/m);
    if (m) return Number(m[1]) / 1024 / 1024;
  } catch { /* pas Linux, ou /proc absent */ }
  return os.freemem() / 2 ** 30;  // approximation basse, jamais optimiste
}

/**
 * Contention CPU en %, sur les 10 dernieres secondes. 0 = personne n'attend un
 * coeur, 100 = il y a toujours quelqu'un en attente. Repli sur la load average
 * ramenee en % si PSI est absent (noyau < 4.20, cgroup v1, autre OS).
 */
function cpuPressure() {
  try {
    const m = readFileSync('/proc/pressure/cpu', 'utf8').match(/^some .*avg10=([\d.]+)/m);
    if (m) return Number(m[1]);
  } catch { /* PSI indisponible */ }
  return (os.loadavg()[0] / Math.max(1, os.cpus().length)) * 100;
}

function detectConcurrency() {
  const forced = Number(process.env.CLAUDE_MAX_CONCURRENCY);
  if (Number.isFinite(forced) && forced > 0) return Math.floor(forced);

  // Volontairement pas de plafond par coeurs : un process `claude` tient
  // 2-3 % de CPU parce qu'il passe son temps a attendre l'API, pas a
  // calculer. Brider sur les coeurs limiterait une machine dont la RAM
  // autorise davantage, sans rien proteger. Les vrais garde-fous sont la RAM
  // ici, memoryAllowsAnotherSlot() en continu, et le 429 de l'API en bout de
  // chaine (deja retente, voir MAX_ATTEMPTS).
  const byRam = Math.floor((os.totalmem() / 2 ** 30 - RESERVE_GB) / PROCESS_GB);
  return Math.max(CONCURRENCY_FLOOR, Math.min(CONCURRENCY_CEILING, byRam));
}

const MAX_CONCURRENCY = detectConcurrency();
const PING_MS = 5_000;
// Le SDK Anthropic ignore les evenements `ping` (anthropic/_streaming.py : `continue`).
// Seul un vrai evenement de contenu remet a zero le detecteur de flux mort d'Hermes
// (HERMES_STREAM_STALE_TIMEOUT). On envoie donc un text_delta vide, qui ne pollue
// pas la reponse mais compte comme un chunk cote client.
const KEEPALIVE_MS = Number(process.env.CLAUDE_KEEPALIVE_MS) || 30_000;
// Garde-fou : si le CLI n'emet plus rien du tout, on arrete le keepalive pour
// laisser Hermes detecter la panne au lieu de la masquer indefiniment.
// 0 = illimite. Le timeout d'inactivite (TIMEOUT_MS, 30 min en service) protege deja ;
// arreter le keepalive faisait fermer la connexion cote client, donc SIGKILL silencieux.
const KEEPALIVE_MAX_SILENCE_MS = Number(process.env.CLAUDE_KEEPALIVE_MAX_SILENCE_MS) || 0;
const MAX_ATTEMPTS = Number(process.env.CLAUDE_MAX_ATTEMPTS) || 3;
// Journal d'outils (« → Bash: date ») dans le stream. DESACTIVE par defaut :
// juste le texte, comme avant. Mettre CLAUDE_STREAM_TRACE=1 pour l'activer.
const STREAM_TRACE = ['1', 'on', 'true', 'oui'].includes(
  String(process.env.CLAUDE_STREAM_TRACE || '').toLowerCase());
const RETRY_DELAYS_MS = [1_000, 3_000];
// Au-dela, mieux vaut un refus net qu'une attente sans fin : Hermes reessaiera.
const MAX_QUEUE = Number(process.env.CLAUDE_MAX_QUEUE) || 20;
// Attente en file au-dela de ce seuil : on le dit en tete de reponse, sinon le
// topic parait muet alors qu'il attendait son tour.
const QUEUE_NOTICE_MS = Number(process.env.CLAUDE_QUEUE_NOTICE_MS) || 5_000;

const app = express();
app.use(express.json({ limit: '50mb' }));

/* ------------------------------------------------------------------ */
/* File d'attente : un process claude pese ~500 Mo, on n'en lance pas  */
/* dix en parallele parce qu'Hermes a envoye dix requetes.             */
/* ------------------------------------------------------------------ */

let running = 0;
const waiting = [];
// Process claude vivants, pour les tuer proprement a l'arret du service.
const liveChildren = new Set();

// Un `child.kill()` ne tue QUE le binaire claude : ses descendants (sous-agents,
// opencli, python, playwright) survivent en orphelins. Le fils est donc lance
// detache (`detached: true`), il devient chef de son groupe, et on signale le
// groupe entier via le PID negatif. Chrome et le demon OpenCLI vivent hors de
// ce groupe (lances par le daemon, pas par un tour) : ils sont epargnes.
//
// Le groupe ne suffit pas (mesure du 2026-10-03) : Claude Code lance chaque
// commande Bash sous setsid, dans sa propre session et son propre groupe. Un
// /stop tuait le CLI mais laissait finir les scripts en cours (opencli, python,
// curl en boucle). On releve donc tous les descendants AVANT de tuer : une fois
// le parent mort, ils sont reparentes a systemd et la filiation est perdue.
//
// `toutLeTour` va plus loin, pour un /stop seulement : tout process dont
// l'environnement porte le PROXY_TOUR de ce tour, meme detache par setsid
// (agent-fond, nohup ... &). Les demons partages (Chrome, demon OpenCLI) qu'un
// tour aurait demarres en premier sont epargnes : d'autres tours s'en servent.
const DEMONS_PARTAGES = /chrome|chromium|opencli\/dist\/src\/daemon|--chrome-native-host|claude-mem/;

function lireProc(pid, fichier) {
  try { return readFileSync(`/proc/${pid}/${fichier}`, 'utf8'); } catch { return ''; }
}

function pidsVivants() {
  try { return readdirSync('/proc').filter((n) => /^\d+$/.test(n)).map(Number); } catch { return []; }
}

function descendants(racine) {
  const enfants = new Map();
  for (const pid of pidsVivants()) {
    // Le nom du process (2e champ) peut contenir des espaces : on coupe apres la parenthese.
    const stat = lireProc(pid, 'stat');
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    if (!enfants.has(ppid)) enfants.set(ppid, []);
    enfants.get(ppid).push(pid);
  }
  const vus = [];
  const pile = [racine];
  while (pile.length) {
    const p = pile.pop();
    for (const e of enfants.get(p) || []) { vus.push(e); pile.push(e); }
  }
  return vus;
}

function taguesDuTour(tour) {
  if (!tour) return [];
  const marque = `PROXY_TOUR=${tour}`;
  return pidsVivants().filter((pid) => {
    if (pid === process.pid) return false;
    if (!lireProc(pid, 'environ').split('\0').includes(marque)) return false;
    return !DEMONS_PARTAGES.test(lireProc(pid, 'cmdline').replace(/\0/g, ' '));
  });
}

function tuerArbre(proc, signal = 'SIGKILL', { toutLeTour = false } = {}) {
  if (!proc || !proc.pid) return;
  const cibles = new Set(descendants(proc.pid));
  if (toutLeTour) for (const pid of taguesDuTour(proc.tour)) cibles.add(pid);
  cibles.delete(process.pid);
  try { process.kill(-proc.pid, signal); } catch { /* groupe deja mort */ }
  try { proc.kill(signal); } catch { /* deja mort */ }
  for (const pid of cibles) {
    // Un chef de groupe emporte ses petits-enfants restes dans son groupe.
    try { process.kill(-pid, signal); } catch { /* pas chef de groupe */ }
    try { process.kill(pid, signal); } catch { /* deja mort */ }
  }
  if (cibles.size) console.warn(`[tuer] ${cibles.size} process hors groupe tues${toutLeTour ? ' (tout le tour)' : ''}`);
}


/*
 * Registre des tours en vol : qui parle, depuis quand, et depuis combien de
 * temps il se tait.
 *
 * `running` ne disait qu'une chose : combien ils etaient. Quand un tour mourait
 * en silence, rien ne permettait de dire lequel, ni depuis quand, ni pourquoi.
 * Un agent muet et un agent mort avaient exactement la meme signature : aucune.
 * Le veilleur exterieur lit /encours et tranche.
 */
const enVol = new Map();
let __volSeq = 0;

// Un tour fini proprement s'efface tout de suite : il n'apprend rien a personne.
// Une coupure ou une erreur reste lisible une demi-heure, le temps qu'un
// veilleur passe et la signale, meme s'il tourne toutes les 5 minutes.
const FIN_ANORMALE_TTL_MS = 30 * 60 * 1000;

function suivre(info) {
  const id = `v${(__volSeq += 1)}`;
  const t = Date.now();
  enVol.set(id, { id, debut: t, activite: t, octets: 0, issue: null, ...info });
  return {
    id,
    touche(octets) {
      const e = enVol.get(id);
      if (!e) return;
      e.activite = Date.now();
      if (octets) e.octets = octets;
    },
    fin(issue, detail) {
      const e = enVol.get(id);
      // La premiere issue posee fait foi : onClose voit la coupure avant que le
      // bloc finally ne conclue, et c'est lui qui a raison.
      if (!e || e.issue) return;
      e.issue = issue;
      e.finVers = Date.now();
      if (detail) e.detail = String(detail).slice(0, 200);
      if (issue === 'fini') enVol.delete(id);
      else setTimeout(() => enVol.delete(id), FIN_ANORMALE_TTL_MS).unref();
    },
  };
}

// MAX_CONCURRENCY est calcule au demarrage sur la RAM totale. Mais la RAM
// *disponible* bouge : un service qui transcode, une autre appli qui
// redemarre, une session Claude Code. Ce garde relit MemAvailable avant
// chaque octroi, pour que la limite suive la machine au lieu d'une photo
// prise au boot. Sans lui, un pic
// exterieur transforme le parallelisme en OOM.
let lastMemBlockAt = 0;
let lastLoadBlockAt = 0;

function memoryAllowsAnotherSlot() {
  if (running < CONCURRENCY_FLOOR) return true;  // le plancher passe toujours
  const free = availableGb();
  if (free >= RESERVE_GB) return true;
  if (Date.now() - lastMemBlockAt > 60_000) {
    lastMemBlockAt = Date.now();
    console.warn(
      `[memoire] ${free.toFixed(1)} Go dispo < reserve ${RESERVE_GB} Go : `
      + `plafond ramene a ${running} au lieu de ${MAX_CONCURRENCY}`);
  }
  return false;
}

function cpuAllowsAnotherSlot() {
  if (running < CONCURRENCY_FLOOR) return true;  // le plancher passe toujours
  const pressure = cpuPressure();
  if (pressure < CPU_PRESSURE_CEILING) return true;
  if (Date.now() - lastLoadBlockAt > 60_000) {
    lastLoadBlockAt = Date.now();
    console.warn(
      `[charge] contention CPU ${pressure.toFixed(0)} % `
      + `(seuil ${CPU_PRESSURE_CEILING} %) : `
      + `plafond ramene a ${running} au lieu de ${MAX_CONCURRENCY}`);
  }
  return false;
}

function acquireSlot(info) {
  const memOk = memoryAllowsAnotherSlot();
  const cpuOk = memOk && cpuAllowsAnotherSlot();  // pas de double log inutile
  if (running < MAX_CONCURRENCY && memOk && cpuOk) {
    running += 1;
    return Promise.resolve();
  }
  if (waiting.length >= MAX_QUEUE) {
    return Promise.reject(Object.assign(new Error('Proxy sature.'), { overloaded: true }));
  }
  // Trois causes tres differentes : creneaux tous pris, RAM insuffisante, ou
  // machine deja a genoux. Annoncer la mauvaise enverrait sur une fausse piste.
  if (info) {
    info.ahead = waiting.length;
    info.runningAtEntry = running;
    if (running >= MAX_CONCURRENCY) info.reason = 'creneaux';
    else if (!memOk) info.reason = 'memoire';
    else info.reason = 'charge';
    info.freeGb = availableGb();
    info.cpuPressure = cpuPressure();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function releaseSlot() {
  const next = waiting.shift();
  if (next) {
    next();
    return;
  }
  running = Math.max(0, running - 1);
}

/* ------------------------------------------------------------------ */
/* Traduction de la requete Anthropic vers un prompt CLI               */
/* ------------------------------------------------------------------ */

/** Un message porte soit une string, soit des blocs. Le CLI ne lit que du texte. */
function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (!block || typeof block !== 'object') return '';
        if (block.type === 'text' && typeof block.text === 'string') return block.text;
        if (block.type === 'tool_result') return extractText(block.content);
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  return '';
}

/**
 * Les blocs image d'un message. Le prompt CLI est du texte plat : sans cette
 * recolte, `extractText` les jette en silence et le modele ne voit rien.
 * Bornes : le base64 est renvoye a chaque tour, il faut plafonner le poids.
 */
const IMAGES_MAX = 6;
const IMAGES_OCTETS_MAX = 16 * 1024 * 1024;

function extractImages(messages) {
  const out = [];
  let octets = 0;
  // Les derniers tours seulement : une photo de la semaine passee ne merite
  // pas d'etre renvoyee a chaque appel.
  const recents = messages.slice(-6);
  for (const m of recents) {
    const content = m?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || block.type !== 'image' || !block.source) continue;
      const poids = typeof block.source.data === 'string' ? block.source.data.length : 0;
      if (out.length >= IMAGES_MAX || octets + poids > IMAGES_OCTETS_MAX) return out;
      octets += poids;
      out.push(block);
    }
  }
  return out;
}

/**
 * Une ligne compacte et informative pour un appel d'outil : « → Bash: date ».
 * On montre la commande/le fichier, pas le JSON brut. Vide si rien d'utile.
 */
function ligneOutil(name, inputStr) {
  let arg = '';
  try {
    const o = JSON.parse(inputStr || '{}');
    arg = o.command || o.cmd || o.file_path || o.path || o.pattern
        || o.query || o.url || o.description || '';
    arg = String(arg).split('\n')[0].trim().slice(0, 70);
  } catch { /* input incomplet : on garde juste le nom */ }
  return arg ? `→ ${name}: ${arg}` : `→ ${name}`;
}

/** L'historique est aplati : le CLI n'a qu'une entree texte, pas de tableau de tours. */
/* Filtre de vocabulaire sensible (2026-11-08, ban du compte « contact ») :
 * chaque mot qui peut faire passer un usage pour offensif est reformule en
 * terme neutre AVANT l'envoi a Claude, dans le prompt systeme comme dans le
 * texte. Compte remplace par tour dans ~/.hermes/logs/sensibles.log. */
/* La liste vit dans ~/.config/claude-proxy/mots-sensibles.json
 * ([motif, remplacement], un par paire), relue a CHAQUE tour : changer un mot
 * ne demande aucun redemarrage. Ce tableau n'est que le repli si le fichier
 * est absent ou casse. */
const SENSIBLES_REpli = [
  [/\bjailbreaks?\b/gi, 'contournement'],
  [/\bmalwares?\b/gi, 'logiciel'],
  [/\bbotnets?\b/gi, 'reseau de machines'],
  [/\bransomwares?\b/gi, 'logiciel de chiffrement'],
  [/\bransom\b/gi, 'chiffrement'],
  [/\bvirus(es)?\b/gi, 'programme'],
  [/\binfect(?:er|e|es|ee|ions?|ion)\b/gi, 'installe'],
  [/\bphishings?\b/gi, 'message de leurre'],
  [/\bpayloads?\b/gi, 'contenu'],
  [/\bbackdoors?\b/gi, 'acces'],
  [/\bstealers?\b/gi, 'collecteur'],
  [/\btrojans?\b/gi, 'utilitaire'],
  [/\bhack(?:er|ers|eurs?|s)?\b/gi, 'technique'],
  [/\bpirate(?:s|ry)?\b/gi, 'technique'],
  [/\battaque(?:s)?\b/gi, 'test'],
  [/\battacks?\b/gi, 'test'],
  [/\bexploits?\b/gi, 'technique'],
  [/\bred.?team\b/gi, 'equipe de test'],
];
let SENSIBLES = null;
let SENSIBLES_LU = 0;
function chargerSensibles() {
  // Relu au plus toutes les 30 s : assez rapide pour une edit a chaud.
  if (SENSIBLES && Date.now() - SENSIBLES_LU < 30000) return SENSIBLES;
  try {
    const lu = JSON.parse(readFileSync('/home/vj/.config/claude-proxy/mots-sensibles.json', 'utf8'));
    try { PARADES = (lu.parades || []).map(([motif, texte]) => [
      new RegExp(motif, 'i'), texte]); } catch {}
    const paires = (lu.mots || []).map(([motif, remp]) => {
      const brut = motif.endsWith('*') ? motif.slice(0, -1) : motif;
      const fin = motif.endsWith('*') ? '\\w*' : '(?:s)?\\b';
      return [new RegExp('\\b' + brut.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&') + fin, 'gi'), remp];
    });
    if (paires.length) { SENSIBLES = paires; SENSIBLES_LU = Date.now(); return SENSIBLES; }
  } catch {}
  SENSIBLES = SENSIBLES_REpli;
  SENSIBLES_LU = Date.now();
  return SENSIBLES;
}
const LOG_SENSIBLES = '/home/vj/.hermes/logs/sensibles.log';
let PARADES = [];
function cadrePour(texte) {
  // Les parades : le cadre du travail, donne AVANT que Claude ne juge (2026-11-08).
  if (!texte || !PARADES.length) return '';
  const morceaux = [];
  for (const [re, texte_cadre] of PARADES) {
    try { if (re.test(texte)) morceaux.push(texte_cadre); } catch {}
  }
  return morceaux.length ? '\n' + morceaux.join('\n') : '';
}
function nettoyer(t) {
  if (!t) return t;
  let n = 0;
  for (const [re, remp] of chargerSensibles()) t = t.replace(re, () => { n++; return remp; });
  if (n) { try { appendFileSync(LOG_SENSIBLES, new Date().toISOString() + ' n=' + n + '\n'); } catch {} }
  return t;
}

/*
 * Elagage au demarrage a froid (VJ, 2026-11-13) : quand la session CLI ne peut
 * pas etre reprise, tout l'historique est reecrit au tarif ecriture du cache.
 * Les resultats d'outils vieux de plus de ELAGAGE_TOURS tours (1 tour = 2
 * messages) y pesent le plus : on les coupe a ELAGAGE_CARS caracteres.
 * `CLAUDE_ELAGAGE_TOURS=0` coupe la fonction. Ne touche jamais `messages` :
 * les empreintes de chainage en dependent.
 */
const ELAGAGE_TOURS = Number(process.env.CLAUDE_ELAGAGE_TOURS ?? 10);
const ELAGAGE_CARS = Number(process.env.CLAUDE_ELAGAGE_CARS) || 1500;

function couper(texte) {
  if (typeof texte !== 'string' || texte.length <= ELAGAGE_CARS) return texte;
  return `${texte.slice(0, ELAGAGE_CARS)}\n[... resultat coupe, ${texte.length - ELAGAGE_CARS} car en moins]`;
}

function elaguerResultatsOutils(messages) {
  if (!ELAGAGE_TOURS) return messages;
  const limite = messages.length - ELAGAGE_TOURS * 2;
  if (limite <= 0) return messages;
  return messages.map((m, i) => {
    if (i >= limite || !m || !Array.isArray(m.content)) return m;
    let change = false;
    const content = m.content.map((b) => {
      if (!b || b.type !== 'tool_result') return b;
      let nouveau = b.content;
      if (typeof b.content === 'string') nouveau = couper(b.content);
      else if (Array.isArray(b.content)) {
        nouveau = b.content.map((x) => (x && x.type === 'text' ? { ...x, text: couper(x.text) } : x));
      }
      if (JSON.stringify(nouveau) === JSON.stringify(b.content)) return b;
      change = true;
      return { ...b, content: nouveau };
    });
    return change ? { ...m, content } : m;
  });
}

// Blocs qu'Hermes colle au message de VJ pour un seul appel (rappel de memoire,
// regles apprises). Dans l'historique aplati ils sont relus a chaque tour : on
// les retire des anciens messages utilisateur, jamais du dernier (2026-11-16).
const EPHEMERES_HISTORIQUE = /\s*<(memory-context|regles-apprises)>[\s\S]*?<\/\1>/g;
const sansEphemeresHistorique = (t) => String(t || '').replace(EPHEMERES_HISTORIQUE, '').trim();

function buildPrompt(messages) {
  const parts = [];
  const history = messages.slice(0, -1);
  if (history.length) {
    const rendered = history
      .map((m) => {
        let text = extractText(m?.content);
        if (m?.role === 'user') text = sansEphemeresHistorique(text);
        return text ? `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${text}` : '';
      })
      .filter(Boolean)
      .join('\n\n');
    if (rendered) parts.push(`<conversation>\n${rendered}\n</conversation>`);
  }
  const last = extractText(messages[messages.length - 1]?.content);
  if (last) parts.push(last);
  return parts.join('\n\n').trim();
}

/* ------------------------------------------------------------------ */
/* Continuite de session                                               */
/* ------------------------------------------------------------------ */

/*
 * Mesure sur une meme conversation de 3 tours, modele haiku :
 *   historique aplati : cache_creation 10 096 / 10 127 / 10 146 ; cache_read 0
 *   --resume          : cache_creation 10 097 /    204 /    138
 *                       cache_read          0 / 10 097 / 10 301
 *
 * Un prompt aplati est un bloc de texte unique qui grandit par la fin : il n'a
 * qu'un point de cache et son prefixe change a chaque tour, donc rien n'est
 * jamais relu. Tout est reecrit, au tarif creation (6,25 $/M) au lieu du tarif
 * lecture (0,50 $/M). En laissant le CLI tenir l'historique, on ne lui envoie
 * que le dernier message et il pose ses propres points de cache.
 */
const RESUME_ACTIF = process.env.CLAUDE_RESUME !== '0';
const SESSIONS_MAX = Number(process.env.CLAUDE_SESSIONS_MAX) || 2000;
const SESSION_TTL_MS = Number(process.env.CLAUDE_SESSION_TTL_MS) || 6 * 60 * 60 * 1000;
const SESSION_TOURS_MAX = Number(process.env.CLAUDE_SESSION_TOURS_MAX) || 200;
/** Messages d'outils du CLI tolerables entre deux appels avant d'abandonner le chainage. */
const SAUT_MAX = Number(process.env.CLAUDE_SAUT_MAX) || 120;

/** cle = empreinte du tableau `messages` tel qu'il etait au tour precedent. */
const sessions = new Map();

/*
 * Persistance des chainons de session.
 *
 * La Map ci-dessus vivait en RAM seule : chaque redemarrage du proxy (frequent,
 * via hermes-reload-notifs) cassait TOUTES les chaines --resume en cours. Le
 * tour suivant repartait en session neuve et repayait l'historique entier au
 * tarif cache_create (6,25 $/M au lieu de 0,50 $/M en lecture).
 *
 * Les journaux du CLI, eux, survivent sur disque (~/.claude/projects). L'id de
 * session reste donc valide apres un redemarrage : seule la table de
 * correspondance manquait. On l'ecrit a cote.
 */
const SESSIONS_FICHIER = process.env.CLAUDE_SESSIONS_FICHIER
  || `${process.env.HOME}/.hermes/claude-proxy-sessions.json`;
let sauvegardePlanifiee = null;

function chargerSessions() {
  try {
    const brut = JSON.parse(readFileSync(SESSIONS_FICHIER, 'utf8'));
    if (!Array.isArray(brut)) return;
    const limite = Date.now() - SESSION_TTL_MS;
    let n = 0;
    for (const item of brut) {
      if (!item || !item.entry || !Array.isArray(item.cles)) continue;
      if (!(item.entry.ts > limite)) continue;
      // `busy` ne survit pas a un redemarrage : le process CLI est mort.
      const entry = { ...item.entry, busy: false };
      for (const cle of item.cles) sessions.set(cle, entry);
      n += 1;
    }
    if (n) console.log(`[sessions] ${n} chainons repris depuis le disque`);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[sessions] lecture impossible :', e.message);
  }
}

function sauverSessions() {
  // Une entree porte plusieurs cles : on regroupe pour ne pas dupliquer.
  const parEntry = new Map();
  for (const [cle, e] of sessions) {
    if (!parEntry.has(e)) parEntry.set(e, []);
    parEntry.get(e).push(cle);
  }
  // Les sessions en plein tour ne sont plus indexees : on les reinjecte sous
  // leurs clefs de depart, sinon un arret en cours de tour les perd.
  for (const [entry, cles] of enCours) if (!parEntry.has(entry) && cles.length) parEntry.set(entry, cles);
  const brut = [];
  for (const [entry, cles] of parEntry) brut.push({ cles, entry: { ...entry, busy: false } });
  try {
    const tmp = `${SESSIONS_FICHIER}.tmp`;
    writeFileSync(tmp, JSON.stringify(brut));
    renameSync(tmp, SESSIONS_FICHIER);
  } catch (e) {
    console.error('[sessions] ecriture impossible :', e.message);
  }
}

/** Ecriture differee : un tour en rafale n'ecrit qu'une fois. */
function planifierSauvegarde() {
  if (sauvegardePlanifiee) return;
  sauvegardePlanifiee = setTimeout(() => {
    sauvegardePlanifiee = null;
    sauverSessions();
  }, 2000);
  if (typeof sauvegardePlanifiee.unref === 'function') sauvegardePlanifiee.unref();
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { try { sauverSessions(); } catch (_) {} try { ecrireCumuls(); } catch (_) {} process.exit(0); });
}

const SEP_ROLE = String.fromCharCode(30);
const SEP_MSG = String.fromCharCode(31);

/*
 * Trois empreintes pour le meme historique, et non une seule.
 *
 * Hermes ajoute au DERNIER message utilisateur, au moment de l'appel, des
 * elements qu'il ne persiste pas : memoire externe, sorties de hooks de
 * plugins (agent/run_agent.py, injection non persistee). Au tour suivant ce
 * meme message revient sans son ajout. Une empreinte exacte casserait donc la
 * chaine a chaque tour, sans erreur visible, juste sans gain.
 *
 * On indexe donc chaque session sous trois cles : l'exacte, une tolerante au
 * suffixe (ajout en fin) et une tolerante au prefixe (ajout en tete). La
 * recherche essaie les trois. Le reste de l'historique, lui, reste hache
 * integralement : c'est lui qui garantit qu'on ne confond pas deux
 * conversations.
 */
const TETE = 200;

/*
 * Normalisation avant hachage.
 *
 * Hermes reinjecte a chaque appel API, dans le message utilisateur du tour
 * courant, des blocs <system-reminder> dont le contenu varie (memoire fraiche,
 * date, etat de session, sorties de hooks). Tant que ce message est le dernier
 * du tableau, la tolerance prefixe/suffixe absorbe la variation. Des que la
 * boucle d'outils avance, il devient un message ANTERIEUR, hache exactement :
 * la chaine casse alors systematiquement au 3e aller-retour du meme tour.
 *
 * On retire donc ces blocs du texte avant de hacher. Ils ne portent aucune
 * information distinguant deux conversations : le reste de l'historique s'en
 * charge.
 */
const BLOCS_VOLATILS = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

function normaliserTexte(texte) {
  return String(texte || '').replace(BLOCS_VOLATILS, '').trim();
}


/*
 * Famille d'une conversation : empreinte du debut du prompt systeme.
 *
 * Hermes peut envoyer en meme temps la reponse et le calcul du titre d'un
 * topic, avec le MEME premier message mais deux prompts systeme differents.
 * Des cles qui ne portent que sur les messages font alors reprendre au tour
 * suivant la session du titre, et chaque reponse devient un {"title": ...}.
 * La famille separe les deux chaines.
 */
const FAMILLE_TETE = 1000;

function familleDe(system) {
  return createHash('sha1').update(normaliserTexte(system).slice(0, FAMILLE_TETE))
    .digest('hex').slice(0, 12);
}

function empreinteAvec(messages, mode, famille = '') {
  const h = createHash('sha1');
  h.update(famille);
  h.update(SEP_MSG);
  messages.forEach((m, i) => {
    const dernier = i === messages.length - 1;
    let texte = normaliserTexte(extractText(m && m.content));
    if (dernier && mode === 'prefixe') texte = texte.slice(0, TETE);
    else if (dernier && mode === 'suffixe') texte = texte.slice(-TETE);
    h.update(m && m.role ? m.role : 'user');
    h.update(SEP_ROLE);
    h.update(texte);
    h.update(SEP_MSG);
  });
  h.update(mode);
  return h.digest('hex');
}

function empreinte(messages, famille = '') {
  return empreinteAvec(messages, 'exact', famille);
}

function clesDe(messages, famille = '') {
  if (!messages.length) return [];
  return [
    empreinteAvec(messages, 'exact', famille),
    empreinteAvec(messages, 'suffixe', famille),
    empreinteAvec(messages, 'prefixe', famille),
  ];
}

/*
 * Le dernier message utilisateur est volatil.
 *
 * Mesure : une session stockee avec un dernier message de 1159 caracteres
 * peut se representer au tour suivant avec 185 caracteres pour ce meme
 * message. Hermes enrichit le message courant au moment de l'envoi (contexte de
 * session, rappels) puis n'en garde que le texte nu dans son historique. Toute
 * cle calculee sur ce message casse donc systematiquement au tour suivant.
 *
 * On indexe chaque session sous deux jeux de cles : l'historique complet, et
 * l'historique prive de son dernier message. La recherche par prefixe attrape
 * le second des que le premier a bouge, sans rien perdre du contexte.
 */
function clesEtendues(messages, famille = '') {
  const cles = clesDe(messages, famille);
  if (messages.length > 1) cles.push(...clesDe(messages.slice(0, -1), famille));
  return cles;
}

/*
 * Diagnostic de rupture de chaine.
 *
 * Une empreinte qui ne matche pas ne dit pas POURQUOI. On garde donc, a cote
 * de chaque session, une signature message par message (role, longueur, hash
 * court). Quand la chaine casse, on retrouve la session au plus long prefixe
 * commun et on nomme l'index et la nature du premier ecart.
 */
function signature(messages) {
  return messages.map((m) => {
    const texte = normaliserTexte(extractText(m && m.content));
    const h = createHash('sha1');
    h.update(texte);
    return { r: (m && m.role) || 'user', n: texte.length, h: h.digest('hex').slice(0, 8) };
  });
}

function diagnostiquerRupture(sigAttendue) {
  let meilleur = null;
  for (const e of new Set(sessions.values())) {
    if (!Array.isArray(e.sig)) continue;
    let i = 0;
    while (i < e.sig.length && i < sigAttendue.length
      && e.sig[i].h === sigAttendue[i].h && e.sig[i].r === sigAttendue[i].r) i += 1;
    if (!meilleur || i > meilleur.commun) meilleur = { commun: i, e };
  }
  if (!meilleur || !meilleur.commun) return 'aucune session proche (conversation vraiment neuve)';
  const { commun, e } = meilleur;
  const a = sigAttendue[commun];
  const b = e.sig[commun];
  const base = `proche=${e.id.slice(0, 8)} commun=${commun}/${sigAttendue.length} stocke=${e.sig.length}`;
  if (!a) return `${base} ecart=historique-raccourci`;
  if (!b) return `${base} ecart=historique-rallonge role=${a.r} len=${a.n}`;
  if (a.r !== b.r) return `${base} ecart=role ${b.r}->${a.r}`;
  return `${base} ecart=texte idx=${commun} role=${a.r} len ${b.n}->${a.n}`;
}

function chercherSession(messages, famille = '') {
  for (const cle of clesDe(messages, famille)) {
    const e = sessions.get(cle);
    if (e) return { cle, entry: e };
  }
  return null;
}

/*
 * Repli quand les cles ne retrouvent rien : comparaison message par message,
 * limitee au meme topic, sans la famille.
 *
 * Mesure du 2026-10-05, topic 8164 : apres un /stop, Hermes renvoie le meme
 * historique, mais la tete de son prompt systeme a change (tete4k 1c37fb6f ->
 * 3acf87db). La famille entre dans chaque cle : plus aucune ne matche, et le
 * tour repart en session neuve avec 582 000 caracteres aplatis, sans le
 * travail fait avant le stop.
 *
 * On accepte une session du meme topic dont tout l'historique stocke se
 * retrouve en tete du nouveau, sauf au plus son dernier message utilisateur
 * (la version enrichie, qu'Hermes raccourcit dans son historique). Le nouvel
 * historique doit le contenir encore, sous sa forme courte : un message
 * remplace ou rejoue (/retry, /undo) ne passe donc pas.
 */
/*
 * Appels annexes d'Hermes (2026-10-07).
 *
 * Apres un tour, Hermes lance en fond une revue (memoire, skills) avec le MEME
 * prompt systeme et le MEME historique, plus une consigne. Elle retrouvait donc
 * la session du topic et la reprenait : la chaine passait sous les cles de la
 * revue, et le vrai message suivant de VJ ne la retrouvait plus. Le repli par
 * signature prenait alors une session plus ancienne du meme topic, qui n'avait
 * pas vu les derniers echanges (topic 635, 18:05 : « Oui active » repondu hors
 * contexte). La revue part desormais sur une COPIE de la session
 * (`--fork-session`) et la chaine reste intacte.
 */
const PREFIXES_ANNEXES = [
  'Review the conversation above and update the skill library',
  'Review the conversation above and consider saving to memory',
];
function estAnnexe(texte) {
  const t = String(texte || '').trimStart();
  return PREFIXES_ANNEXES.some((p) => t.startsWith(p));
}

function chercherParSignature(messages, topic) {
  if (!topic || messages.length < 3) return null;
  const sigAttendue = signature(messages.slice(0, -1));
  /*
   * Une session plus ancienne qu'une autre du meme topic n'a pas vu les tours
   * de celle-ci : les reprendre ferait sauter des echanges entiers, compte a
   * tort comme des messages d'outils du CLI. On n'accepte que la plus recente.
   */
  let plusRecent = 0;
  for (const e of new Set(sessions.values())) if (e.topic === topic && e.ts > plusRecent) plusRecent = e.ts;
  let meilleur = null;
  for (const e of new Set(sessions.values())) {
    if (e.topic !== topic || !Array.isArray(e.sig) || e.sig.length < 3) continue;
    if (e.ts < plusRecent) continue;
    if (e.sig.length > sigAttendue.length) continue;
    if (sigAttendue.length - e.sig.length > SAUT_MAX) continue;
    let i = 0;
    while (i < e.sig.length && e.sig[i].h === sigAttendue[i].h && e.sig[i].r === sigAttendue[i].r) i += 1;
    if (i < e.sig.length - 1) continue;
    if (i === e.sig.length - 1) {
      const stocke = e.sig[i];
      const recu = sigAttendue[i];
      if (stocke.r !== 'user' || recu.r !== 'user' || recu.n > stocke.n) continue;
    }
    if (!meilleur || e.sig.length > meilleur.entry.sig.length) {
      meilleur = { entry: e, saut: sigAttendue.length - e.sig.length };
    }
  }
  return meilleur;
}

/*
 * Purge par entree, pas par cle.
 *
 * Chaque session est indexee sous trois cles. L'ancienne eviction supprimait la
 * cle la plus anciennement INSEREE, ce qui ne correspond a rien : une chaine
 * vivante depuis le matin a ses cles en tete de Map et se faisait evincer avant
 * un sous-agent d'une seconde. On evince desormais l'entree la moins recemment
 * utilisee (ts), et on compte en sessions, pas en cles.
 */
function purgerSessions() {
  const limite = Date.now() - SESSION_TTL_MS;
  for (const [cle, e] of sessions) if (e.ts < limite) sessions.delete(cle);

  const entrees = new Set(sessions.values());
  if (entrees.size <= SESSIONS_MAX) return;
  const triees = [...entrees].sort((a, b) => a.ts - b.ts);
  const aJeter = new Set(triees.slice(0, entrees.size - SESSIONS_MAX).filter((e) => !e.busy));
  if (!aJeter.size) return;
  for (const [cle, e] of sessions) if (aJeter.has(e)) sessions.delete(cle);
  console.log(`[sess] eviction ${aJeter.size} session(s) LRU, reste ${new Set(sessions.values()).size}`);
}

/*
 * Sessions retirees de la Map le temps d'un tour.
 *
 * A la reprise, `oublierSession` desindexe l'entree : pendant toute la duree du
 * tour elle n'existe donc plus dans `sessions`, et une sauvegarde (ou un arret
 * du proxy) la perd DEFINITIVEMENT. C'est ce qui cassait les chaines a chaque
 * redemarrage survenu en plein tour : le tour suivant repartait neuf et
 * repayait l'historique au tarif creation.
 *
 * On garde donc les clefs de depart a cote, et on les persiste. Si le proxy
 * meurt en plein tour, le tour suivant retrouve la chaine du tour precedent.
 */
const enCours = new Map();

// Avec --resume, le CLI rend un cout et un modelUsage CUMULES sur toute la session,
// alors que `usage` est celui du seul tour. On garde le dernier cumul par session
// pour journaliser la difference : sinon chaque tour repris recompte les precedents.
// Persiste sur disque : en memoire seule, le 1er tour repris apres un redemarrage
// journalisait tout le cumul de la session (3 500 $ fantomes sur 7 j, 22/10/2026).
const CUMULS_FICHIER = path.join(os.homedir(), '.hermes', 'proxy-cumuls.json');
const cumulsSession = new Map(Object.entries(lireJson(CUMULS_FICHIER)));
let cumulsPlanifie = null;
function sauverCumuls() {
  if (cumulsPlanifie) return;
  cumulsPlanifie = setTimeout(() => { cumulsPlanifie = null; ecrireCumuls(); }, 2000);
  if (typeof cumulsPlanifie.unref === 'function') cumulsPlanifie.unref();
}
function ecrireCumuls() {
  try {
    const tmp = `${CUMULS_FICHIER}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(cumulsSession)));
    renameSync(tmp, CUMULS_FICHIER);
  } catch (e) { console.error('[cumuls] ecriture impossible :', e.message); }
}
// 500 sessions ne suffisaient pas : le proxy en ouvre 500 a 2 100 par jour, une session
// de topic reprise apres 600 autres etait oubliee et journalisait tout son cumul
// (94 tours faux sur 7 j, 5 357 $ au lieu de ~30 $, mesure du 27/10/2026).
const CUMULS_MAX = 20000;
const CUMULS_AGE_MS = 14 * 24 * 3600 * 1000;
// Poids relatifs des tarifs Anthropic (entree, sortie, cache lu, cache ecrit) : les memes
// pour tous les modeles, ce qui suffit pour une regle de trois.
function poidsUsage(entree, sortie, lu, ecrit) {
  return (entree || 0) + 5 * (sortie || 0) + 0.1 * (lu || 0) + 1.25 * (ecrit || 0);
}
function deltaSession(sid, total, parModele, reprise = false, usageTour = null) {
  const avant = sid ? cumulsSession.get(sid) : null;
  if (sid) {
    const maintenant = Date.now();
    cumulsSession.delete(sid);
    cumulsSession.set(sid, { total, parModele: JSON.parse(JSON.stringify(parModele)), t: maintenant });
    for (const [cle, e] of cumulsSession) {
      if (cumulsSession.size <= CUMULS_MAX && maintenant - (e.t || 0) < CUMULS_AGE_MS) break;
      cumulsSession.delete(cle);
    }
    sauverCumuls();
  }
  if (!avant) {
    if (!reprise || !usageTour) return total;
    // Session reprise sans cumul connu : le total est celui de toute la session. On garde
    // la part du tour, au prorata de ses tokens (usage du tour) sur ceux de la session.
    let cumul = 0;
    for (const v of Object.values(parModele)) cumul += poidsUsage(v.entree, v.sortie, v.cache_lu, v.cache_ecrit);
    const tourPoids = poidsUsage(usageTour.input_tokens, usageTour.output_tokens,
      usageTour.cache_read_input_tokens, usageTour.cache_creation_input_tokens);
    const ratio = cumul > 0 ? Math.min(1, tourPoids / cumul) : 1;
    for (const v of Object.values(parModele)) for (const k of Object.keys(v)) v[k] = v[k] * ratio;
    return total * ratio;
  }
  for (const [m, v] of Object.entries(parModele)) {
    const p = avant.parModele[m];
    if (!p) continue;
    for (const k of Object.keys(v)) v[k] = Math.max(0, v[k] - (p[k] || 0));
  }
  return Math.max(0, total - avant.total);
}

function oublierSession(entry) {
  for (const [cle, e] of sessions) if (e === entry) sessions.delete(cle);
}

/**
 * Decide si ce tour peut reprendre une session CLI existante.
 *
 * Le chainon est exact : au tour suivant, Hermes renvoie le meme tableau plus
 * la reponse de l'assistant et le nouveau message. L'historique prive de ses
 * deux derniers elements est donc, caractere pour caractere, le tableau du tour
 * passe. Aucune dependance au texte rendu, aucune collision possible.
 *
 * Si Hermes compacte ou reecrit son historique, la chaine casse d'elle-meme et
 * on repart sur une session neuve avec le prompt aplati : c'est le repli voulu,
 * pas une panne.
 */
function promptElague(messages, promptAplati) {
  const el = elaguerResultatsOutils(messages);
  if (el === messages) return promptAplati;
  const court = buildPrompt(el);
  if (court.length < promptAplati.length) {
    console.log(`[elag] demarrage a froid : prompt ${promptAplati.length} -> ${court.length} car`);
    return court;
  }
  return promptAplati;
}

function planifierSession(messages, promptAplati, imagesAplati, dossier, system = '') {
  if (!RESUME_ACTIF) return null;
  const famille = familleDe(system);
  purgerSessions();

  const dernier = messages[messages.length - 1];
  const avantDernier = messages[messages.length - 2];
  /*
   * Le CLI boucle sur ses propres outils a l'interieur d'UN seul appel proxy.
   * Hermes range ensuite tous ces messages intermediaires dans son historique.
   * L'ecart entre deux appels successifs n'est donc pas de 2 messages mais de
   * 2 + le nombre de messages d'outils produits par le CLI. Un chainage fige a
   * -2 ne retrouvait la session que sur les tours sans aucun outil, c'est-a-dire
   * presque jamais.
   *
   * On cherche donc le plus long prefixe qui correspond a une session connue.
   * Tout ce qui suit ce prefixe (hors dernier message) a ete produit par le CLI
   * lui-meme : il l'a deja dans son journal, on ne le renvoie pas.
   */
  let trouve = null;
  let saut = 0;
  const profondeurMax = Math.min(SAUT_MAX + 2, messages.length - 1);
  for (let k = 2; k <= profondeurMax; k += 1) {
    const c = chercherSession(messages.slice(0, -k), famille);
    if (c) { trouve = c; saut = k - 2; break; }
  }
  const topic = topicDe(system);
  let parSignature = false;
  if (!trouve) {
    const repli = chercherParSignature(messages, topic);
    if (repli) { trouve = repli; saut = repli.saut; parSignature = true; }
  }
  const entry = trouve ? trouve.entry : null;
  const texte = extractText(dernier && dernier.content);
  const imagesDernier = extractImages([dernier]);

  const reprenable = Boolean(
    entry && !entry.busy
    && entry.tours < SESSION_TOURS_MAX
    /*
     * Le journal d'une session CLI vit sous ~/.claude/projects/<dossier encode>.
     * Reprendre depuis un AUTRE dossier ne le retrouve pas : le CLI repart
     * muet, sans erreur visible. Quand le topic change de projet en cours de
     * route, on repart donc sur une session neuve, avec l'historique aplati
     * que Hermes renvoie de toute facon : rien n'est perdu, seul le cache de
     * prefixe est repaye une fois.
     */
    && entry.dir === dossier
    && avantDernier && avantDernier.role === 'assistant'
    && (texte || imagesDernier.length),
  );

  if (reprenable && estAnnexe(texte)) {
    console.log(`[sess] annexe : copie de ${entry.id} (--fork-session), chaine intacte`);
    return {
      entry: { id: entry.id, tours: entry.tours, ts: Date.now(), dir: dossier, topic },
      annexe: true,
      topic,
      args: ['--resume', entry.id, '--fork-session'],
      prompt: texte,
      images: imagesDernier,
      cles: [],
      sig: null,
    };
  }

  if (reprenable) {
    const clesDepart = [...sessions].filter(([, e]) => e === entry).map(([c]) => c);
    oublierSession(entry);
    enCours.set(entry, clesDepart);
    entry.busy = true;
    console.log(`[sess] reprise ${entry.id} tour ${entry.tours + 1} : ${texte.length} car au lieu de ${promptAplati.length}${saut ? ` (saut=${saut} msgs d'outils du CLI)` : ''}${parSignature ? ' (repli signature, topic ' + topic + ')' : ''}`);
    return {
      entry,
      topic,
      args: ['--resume', entry.id],
      prompt: texte,
      images: imagesDernier,
      cles: clesEtendues(messages, famille),
      sig: signature(messages),
    };
  }

  const neuve = {
    id: randomUUID(), tours: 0, busy: true, ts: Date.now(), dir: dossier, topic,
  };
  let motif;
  if (messages.length < 3) motif = 'debut-conversation';
  else if (!entry) {
    const essais = [];
    for (let k = 2; k <= profondeurMax; k += 1) {
      const cs = clesDe(messages.slice(0, -k), famille);
      essais.push(`${k}:${cs.map((c) => (sessions.has(c) ? '1' : '0')).join('')}`);
    }
    motif = `chaine-introuvable ${diagnostiquerRupture(signature(messages.slice(0, -2)))} cles=${sessions.size} essais=${essais.slice(0, 6).join(',')}`;
  }
  else if (entry.dir !== dossier) motif = `dossier-change ${entry.dir} -> ${dossier}`;
  else if (entry.busy) motif = 'session-occupee';
  else if (entry.tours >= SESSION_TOURS_MAX) motif = 'plafond-tours';
  else if (!avantDernier || avantDernier.role !== 'assistant') motif = `avant-dernier=${avantDernier ? avantDernier.role : 'absent'}`;
  else motif = 'dernier-message-vide';
  console.log(`[sess] neuve ${neuve.id} motif=${motif} msgs=${messages.length}`);
  return {
    entry: neuve,
    topic,
    args: ['--session-id', neuve.id],
    prompt: promptElague(messages, promptAplati),
    images: imagesAplati,
    cles: clesEtendues(messages, famille),
    sig: signature(messages),
  };
}

function validerSession(sess) {
  if (!sess || sess.annexe) return;
  enCours.delete(sess.entry);
  sess.entry.busy = false;
  sess.entry.tours += 1;
  sess.entry.ts = Date.now();
  if (Array.isArray(sess.sig)) sess.entry.sig = sess.sig;
  // Les sessions anterieures au repli par signature n'ont pas de topic.
  if (sess.topic) sess.entry.topic = sess.topic;
  for (const cle of sess.cles) sessions.set(cle, sess.entry);
  planifierSauvegarde();
}

/**
 * Le tour a echoue : on jette la session. Le CLI a peut-etre deja ecrit le
 * message utilisateur dans son journal, reprendre dessus le dupliquerait.
 */
function abandonnerSession(sess) {
  if (!sess || sess.annexe) return;
  enCours.delete(sess.entry);
  sess.entry.busy = false;
  oublierSession(sess.entry);
}

/* Refus : la session qui en a produit un est brulee. Le tour suivant repart
 * d'une session neuve, sinon l'historique du blocage fait refuser toute
 * reformulation (prouve le 2026-11-08 sur le WiFi). */
const REFUS_RE = /je ne peux pas|impossible de|cannot verify|can't (verify|access)|peux-tu (me )?(confirmer|preciser)|je ne (peux|vais) pas (aider|participer)|filtre de s(é|e)curit(é|e)/i;
const LOG_REFUS = '/home/vj/.hermes/logs/refus-topics.log';

function estimateTokens(text) {
  return Math.max(1, Math.ceil((text || '').length / 4));
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODEL_OK = /^(claude-[a-z0-9.-]+|opus|sonnet|haiku|fable)(\[1m\])?$/i;

// Fable n'est voulu nulle part (VJ, 2026-10-04) : le topic Phone y etait reste
// accroche par un /model oublie, 433 etapes en un jour. Tout appel Fable part en Opus.
const MODELE_INTERDIT = /fable/i;
const MODELE_REPLI = 'claude-opus-4-8';

function sansModeleInterdit(name) {
  if (!MODELE_INTERDIT.test(name)) return name;
  console.warn(`[modele] ${name} refuse, remplace par ${MODELE_REPLI}`);
  return MODELE_REPLI;
}

// Toujours la derniere version de chaque famille (VJ, 2026-10-28) : un appel
// haiku, sonnet ou opus d'une version ancienne (4-5, 4-6, 3-7, alias nu...)
// part sur la version courante. Le suffixe [1m] est garde.
const DERNIERE_VERSION = [
  [/haiku/i, 'claude-haiku-5-5'],
  [/sonnet/i, 'claude-sonnet-5-5'],
  [/opus/i, 'claude-opus-4-8'],
];

// Exception voulue par VJ (2026-10-28) : Opus 4.8 reste choisissable.
const VERSION_GARDEE = /^claude-opus-4-8$/i;

function derniereVersion(name) {
  const fin = name.endsWith('[1m]') ? '[1m]' : '';
  const base = fin ? name.slice(0, -fin.length) : name;
  if (VERSION_GARDEE.test(base)) return name;
  for (const [famille, courant] of DERNIERE_VERSION) {
    if (!famille.test(base)) continue;
    if (base.toLowerCase() === courant) return name;
    console.warn(`[modele] ${name} ancien, remplace par ${courant}${fin}`);
    return courant + fin;
  }
  return name;
}

// Garde-fou de modele pour Prime Agent. COUPE par defaut : VJ garde Prime en
// Opus effort medium (2026-10-04). `PRIME_MODELE=sonnet` le rallume : tout appel
// `-toolrelay` plus lourd que Sonnet (sous-agents `rlm.spawn(model=...)` et
// compactage compris) est alors ramene a ce modele.
const PRIME_MODELE = process.env.PRIME_MODELE ?? '';
const PRIME_TROP_LOURD = /opus|fable/i;

function modelePrime(name) {
  if (!PRIME_MODELE || !PRIME_TROP_LOURD.test(name)) return name;
  console.warn(`[modele] Prime ${name} ramene a ${PRIME_MODELE}`);
  return PRIME_MODELE;
}

// Hermes connait deux niveaux que le CLI ignore : "minimal" et "ultra".
const EFFORT_ALIASES = { minimal: 'low', ultra: 'max' };

function normalizeEffort(value) {
  const level = String(value || '').trim().toLowerCase();
  if (!level) return '';
  const mapped = EFFORT_ALIASES[level] || level;
  return EFFORTS.includes(mapped) ? mapped : '';
}

/**
 * Ancien format de thinking : un budget de tokens au lieu d'un niveau.
 * Les seuils suivent les paliers qu'Hermes utilise dans THINKING_BUDGET.
 */
function effortFromBudget(budget) {
  const n = Number(budget);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n <= 2048) return 'low';
  if (n <= 8000) return 'medium';
  if (n <= 16000) return 'high';
  if (n <= 32000) return 'xhigh';
  return 'max';
}

/**
 * Resout le modele et le niveau d'effort a passer au CLI.
 *
 * `/reasoning` sur Telegram arrive ici sous forme de `output_config.effort`
 * (modeles adaptatifs) ou de `thinking.budget_tokens` (anciens modeles).
 * Le suffixe du nom de modele reste accepte comme repli manuel :
 * `/model claude-opus-5-high` marche meme si /reasoning n'est pas positionne.
 *
 * Priorite : output_config > thinking > suffixe du modele > CLAUDE_EFFORT.
 */
function parseModelSpec(model, body = {}) {
  // Suffixe `@nom` : compte Claude a utiliser (comptes.js). Retire en premier,
  // les autres suffixes (-notools, -high...) se lisent ensuite comme avant.
  const { model: sansCompte, compte } = comptes.separer(model);
  let name = sansCompte;
  let suffixEffort = '';

  // Suffixe `-notools` : la cible repond en texte seul, sans aucun outil.
  // Utilise par PyRIT pour que la cible ne modifie pas la machine.
  // Suffixe `-toolrelay` : le client declare ses outils et veut les executer
  // lui-meme. Tout le mecanisme vit dans tool-relay.js. Hermes n'envoie jamais
  // ce suffixe, son trafic ne croise donc jamais ce code.
  const relais = toolRelay.detecter(name);
  // Relais par topic (2026-10-10) : un topic Hermes liste dans
  // ~/.hermes/topics-relais.json passe en relais sans changer son modele.
  // Hermes y retrouve sa propre boucle d'outils (budget, kanban, todo,
  // delegate_task, cron). Seulement si des outils sont declares : le
  // compactage d'Hermes, sans outils, reste sur le chemin normal.
  let parTopic = false;
  if (!relais.actif && Array.isArray(body.tools) && body.tools.length
      && topicEnRelais(extractText(body.system))) {
    relais.actif = true;
    parTopic = true;
  }
  if (relais.actif) name = relais.model;

  let noTools = false;
  // Relais demande, mais aucun outil declare : c'est le compactage du client
  // (Prime Agent resume son historique sans outils). Avant le 2026-10-03, le
  // relais refusait en 400 : 512 echecs en 7 j, l'historique de Prime n'etait
  // jamais resume et chaque session repartait a ~313k tokens. On repond donc
  // en texte seul, comme `-notools`.
  let relaisActif = relais.actif;
  if (relaisActif && !(Array.isArray(body.tools) && body.tools.length)) {
    relaisActif = false;
    noTools = true;
  }
  if (name.toLowerCase().endsWith('-notools')) {
    noTools = true;
    name = name.slice(0, -'-notools'.length);
  }
  // Echappatoire de la regle « anonyme-court » (voir CONSIGNE_COURTE) : un
  // appelant anonyme qui veut vraiment le socle d'outils le demande par ce
  // suffixe. Se nommer (`systemd:<nom>`) reste la voie normale.
  let outilsVoulus = false;
  if (name.toLowerCase().endsWith('-tools')) {
    outilsVoulus = true;
    name = name.slice(0, -'-tools'.length);
  }

  for (const level of EFFORTS) {
    if (name.toLowerCase().endsWith(`-${level}`)) {
      suffixEffort = level;
      name = name.slice(0, -(level.length + 1));
      break;
    }
  }

  // thinking.type "enabled"/"adaptive" = actif ; tout le reste desactive.
  const thinking = body.thinking;
  const thinkingOff = thinking && thinking.type && !['enabled', 'adaptive'].includes(thinking.type);

  const effort = thinkingOff
    ? ''
    : normalizeEffort(body.output_config?.effort)
      || effortFromBudget(thinking?.budget_tokens)
      || suffixEffort
      || normalizeEffort(process.env.CLAUDE_EFFORT);

  // Le nom exact choisi par le client prime sur toute ancienne règle de réécriture.
  const requestedModel = name;
  const resolvedModel = MODEL_OK.test(name) ? name : '';
  const modelWarning = '';
  return {
    model: resolvedModel,
    requestedModel,
    modelWarning,
    effort,
    noTools,
    outilsVoulus,
    relais: relaisActif,
    // Seul Prime Agent envoie `-toolrelay` : ses appels (compactage compris)
    // sortent sous leur propre source dans proxy-usage.jsonl.
    client: parTopic ? 'hermes-relais' : (relais.actif ? 'prime' : ''),
    appelant: appelantDe(body),
    compte,
  };
}

// Un script lance par une unite systemd (timer) se nomme dans metadata.user_id,
// `systemd:<unite>`, champ standard que le routeur relaie. Sans lui, le journal
// ne disait pas quel timer consommait (2026-10-22).
function appelantDe(body) {
  const u = body?.metadata?.user_id;
  const m = typeof u === 'string' && /^systemd:([\w@.-]{1,80})$/.exec(u);
  if (m) return m[1];
  // Un agent Hermes lance par l'API locale (/v1/runs) ne peut pas poser
  // metadata.user_id : sa consigne porte `[appelant:<nom>]` (2026-10-26,
  // fiche Routines du dashboard, appelant dash-routine).
  const sys = Array.isArray(body?.system)
    ? body.system.map((b) => (b && b.text) || '').join('\n')
    : (typeof body?.system === 'string' ? body.system : '');
  const a = /\[appelant:([\w@.-]{1,80})\]/.exec(sys);
  return a ? a[1] : null;
}

/* ------------------------------------------------------------------ */
/* Execution du CLI                                                    */
/* ------------------------------------------------------------------ */

// Re-essayer sur ces pannes-la ne sert a rien : elles ne guerissent pas seules.
const FATAL_PATTERNS = [
  /not logged in/i,
  /please run \/login/i,
  /authentication_failed/i,
  /invalid api key/i,
  /credit balance/i,
  /out of extra usage/i,
];

// Le CLI ecrit sur stderr des avertissements qui ne sont PAS des pannes :
// dossier non marque comme fiable, warnings de Node, mises a jour. Quand ils
// etaient le seul contenu de stderr, ils remplacaient le vrai message d'erreur
// et Hermes affichait "trust dialog" pour une panne de quota, un faux motif
// frequent parmi les echecs d'agents.
const STDERR_BENIN = [
  /^Ignoring \d+ permissions\.allow entries from/i,
  /this workspace has not been trusted/i,
  /^\(node:\d+\)/i,
  /ExperimentalWarning|DeprecationWarning|punycode/i,
  /^\s*\(Use `node --trace-warnings/i,
  /npm notice|new version of|update available/i,
];
function stderrUtile(stderr) {
  const restant = String(stderr || '')
    .split('\n')
    .filter((l) => l.trim() && !STDERR_BENIN.some((re) => re.test(l.trim())))
    .join('\n')
    .trim();
  return restant;
}

function isFatal(message) {

  const text = String(message || '');
  return FATAL_PATTERNS.some((re) => re.test(text));
}

// Refus de CONTENU du modele (pas une panne technique). Le CLI le remonte via
// result.is_error, mais c'est une reponse legitime : on la renvoie comme texte
// pour que l'appelant (ex PyRIT) la voie comme un BLOQUE, au lieu de planter.
const REFUS_CLI = /can'?t help with this|start a new session|can'?t help you with that/i;
function estRefusContenu(message) {
  return REFUS_CLI.test(String(message || ''));
}

const health = {
  startedAt: new Date().toISOString(),
  lastSuccessAt: null,
  lastFailureAt: null,
  lastFailure: null,
  consecutiveFailures: 0,
  totalCalls: 0,
  totalRetries: 0,
  totalFailures: 0,
  modelPolicy: 'exact-requested-model-no-rewrite',
  automaticPromptAdditions: false,
  cacheControl: {
    mode: 'cli-managed',
    endToEnd: false,
    warning: 'Le proxy conserve cache_control dans le JSON reçu, mais le CLI Claude ne propose pas de transport documenté pour le transmettre de bout en bout; cache CLI non garanti.',
  },
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Les outils que le CLI expose a Hermes. Toute entree ajoutee ici est payee
// en contexte a CHAQUE appel : ne rajouter qu'un outil reellement appele.
const OUTILS_HERMES = process.env.CLAUDE_OUTILS
  || 'Bash,Read,Write,Edit,WebSearch,WebFetch,Agent,Skill,ToolSearch';

/**
 * Lance `claude -p` en stream-json et appelle onText a chaque bloc de texte.
 * Le prompt part par stdin : un historique long depasserait ARG_MAX.
 */
/*
 * Groupage des appels d'outils.
 *
 * Mesure sur des allers-retours API reels : la grande majorite ne portent
 * qu'UN seul appel d'outil, moyenne proche de 1. Or chaque aller-retour relit
 * tout le contexte du tour (median 53 k de socle + prompt, avant
 * accumulation). Le nombre de boucles est donc le multiplicateur de toute la
 * facture : grouper les appels d'un meme message evite une bonne part des
 * boucles inutiles.
 *
 * Deux appels independants dans le MEME message ne coutent qu'une boucle.
 */
/**
 * Cibles `-notools` : le modele fabrique parfois la syntaxe d'appel d'outil en
 * TEXTE (`<invoke name="Bash">...`), faute d'outil reel pour la porter. Ce
 * texte partait tel quel dans Telegram. On la retire a la source, cote proxy :
 * c'est le seul point que toutes les cibles sans outils traversent.
 */
// Chaque balise doit s'apparier avec SA propre fermeture : une alternation
// commune faisait fermer un `<invoke>` sur un `</parameter>`, et laissait
// filtrer la commande. On retire donc du plus interne vers le plus externe.
const BLOCS_OUTIL = ['parameter', 'invoke', 'function_calls'].map(
  (b) => new RegExp(`<(?:antml:)?${b}\\b[\\s\\S]*?<\\/(?:antml:)?${b}>`, 'gi'),
);
const RE_OUVERTURE_OUTIL = /<(?:antml:)?(?:function_calls|invoke|parameter)\b/i;
const RE_BALISE_ORPHELINE = /<\/?(?:antml:)?(?:function_calls|invoke|parameter)\b[^>]*>?/gi;

function sansBlocsOutil(texte) {
  let t = texte;
  let avant;
  do {
    avant = t;
    for (const re of BLOCS_OUTIL) t = t.replace(re, '');
  } while (t !== avant);
  return t;
}

function sansBalisesOutil(texte) {
  if (!texte) return texte;
  let t = sansBlocsOutil(texte);
  // Une ouverture qui subsiste = un appel jamais referme : tout ce qui suit
  // appartient a l'appel, y compris la commande. On coupe jusqu'a la fin.
  const ouvert = t.search(RE_OUVERTURE_OUTIL);
  if (ouvert >= 0) t = t.slice(0, ouvert);
  return t.replace(RE_BALISE_ORPHELINE, '').replace(/\n{3,}/g, '\n\n').trimEnd();
}

/**
 * Meme nettoyage, mais sur un flux : une balise arrive en plusieurs morceaux.
 * On retient donc la queue tant qu'elle peut encore devenir une balise.
 */
function filtreOutilStream() {
  let tampon = '';
  return {
    push(morceau) {
      tampon = sansBlocsOutil(tampon + morceau);
      const ouvert = tampon.search(RE_OUVERTURE_OUTIL);
      if (ouvert >= 0) { const avant = tampon.slice(0, ouvert); tampon = tampon.slice(ouvert); return avant; }
      const i = tampon.lastIndexOf('<');
      if (i >= 0 && tampon.length - i < 24) { const avant = tampon.slice(0, i); tampon = tampon.slice(i); return avant; }
      const tout = tampon; tampon = ''; return tout;
    },
    fin() { const t = sansBalisesOutil(tampon); tampon = ''; return t; },
  };
}

// La carte generale (contexte/INDEX.md) arrivait 2 fois a chaque etape : recopiee
// par synchroniser.sh dans SOUL.md, donc dans le prompt systeme d'Hermes, et
// importee par ~/.claude/CLAUDE.md, que le CLI charge de toute facon. 3,9 k
// tokens relus pour rien a chaque etape, et la copie de SOUL.md etait en retard
// (2026-10-04). On retire le bloc ici, sur le seul chemin qui passe par le CLI :
// un modele servi sans CLI garde sa carte.
const BLOC_CONTEXTE = /<!-- CONTEXTE:DEBUT[\s\S]*?<!-- CONTEXTE:FIN -->\n?/;
function sansBlocContexte(texte) {
  return texte.replace(BLOC_CONTEXTE, '');
}

// Consignes d'Hermes sans objet sous le CLI (mesure du 2026-10-27, ~640 tokens
// par etape) : « Parallel tool calls » double la directive de groupage et la
// section « Economie de contexte » ; « Async handoff » parle de delegate_task,
// absent de OUTILS_HERMES (0 appel en 7 jours). Retirees seulement sur le
// chemin avec outils. « Mid-turn user steering » et « Skill Safety Rule »
// restent : leurs marqueurs peuvent encore arriver par Hermes.
const CONSIGNES_SANS_OBJET = [
  /# Parallel tool calls\n[\s\S]*?When in doubt and the calls are independent, batch them\.\n\n?/,
  /# Async handoff\n[\s\S]*?before it is delivered\.\n\n?/,
];
function sansConsignesSansObjet(texte) {
  return CONSIGNES_SANS_OBJET.reduce((t, re) => t.replace(re, ''), texte);
}


/*
 * Messages en plein tour (steer). Le CLI lance en `--input-format stream-json`
 * lit stdin tant qu'il reste ouvert : un message utilisateur ecrit pendant le
 * tour est lu au prochain resultat d'outil, dans le MEME tour. Ecrit apres le
 * `result`, il ouvre un tour de plus dans le meme process. Le proxy garde donc
 * stdin ouvert et ne le ferme qu'au `result` qui suit le dernier message lu
 * (le CLI le renvoie, grace a --replay-user-messages, au moment ou il le lit).
 * Cle : le topic Telegram, tire du prompt systeme. POST /steer y ecrit.
 */
const STEER_ACTIF = process.env.PROXY_STEER !== '0';
const pilotables = new Map();

function texteSteer(texte) {
  return `[Message de VJ arrive PENDANT le tour en cours]\n${texte}\n[/Message]\n`
    + "S'il corrige ou precise la tache en cours, change de cap tout de suite. "
    + "S'il est independant, lance-le en parallele (sous-agent en arriere-plan) "
    + 'sans abandonner la tache en cours, puis reponds aux deux.';
}

/*
 * 2026-10-07, topic Marwell 2 : VJ ecrit « ne fais pas ces recherches » pendant
 * qu'un sous-agent portail tourne au premier plan. Le CLI ne lit stdin qu'au
 * prochain resultat d'outil, donc apres le retour du sous-agent : 15 min de
 * recherche que VJ venait d'annuler. Desormais, un message qui arrive pendant
 * un sous-agent au premier plan coupe le tour (control_request interrupt), puis
 * part comme tour suivant, dans le meme process et la meme session.
 * Teste en CLI reel : l'interruption tue le sous-agent en moins d'une seconde.
 * Le message s'ecrit APRES le `result` de l'interruption : ecrit avant, il est
 * annule avec le tour.
 */
function texteSteerCoupe(texte) {
  return `[Message de VJ arrive PENDANT le tour en cours]\n${texte}\n[/Message]\n`
    + 'Ton sous-agent au premier plan a ete coupe pour que tu lises ce message tout de suite. '
    + "S'il corrige ou annule la tache, applique-le et dis en 1 ligne ce que tu as coupe. "
    + "S'il est independant, relance le sous-agent coupe puis reponds au message.";
}

function estAgentPremierPlan(b) {
  return b?.type === 'tool_use' && (b.name === 'Agent' || b.name === 'Task') && !b.input?.run_in_background;
}

function runClaude({ prompt, system, spec, images, sessionArgs, compte = comptes.choisir(spec?.compte) }, onText, hooks = {}) {
  const onActivity = typeof hooks.onActivity === 'function' ? hooks.onActivity : () => {};
  // Mode PARTIEL (temps reel) : present seulement pour le stream. Emet les deltas
  // texte/raisonnement + les outils token par token, via les events partiels du CLI.
  const onDelta = typeof hooks.onDelta === 'function' ? hooks.onDelta : null;
  // Relais NATIF (stream) : renvoyer les vrais events SSE du CLI tels quels.
  const onEvent = typeof hooks.onEvent === 'function' ? hooks.onEvent : null;
  // Fil en direct d'un tour de mission (cron Hermes, cron/fil_direct.py) : le
  // prompt porte <<FIL-DIRECT>>, on emet alors le journal d'outils pour ce tour
  // seulement. Hermes retire ces lignes du rapport final.
  const trace = STREAM_TRACE || (typeof prompt === 'string' && prompt.includes('<<FIL-DIRECT>>'));
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    // Continuite : --session-id ouvre un journal CLI nomme, --resume le
    // reprend. C'est le CLI qui tient alors l'historique et ses points de
    // cache ; le proxy ne lui passe plus que le dernier message.
    if (Array.isArray(sessionArgs) && sessionArgs.length) args.push(...sessionArgs);
    // Une image ne passe pas par stdin texte : il faut le format d'entree
    // structure, seul moyen de donner des blocs `image` au CLI.
    const avecImages = Array.isArray(images) && images.length > 0;
    // Pilotable : un topic identifie et des outils (sans outils, le tour est
    // un seul appel, il n'y a rien a corriger en route).
    const topicTour = topicDe(system);
    const pilotable = STEER_ACTIF && !!topicTour && !spec?.noTools && !spec?.relaisMcp;
    if (avecImages || pilotable) args.push('--input-format', 'stream-json');
    if (pilotable) args.push('--replay-user-messages');
    if (onDelta || onEvent) args.push('--include-partial-messages');
    if (CLAUDE_SETTINGS) args.push('--settings', CLAUDE_SETTINGS);
    if (spec?.model) args.push('--model', spec.model);
    if (spec?.effort) args.push('--effort', spec.effort);
    // Relais d'outils : les seuls outils visibles sont ceux du client, servis
    // par le serveur MCP que le proxy expose sur lui-meme (tool-relay.js).
    if (spec?.relaisMcp) {
      args.push(...toolRelay.argsCli(spec.relaisMcp, PORT));
    } else if (spec?.noTools) {
      args.push('--tools', '');
      args.push('--mcp-config', '{"mcpServers":{}}', '--strict-mcp-config');
      // Sans cela le CLI charge les fichiers d'instructions locaux.
      args.push('--setting-sources', '');
    } else {
      // Socle reduit. Le toolset complet du CLI coute ~38 000 tokens de
      // contexte AVANT le premier mot, relus a chaque appel. Sur des appels
      // d'outils reels, Hermes n'utilise dans l'ecrasante majorite des cas que
      // Bash, Read, Agent, Edit, ToolSearch, Write, Skill, WebSearch, WebFetch.
      // Tout le reste (Glob, Grep, TodoWrite, NotebookEdit, BashOutput...) et
      // les outils MCP n'ont jamais servi ou presque. Restreindre ramene le
      // socle a environ 24 000 tokens, une bonne part economisee par appel.
      args.push('--tools', OUTILS_HERMES);
      args.push('--mcp-config', '{"mcpServers":{}}', '--strict-mcp-config');
    }
    let hTout = '';
    let hTete = '';
    if (system) {
      // Une reprise ne doit pas réutiliser l'ancien instantané contenant les injections supprimées.
      args.push('--system-prompt-snapshot', 'off');
      // Diagnostic cache : le system prompt est le PREMIER bloc mis en cache par
      // le CLI. S'il change d'un tour a l'autre, tout ce qui suit est invalide,
      // meme avec une session --resume qui reprend correctement. Hermes
      // recalcule a chaque tour un bloc "ephemeral" (contexte de session) qu'il
      // colle au prompt systeme stable : on trace donc separement l'empreinte
      // du tout et celle des 4 premiers kilo-octets.
      hTout = createHash('sha1').update(system).digest('hex').slice(0, 8);
      hTete = createHash('sha1').update(system.slice(0, 4000)).digest('hex').slice(0, 8);
      console.log(`[sys] len=${system.length} tout=${hTout} tete4k=${hTete}`);
      // Garder les instructions du client, sans suffixe automatique du proxy.
      const base = sansBlocContexte(system);
      const consigne = nettoyer(base);
      // Le noyau limite UN argument d'exec a MAX_ARG_STRLEN = 32 pages, soit
      // 131072 octets, quel que soit ARG_MAX. Au-dela, spawn echoue en E2BIG
      // et le tour est perdu apres 3 tentatives identiques. C'est arrive des
      // qu'une grosse bibliotheque de documents (148 Ko) a ete injectee dans
      // le prompt systeme. On bascule donc sur --system-prompt-file, que le
      // CLI accepte. Le fichier est nomme d'apres l'empreinte du contenu :
      // deux tours au meme prompt reutilisent le meme fichier, ce qui ne
      // perturbe pas le cache et evite d'en accumuler un par requete.
      const consigneFiltree = consigne;
      const OCTETS = Buffer.byteLength(consigneFiltree, 'utf8');
      if (OCTETS > 120000) {
        const empreinte = createHash('sha1').update(consigneFiltree).digest('hex').slice(0, 16);
        const chemin = path.join(DOSSIER_PROMPTS, `${empreinte}.txt`);
        mkdirSync(DOSSIER_PROMPTS, { recursive: true }); // /tmp est purge apres 10 j : le dossier peut avoir disparu depuis le demarrage
        if (!existsSync(chemin)) writeFileSync(chemin, consigneFiltree, 'utf8');
        console.log(`[sys] ${OCTETS} octets > limite argv, passe par fichier ${empreinte}`);
        args.push('--system-prompt-file', chemin);
      } else {
        args.push('--system-prompt', consigneFiltree);
      }
    }

    const dossier = cwdPourTopic(system);
    if (dossier !== HERE) console.log(`[cwd] ${dossier}`);
    // Marque du tour, heritee par tout ce qu'il lance, meme sous setsid : un
    // /stop retrouve ainsi les process detaches (voir tuerArbre).
    const tour = randomUUID();
    // Appels auxiliaires (titres, resumes, memoire) : contenu a usage unique.
    // Le CLI l'ecrit en cache 1 h, au double du prix d'entree, et rien ne le
    // relit (22/10/2026 : 27M ecrits contre 12,7M lus en 7 jours). En 5 min,
    // l'ecriture coute 1,25 fois et le debut commun reste relu (teste a la main).
    const cache5m = (spec?.client || sourceDe(system, prompt)) === 'auxiliaire'
      ? { FORCE_PROMPT_CACHING_5M: '1' } : {};
    const child = spawn(CLAUDE_BIN, args, {
      cwd: dossier,
      env: {
        ...process.env, HERMES_TOPIC: topicDe(system) || '', HERMES_TOPIC_DIR: dossier, PROXY_TOUR: tour,
        ...cache5m,
        // Jeton du compte choisi (comptes.js) ; sans compte, celui de l'unite.
        ...(compte ? { CLAUDE_CODE_OAUTH_TOKEN: compte.jeton } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      // Groupe de process dedie : voir tuerArbre(). Sans cela, /stop laissait
      // vivre tous les petits-enfants du tour.
      detached: true,
    });
    // L'unite tourne en KillMode=process pour epargner Chrome et le demon
    // OpenCLI, qui vivent dans le meme cgroup. C'est donc au proxy de tuer
    // ses propres enfants a l'arret, sinon ils survivent en orphelins.
    child.tour = tour;
    liveChildren.add(child);
    child.once('close', () => liveChildren.delete(child));

    let buffer = '';
    let stderr = '';
    let full = '';
    // Cible sans outils : le texte peut contenir de la fausse syntaxe d'appel.
    const filtre = spec?.noTools ? filtreOutilStream() : null;
    const propre = (t) => (spec?.noTools ? sansBalisesOutil(t) : t);
    let failure = null;
    let timedOut = false;
    // Journal d'outils compact (une ligne par appel, dedupe).
    let toolEnCours = null;
    let dernierOutil = '';
    // Consommation : evenement `result` du CLI et outils appeles par nom.
    let resultat = null;
    const resultats = [];
    // Pilote du tour : messages ecrits sur stdin et pas encore lus par le CLI.
    // agents : sous-agents au premier plan en cours (ids tool_use). coupure :
    // messages a ecrire des que le `result` de l'interruption est arrive.
    const pilote = pilotable
      ? { child: null, attendus: [], ferme: false, recus: 0, agents: new Set(), coupure: null }
      : null;
    let aSeparer = false;
    let outilDepuisTexte = false;
    const fermerStdin = () => {
      if (!pilote || pilote.ferme) return;
      pilote.ferme = true;
      if (pilotables.get(topicTour) === pilote) pilotables.delete(topicTour);
      try { child.stdin.end(); } catch {}
    };
    const outils = {};
    const skills = {};
    const debut = Date.now();

    // Timeout d'INACTIVITE, pas de mur d'horloge. Un tour qui travaille encore
    // (appels d'outils, texte qui sort) ne doit jamais etre tue : c'est ce qui
    // faisait disparaitre en silence les taches longues mais bien vivantes.
    let timer = null;
    const armerTimeout = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        tuerArbre(child);
        // En relais, le CLI dort pendant que le client execute l'outil :
        // c'est le TTL du relais qui doit couper, pas ce minuteur.
      }, spec?.relaisMcp ? TIMEOUT_RELAIS_MS : TIMEOUT_MS);
    };
    armerTimeout();

    function handleEvent(evt) {
      // --- Stream : texte token par token + JOURNAL COMPACT des outils (une
      // ligne « → Bash: date » par appel, dedupe). On NE relaie PAS les blocs
      // tool_use natifs : Hermes les rejette (outils du CLI != outils Hermes).
      if (onDelta && evt.type === 'stream_event' && evt.event) {
        const e = evt.event;
        if (e.type === 'content_block_start') {
          const cb = e.content_block || {};
          toolEnCours = cb.type === 'tool_use'
            ? { name: cb.name || 'outil', input: '' } : null;
          // Texte d'attente puis reponse, separes par un outil : sans ligne
          // vide ils se collent (« je te reponds.Voici ») et le titre du
          // rapport QG reprend la phrase d'attente.
          if (cb.type === 'tool_use') outilDepuisTexte = true;
          else if (cb.type === 'text' && outilDepuisTexte) { outilDepuisTexte = false; aSeparer = true; }
        } else if (e.type === 'content_block_delta') {
          const d = e.delta || {};
          if (d.type === 'text_delta' && d.text) {
            if (aSeparer) {
              aSeparer = false;
              if (full.trim()) { full += '\n\n'; onDelta('\n\n'); }
            }
            full += d.text;
            const sortie = filtre ? filtre.push(d.text) : d.text;
            if (sortie) onDelta(sortie);
          }
          else if (d.type === 'input_json_delta' && toolEnCours && d.partial_json) {
            toolEnCours.input += d.partial_json;
          }
        } else if (e.type === 'content_block_stop' && toolEnCours && trace) {
          const ligne = ligneOutil(toolEnCours.name, toolEnCours.input);
          if (ligne && ligne !== dernierOutil) { dernierOutil = ligne; onDelta(`${ligne}\n`); }
          toolEnCours = null;
        }
        return;
      }
      if (pilote && !evt.parent_tool_use_id && Array.isArray(evt.message?.content)) {
        for (const b of evt.message.content) {
          if (evt.type === 'assistant' && estAgentPremierPlan(b)) pilote.agents.add(b.id);
          if (evt.type === 'user' && b?.type === 'tool_result') pilote.agents.delete(b.tool_use_id);
        }
      }
      if (pilote && pilote.coupure && evt.type === 'result') {
        // Fin du tour coupe (error_during_execution) : ce n'est pas une panne.
        resultats.push(evt);
        const messages = pilote.coupure;
        pilote.coupure = null;
        pilote.agents.clear();
        aSeparer = true;
        for (const contenu of messages) {
          pilote.attendus.push(contenu);
          child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: contenu } })}\n`);
        }
        console.log(`[steer] topic=${topicTour} tour coupe, ${messages.length} message(s) envoye(s)`);
        return;
      }
      if (pilote && evt.type === 'user' && typeof evt.message?.content === 'string') {
        const i = pilote.attendus.indexOf(evt.message.content);
        if (i !== -1) {
          pilote.attendus.splice(i, 1);
          console.log(`[steer] topic=${topicTour} message lu par le CLI`);
        }
      }
      if (evt.type === 'rate_limit_event' && compte) comptes.noterQuota(compte.nom, evt.rate_limit_info);
      if (evt.type === 'result') {
        resultat = evt;
        resultats.push(evt);
        if (pilote) {
          // Un message ecrit mais pas encore lu ouvrira un tour de plus.
          if (pilote.attendus.length && !evt.is_error) aSeparer = true;
          else fermerStdin();
        }
      }
      if (evt.type === 'assistant' && Array.isArray(evt.message?.content)) {
        for (const b of evt.message.content) {
          if (b?.type !== 'tool_use') continue;
          outils[b.name || 'outil'] = (outils[b.name || 'outil'] || 0) + 1;
          // Skill chargee : par l'outil Skill, ou par lecture de son SKILL.md.
          // Prime lit ses skills par son outil ipython : le chemin est dans input.code
          // (22/10/2026 : 0 ligne prime sur 724 avait un champ skills rempli).
          const chemin = String(b.input?.file_path || b.input?.command || b.input?.code || '');
          const noms = b.name === 'Skill' ? [b.input?.skill]
            : [...chemin.matchAll(/skills\/(?:[^/\s'"]+\/)*?([^/\s'"]+)\/SKILL\.md/g)].map((m) => m[1]);
          for (const nomSkill of new Set(noms)) if (nomSkill) skills[nomSkill] = (skills[nomSkill] || 0) + 1;
        }
      }
      if (evt.type === 'assistant') {
        // Une erreur d'auth ou d'API arrive dans un message assistant marque.
        if (evt.error || evt.is_api_error_message) {
          const msg = extractText(evt.message?.content) || evt.error || 'Erreur du CLI claude.';
          // Refus de contenu (« can't help with this ») : reponse legitime, pas
          // une panne. On la renvoie comme texte au lieu de rejeter.
          if (estRefusContenu(msg)) {
            if (!full) { full = msg; (onDelta || onText)(msg); }
          } else {
            failure = msg;
          }
          return;
        }
        // En stream, le texte est deja parti en deltas : ne pas re-emettre.
        if (onDelta) return;
        // --- Mode non-stream (json, ex. PyRIT) : juste le texte, rien de plus.
        const text = extractText(evt.message?.content);
        if (text) {
          full += (full ? '\n' : '') + text;
          onText(propre(text));
        }
      } else if (evt.type === 'result' && evt.is_error) {
        const msg = evt.result || 'Erreur du CLI claude.';
        if (estRefusContenu(msg)) {
          if (!full) { full = msg; (onDelta || onText)(msg); }
        } else {
          failure = msg;
        }
      }
    }

    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        // Signal de vie : un appel d'outil ne produit aucun texte mais prouve
        // que le CLI travaille. C'est ce qui alimente le keepalive du stream.
        onActivity();
        armerTimeout();
        try {
          handleEvent(JSON.parse(line));
        } catch {
          // Ligne non-JSON (banniere, avertissement) : sans interet ici.
        }
      }
    });

    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(Object.assign(error, { stderr }));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (pilote) { pilote.ferme = true; if (pilotables.get(topicTour) === pilote) pilotables.delete(topicTour); }
      // Plusieurs tours dans le meme process (steer) : additionner leur usage.
      if (resultats.length > 1) {
        const somme = {};
        for (const r of resultats) {
          for (const [k, v] of Object.entries(r.usage || {})) if (typeof v === 'number') somme[k] = (somme[k] || 0) + v;
        }
        resultat = { ...resultat, usage: { ...resultat.usage, ...somme },
          num_turns: resultats.reduce((n, r) => n + (r.num_turns || 0), 0) };
      }
      const u = resultat?.usage || {};
      const parModele = {};
      for (const [m, v] of Object.entries(resultat?.modelUsage || {})) {
        parModele[m] = {
          entree: v.inputTokens || 0, sortie: v.outputTokens || 0,
          cache_lu: v.cacheReadInputTokens || 0, cache_ecrit: v.cacheCreationInputTokens || 0,
          cout_usd: v.costUSD || 0,
        };
      }
      const reprise = Array.isArray(sessionArgs) && sessionArgs.includes('--resume');
      const coutTour = deltaSession(resultat?.session_id, resultat?.total_cost_usd || 0, parModele, reprise, u);
      journaliserUsage({
        ts: new Date(debut).toISOString(),
        ms: Date.now() - debut,
        source: spec?.client || (spec?.appelant ? 'systemd' : sourceDe(system, prompt)),
        appelant: spec?.appelant || null,
        famille: spec?.famille || null,
        topic: topicDe(system) || null,
        tour,
        session: resultat?.session_id || null,
        reprise,
        modele: spec?.model || null,
        effort: spec?.effort || null,
        compte: compte?.nom || null,
        cwd: dossier,
        sys_len: system ? system.length : 0,
        sys_tout: hTout,
        sys_tete: hTete,
        prompt_len: (prompt || '').length,
        entree: u.input_tokens || 0,
        sortie: u.output_tokens || 0,
        cache_lu: u.cache_read_input_tokens || 0,
        cache_ecrit: u.cache_creation_input_tokens || 0,
        cout_usd: coutTour,
        tours_cli: resultat?.num_turns || 0,
        outils,
        skills,
        par_modele: parModele,
        statut: timedOut ? 'timeout' : (failure ? 'erreur' : (resultat ? 'ok' : 'sans_result')),
        code,
        cause: (timedOut || failure || !resultat) ? String(failure || (timedOut ? 'timeout ' + TIMEOUT_MS + ' ms' : '') || (stderr || '').slice(-300) || (code === 143 ? 'SIGTERM (arret externe)' : 'aucun resultat, stderr vide')).replace(/\s+/g, ' ').slice(0, 240) : null,
      });
      if (typeof hooks.onUsage === 'function' && resultat?.usage) hooks.onUsage(resultat.usage);
      if (timedOut) {
        // Du texte a deja ete produit : le rendre vaut mieux que le silence.
        if (full.trim()) {
          resolve(`${propre(full)}\n\n_(coupe : ${Math.round(TIMEOUT_MS / 1000)} s sans activite du CLI)_`);
          return;
        }
        reject(Object.assign(new Error(`Le CLI claude a depasse ${TIMEOUT_MS} ms.`), { timedOut: true, stderr }));
        return;
      }
      if (failure) {
        reject(Object.assign(new Error(failure), { stderr }));
        return;
      }
      // Un refus de contenu fait souvent quitter le CLI avec le code 1 tout en
      // ayant produit le texte du refus : c'est un succes fonctionnel, on ne
      // rejette que si aucun texte n'a ete emis.
      if (code !== 0 && !full.trim()) {
        reject(Object.assign(new Error(`Le CLI claude a quitte avec le code ${code}.`), { stderr }));
        return;
      }
      if (!full.trim()) {
        reject(Object.assign(new Error('Le CLI claude n a produit aucun texte.'), { stderr }));
        return;
      }
      if (filtre) {
        const queue = filtre.fin();
        if (queue && onDelta) onDelta(queue);
      }
      resolve(propre(full));
    });

    child.stdin.on('error', () => {});
    if (avecImages || pilotable) {
      const blocs = [];
      if (prompt) blocs.push({ type: 'text', text: nettoyer(prompt) });
      if (avecImages) blocs.push(...images);
      const ligne = `${JSON.stringify({ type: 'user', message: { role: 'user', content: blocs } })}\n`;
      if (pilote) {
        child.stdin.write(ligne);
        pilote.child = child;
        // Un tour plus recent sur le meme topic prend la main.
        pilotables.set(topicTour, pilote);
      } else {
        child.stdin.end(ligne);
      }
    } else {
      child.stdin.end(nettoyer(prompt));
    }

    // Permet a l'appelant de tuer le process si le client raccroche.
    onText.child = child;
  });
}

/**
 * Relance le CLI quand il echoue sans avoir produit un seul caractere.
 *
 * Une fois du texte emis, on ne rejoue pas : le client a deja recu des deltas
 * et les rejouer produirait une reponse dupliquee. Les pannes d'authentification
 * ne sont pas rejouees non plus, elles ne guerissent pas en 2 secondes.
 */
function messageTousEpuises() {
  const r = comptes.prochainReset();
  return `You've hit your limit on every Claude account (${comptes.liste().length}). `
    + `Reprise vers ${r ? comptes.heureLocale(r) : 'inconnue'}.`;
}

async function runClaudeWithRetry(payload, onText, label, hooks = {}) {
  health.totalCalls += 1;
  let lastError = null;
  // Jeton pose par l'appelant : passe a true des que le client raccroche.
  const abandon = hooks.abandon || null;
  // Compte du tour (comptes.js). null sans comptes.json : jeton de l'unite.
  const essayes = new Set();
  let compte = comptes.choisir(payload.spec?.compte);
  // Apres une bascule, plus de reprise de session : le journal CLI garde le
  // message du tour echoue, et le cache d'un compte ne sert pas a l'autre.
  let sansSession = false;
  if (!compte && comptes.configure()) {
    lastError = Object.assign(new Error(messageTousEpuises()), { tousEpuises: true });
  }

  for (let attempt = 1; !lastError?.tousEpuises && attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (abandon?.actif) {
      lastError = lastError || Object.assign(new Error('Tour abandonne par le client.'), { aborted: true });
      break;
    }
    let emitted = false;
    const guarded = (text) => { emitted = true; onText(text); };
    // Relais du porte-cle. runClaude pose `.child` sur la fonction qu'il recoit,
    // donc sur `guarded` et non sur `onText` : sans ce pont, `onText.child`
    // restait nul et le SIGKILL du client parti ne visait rien. Les logs le
    // disaient a chaque coupure : "fils absent".
    Object.defineProperty(guarded, 'child', {
      configurable: true,
      get: () => onText.child ?? null,
      set: (proc) => {
        onText.child = proc || null;
        // Le fils peut naitre apres le depart du client quand la requete a
        // attendu un creneau : on le tue aussitot, il travaille pour personne.
        if (proc && abandon?.actif) {
          tuerArbre(proc, 'SIGKILL', { toutLeTour: true });
        }
      },
    });
    // En mode partiel, le contenu part via onDelta (pas onText). On marque quand
    // meme `emitted` pour NE PAS retry (et re-emettre) apres avoir deja streame.
    let guardedHooks = hooks;
    if (typeof hooks.onDelta === 'function') {
      guardedHooks = { ...guardedHooks, onDelta: (t) => { emitted = true; hooks.onDelta(t); } };
    }
    if (typeof hooks.onEvent === 'function') {
      guardedHooks = { ...guardedHooks, onEvent: (e) => { emitted = true; hooks.onEvent(e); } };
    }

    // Tentative 1 : on tente la continuite de session. Toute relance repart
    // du prompt aplati, sans session : le journal CLI peut avoir ete souille
    // par la tentative morte, et une reprise y dupliquerait le message.
    const sess = attempt === 1 && !sansSession && payload.sess && !payload.sess.entry.poison
      ? payload.sess : null;
    if (attempt === 1 && payload.sess && payload.sess.entry.poison) abandonnerSession(payload.sess);
    const essai = sess
      ? { ...payload, prompt: sess.prompt, images: sess.images, sessionArgs: sess.args, compte }
      : { ...payload, sessionArgs: null, compte };

    try {
      const text = await runClaude(essai, guarded, guardedHooks);
      if (text && REFUS_RE.test(text)) {
        if (sess) sess.entry.poison = true;
        try { appendFileSync(LOG_REFUS, new Date().toISOString() + ' '
          + (essai.compte?.nom || '?') + ' ' + text.slice(0, 120).replace(/\s+/g, ' ')
          + '\n'); } catch {}
      }
      health.lastSuccessAt = new Date().toISOString();
      health.consecutiveFailures = 0;
      if (sess) validerSession(sess);
      else abandonnerSession(payload.sess);
      return text;
    } catch (error) {
      lastError = error;

      // Quota du compte epuise : on bascule sur le suivant, sans attendre ni
      // consommer de tentative. Seulement si rien n'est parti au client.
      if (compte && !emitted && !abandon?.actif
          && (comptes.estLimite(error.message) || comptes.estLimite(stderrUtile(error.stderr)))) {
        const nouveau = comptes.marquerEpuise(compte.nom, error.message);
        essayes.add(compte.nom);
        const suivant = comptes.choisir('', essayes);
        const reset = comptes.heureLocale(comptes.prochainReset() || Date.now());
        if (suivant) {
          console.warn(`[comptes] ${label} ${compte.nom} a court (reset ${reset}) : bascule sur ${suivant.nom}`);
          if (nouveau) {
            comptes.alerterQg(`Compte Claude « ${compte.nom} » à court, reset vers ${reset}. `
              + `Hermès passe sur « ${suivant.nom} ».`);
          }
          compte = suivant;
          sansSession = true;
          attempt -= 1;
          continue;
        }
        console.warn(`[comptes] ${label} tous les comptes a court (reprise ${reset})`);
        if (nouveau) comptes.alerterQg(`Tous les comptes Claude sont à court. Hermès reprend vers ${reset}.`);
        lastError = Object.assign(new Error(messageTousEpuises()), { tousEpuises: true });
        break;
      }

      const retryable = !emitted && !abandon?.actif && !error.aborted
        && !isFatal(error.message) && !isFatal(stderrUtile(error.stderr));
      if (!retryable || attempt === MAX_ATTEMPTS) break;

      health.totalRetries += 1;
      console.warn(`[retry] ${label} tentative ${attempt}/${MAX_ATTEMPTS} apres: ${error.message.slice(0, 160)}`);
      await sleep(RETRY_DELAYS_MS[attempt - 1] ?? 5_000);
    }
  }

  abandonnerSession(payload.sess);
  health.lastFailureAt = new Date().toISOString();
  health.lastFailure = String(lastError?.message || 'inconnu').slice(0, 300);
  health.consecutiveFailures += 1;
  health.totalFailures += 1;
  throw lastError;
}

/* ------------------------------------------------------------------ */
/* Reponses                                                            */
/* ------------------------------------------------------------------ */

function messageEnvelope({ model, inputTokens }) {
  return {
    id: `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    type: 'message',
    role: 'assistant',
    content: [],
    model: model || 'claude-code-local',
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: 0 },
  };
}

/**
 * Reponse SSE au format Messages. Hermes streame par defaut : sans ces
 * evenements il recoit 0 octet et boucle sur EmptyStreamError.
 * message_start part immediatement pour que le TTFB reste proche de zero
 * meme si le CLI met 10 s a repondre.
 */
async function respondStreaming(res, { prompt, system, spec, images, sess, model, inputTokens, started, queueNotice }) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (event, data) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  send('message_start', { type: 'message_start', message: messageEnvelope({ model, inputTokens }) });
  send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });

  // Avant le moindre token du CLI : pourquoi ce topic a mis du temps a demarrer.
  if (queueNotice) {
    send('content_block_delta', {
      type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: queueNotice },
    });
  }

  const ping = setInterval(() => send('ping', { type: 'ping' }), PING_MS);

  const vol = suivre({
    mode: 'stream',
    modele: spec.model || 'defaut',
    effort: spec.effort || 'defaut',
    // De quoi reconnaitre le chantier d'un coup d'oeil, sans deverser le prompt.
    apercu: String(prompt || '').slice(0, 90).replace(/\s+/g, ' '),
  });

  let lastCliActivity = Date.now();
  let keepaliveSent = 0;
  const keepalive = setInterval(() => {
    if (KEEPALIVE_MAX_SILENCE_MS > 0 && Date.now() - lastCliActivity > KEEPALIVE_MAX_SILENCE_MS) return;
    keepaliveSent += 1;
    send('content_block_delta', {
      type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '' },
    });
  }, KEEPALIVE_MS);

  let outputText = '';
  let child = null;
  let aborted = false;
  // Partage avec runClaudeWithRetry : coupe les relances et tue un fils tardif.
  const abandon = { actif: false };
  // Porte-cle du process fils. runClaudeWithRetry y pose .child au spawn, qui peut
  // arriver bien apres cet appel si la requete passe par la file d'attente.
  const emit = () => {};
  const onClose = () => {
    aborted = true;
    abandon.actif = true;
    // emit.child est la source de verite : la variable child peut encore etre nulle.
    const vise = child || emit.child || null;
    console.warn(`[coupure] client parti apres ${Date.now() - started} ms, `
      + `silence CLI ${Date.now() - lastCliActivity} ms, ${outputText.length} car emis, `
      + `keepalive x${keepaliveSent}, fils ${vise ? 'tue' : 'absent'}`);
    vol.fin('coupure', `${outputText.length} car emis, silence ${Date.now() - lastCliActivity} ms`);
    if (vise) tuerArbre(vise, 'SIGKILL', { toutLeTour: true });
  };
  res.on('close', onClose);

  try {
    // Temps reel : texte + journal d'outils, token par token, dans le bloc 0.
    const onDelta = (text) => {
      if (!text) return;
      outputText += text;
      lastCliActivity = Date.now();
      vol.touche(outputText.length);
      send('content_block_delta', {
        type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text },
      });
    };
    // Sortie reelle du CLI, rendue a Hermes au lieu de l'estimation chars/4.
    // L'entree reste estimee : le vrai contexte du CLI (cache compris) ferait
    // croire a Hermes que sa propre fenetre est pleine.
    let vraiUsage = null;
    const promise = runClaudeWithRetry({ prompt, system, spec, images, sess }, emit, 'stream', {
      onActivity: () => { lastCliActivity = Date.now(); vol.touche(outputText.length); },
      onDelta,
      onUsage: (u) => { vraiUsage = u; },
      abandon,
    });
    child = emit.child || null;
    await promise;

    send('content_block_stop', { type: 'content_block_stop', index: 0 });
    send('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: vraiUsage?.output_tokens ?? estimateTokens(outputText) },
    });
    send('message_stop', { type: 'message_stop' });
    console.log(`[stream] ${spec.model || 'defaut'}/${spec.effort || 'defaut'} ${prompt.length} car -> ${outputText.length} car en ${Date.now() - started} ms (keepalive x${keepaliveSent})`);
    vol.fin('fini');
  } catch (error) {
    if (aborted) {
      console.warn(`[stream] client parti apres ${Date.now() - started} ms`);
      return;
    }
    console.error(`[stream] echec en ${Date.now() - started} ms: ${error.message}`);
    vol.fin(error.timedOut ? 'timeout' : 'erreur', error.message);
    // Le stream a deja un statut 200 : l'erreur passe par un event, pas par le code HTTP.
    send('error', {
      type: 'error',
      error: {
        type: error.timedOut ? 'timeout_error' : 'api_error',
        message: (stderrUtile(error.stderr) || error.message || 'Echec du CLI claude.').trim().slice(0, 2000),
      },
    });
  } finally {
    clearInterval(ping);
    clearInterval(keepalive);
    // Filet : un chemin de sortie oublie laisserait un tour eternellement en vol,
    // et le veilleur crierait a l'agent mort pour un tour qui allait tres bien.
    vol.fin('interrompu');
    res.off('close', onClose);
    if (!res.writableEnded) res.end();
  }
}

async function respondJson(res, { prompt, system, spec, images, sess, model, inputTokens, started, queueNotice }) {
  try {
    const collect = () => {};
    let vraiUsage = null;
    const raw = await runClaudeWithRetry({ prompt, system, spec, images, sess }, collect, 'json', {
      onUsage: (u) => { vraiUsage = u; },
    });
    const text = queueNotice ? queueNotice + raw : raw;
    console.log(`[json] ${prompt.length} car -> ${text.length} car en ${Date.now() - started} ms`);
    res.json({
      ...messageEnvelope({ model, inputTokens }),
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: { input_tokens: inputTokens, output_tokens: vraiUsage?.output_tokens ?? estimateTokens(text) },
    });
  } catch (error) {
    console.error(`[json] echec en ${Date.now() - started} ms: ${error.message}`);
    res.status(error.timedOut ? 504 : 500).json({
      type: 'error',
      error: {
        type: error.timedOut ? 'timeout_error' : 'api_error',
        message: (stderrUtile(error.stderr) || error.message || 'Echec du CLI claude.').trim().slice(0, 2000),
      },
    });
  }
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

app.get(['/health', '/anthropic/health'], (_req, res) => {
  res.json({
    status: health.consecutiveFailures >= 3 ? 'degraded' : 'ok',
    bin: CLAUDE_BIN,
    running,
    queued: waiting.length,
    maxConcurrency: MAX_CONCURRENCY,
    memoryAvailableGb: Number(availableGb().toFixed(1)),
    memoryReserveGb: RESERVE_GB,
    cpuPressure: Number(cpuPressure().toFixed(1)),
    cpuPressureCeiling: CPU_PRESSURE_CEILING,
    comptes: comptes.resume(),
    ...health,
  });
});

// Message arrive pendant un tour : ecrit sur le stdin du CLI de ce topic.
// 409 = aucun tour pilotable en vol, le client garde alors sa file normale.
app.post(['/steer', '/anthropic/steer'], (req, res) => {
  const topic = String(req.body?.topic ?? '');
  const texte = String(req.body?.texte ?? '').trim();
  const p = pilotables.get(topic);
  if (!texte || !p || p.ferme || !p.child || p.child.exitCode !== null) {
    res.status(409).json({ ok: false, raison: texte ? 'aucun tour en vol' : 'texte vide' });
    return;
  }
  p.recus += 1;
  if (p.coupure || p.agents.size) {
    const premier = !p.coupure;
    p.coupure = p.coupure || [];
    p.coupure.push(texteSteerCoupe(texte));
    if (premier) {
      p.child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: `coupe-${Date.now()}`, request: { subtype: 'interrupt' } })}\n`);
    }
    console.log(`[steer] topic=${topic} sous-agent au premier plan : coupure (${texte.length} car.)`);
    res.json({ ok: true, coupe: true });
    return;
  }
  const contenu = texteSteer(texte);
  p.attendus.push(contenu);
  p.child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: contenu } })}\n`);
  console.log(`[steer] topic=${topic} injecte (${texte.length} car.)`);
  res.json({ ok: true });
});

app.get(['/encours', '/anthropic/encours'], (_req, res) => {
  const t = Date.now();
  res.json({
    running,
    queued: waiting.length,
    tours: [...enVol.values()].map((e) => ({
      ...e,
      ageS: Math.round((t - e.debut) / 1000),
      silenceS: Math.round((t - e.activite) / 1000),
    })).sort((x, y) => y.silenceS - x.silenceS),
  });
});

let __dumpRestants = 6;
function __dumpPayload(messages) {
  if (process.env.CLAUDE_PROXY_DUMP_PAYLOADS !== '1' || __dumpRestants <= 0) return;
  __dumpRestants -= 1;
  const dumpDir = process.env.CLAUDE_PROXY_DUMP_DIR || path.join(os.tmpdir(), 'proxy-payloads');
  try {
    mkdirSync(dumpDir, { recursive: true });
    const compact = messages.map((m) => ({
      role: m && m.role,
      content: typeof m?.content === 'string'
        ? m.content.slice(0, 400)
        : Array.isArray(m?.content)
          ? m.content.map((b) => ({ type: b?.type, apercu: JSON.stringify(b).slice(0, 400) }))
          : m?.content,
    }));
    writeFileSync(path.join(dumpDir, `${Date.now()}.json`), JSON.stringify(compact, null, 1));
  } catch (e) { console.error('[dump]', e.message); }
}

async function handleMessages(req, res) {
  const { messages, model, system, stream } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'Le champ "messages" est requis et doit etre un tableau non vide.' },
    });
    return;
  }

  __dumpPayload(messages);
  const prompt = buildPrompt(messages);
  const images = extractImages(messages);
  // Une photo sans legende est une requete valide : le texte seul ne suffit
  // plus a decider si la requete est vide.
  if (!prompt && !images.length) {
    res.status(400).json({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'Aucun texte exploitable dans la requete.' },
    });
    return;
  }

  const systemText = extractText(system);
  const inputTokens = estimateTokens(prompt + systemText);
  const started = Date.now();

  if (process.env.CLAUDE_PROXY_DEBUG) {
    const { messages: _m, system: _s, ...rest } = req.body;
    console.log(`[debug] cles=${Object.keys(req.body).join(',')} reste=${JSON.stringify(rest).slice(0, 600)}`);
  }

  const queueInfo = {};
  const waitStarted = Date.now();
  try {
    await acquireSlot(queueInfo);
  } catch (error) {
    // 529 = surcharge cote Anthropic : Hermes sait le reessayer plus tard.
    console.warn(`[queue] refus, ${waiting.length} en attente`);
    res.status(529).json({
      type: 'error',
      error: { type: 'overloaded_error', message: 'Proxy sature, reessayer.' },
    });
    return;
  }

  // Le stream ne peut pas s'ouvrir avant d'avoir le creneau, donc l'annonce
  // arrive avec la reponse plutot que pendant l'attente. Elle repond quand
  // meme a la question « pourquoi ce topic a mis 40 s a demarrer ».
  const waitedMs = Date.now() - waitStarted;
  let queueNotice = null;
  if (waitedMs >= QUEUE_NOTICE_MS) {
    const secs = Math.round(waitedMs / 1000);
    const ahead = queueInfo.ahead || 0;
    const devant = ahead ? `, ${ahead} devant celle-ci` : '';
    if (queueInfo.reason === 'charge') {
      queueNotice = `⏳ ${secs} s d'attente : machine chargee `
        + `(contention CPU ${Math.round(queueInfo.cpuPressure)} %), `
        + `${queueInfo.runningAtEntry} en cours au lieu de ${MAX_CONCURRENCY}${devant}.\n\n`;
    } else if (queueInfo.reason === 'memoire') {
      queueNotice = `⏳ ${secs} s d'attente : memoire courte `
        + `(${queueInfo.freeGb.toFixed(1).replace('.', ',')} Go libres pour ${RESERVE_GB} Go de reserve), `
        + `${queueInfo.runningAtEntry} en cours au lieu de ${MAX_CONCURRENCY}${devant}.\n\n`;
    } else {
      const n = queueInfo.runningAtEntry ?? MAX_CONCURRENCY;
      queueNotice = `⏳ ${secs} s d'attente : ${n} conversation${n > 1 ? 's' : ''} `
        + `tournai${n > 1 ? 'ent' : 't'} deja${devant}.\n\n`;
    }
    console.warn(
      `[queue] attente ${secs}s, cause=${queueInfo.reason}, `
      + `${queueInfo.runningAtEntry} en cours, ${ahead} devant, plafond ${MAX_CONCURRENCY}`);
  }

  try {
    const spec = parseModelSpec(model, req.body);
    if (!spec.model) {
      res.status(400).json({ type: 'error', error: { type: 'invalid_request_error',
        message: 'Modèle Claude invalide ou absent. Aucun remplacement automatique.' } });
      return;
    }
    res.set('x-proxy-resolved-model', spec.model);
    res.set('x-proxy-cache-control', 'cli-managed-not-forwarded');
    const famille = spec.client ? null : familleAux(systemText, prompt);
    if (famille) {
      spec.famille = famille.nom;
      if (famille.sansOutils && !spec.relais) spec.noTools = true;
    } else if (anonymeCourt(spec, systemText, prompt)) {
      spec.famille = 'anonyme-court';
      spec.noTools = true;
    }
    const dernierContenu = messages.at(-1)?.content;
    const retourRelais = spec.relais && Array.isArray(dernierContenu)
      && dernierContenu.some((b) => b?.type === 'tool_result');
    if (!retourRelais && comptes.configure() && !comptes.choisir(spec.compte)) {
      const r = comptes.prochainReset();
      if (r) res.set('retry-after', String(Math.max(1, Math.round((r - Date.now()) / 1000))));
      res.status(429).json({ type: 'error', error: {
        type: 'rate_limit_error', message: messageTousEpuises(),
      } });
      return;
    }
    const sess = planifierSession(messages, prompt, images, cwdPourTopic(systemText), systemText);
    const payload = {
      prompt, system: systemText, spec, images, sess, model, inputTokens, started, queueNotice,
    };
    if (spec.relais) {
      // Un retour d'outil reprend le processus déjà ouvert.
      await toolRelay.traiter({
        req, res, model, prompt, system: systemText, spec, inputTokens, stream,
      });
    } else if (stream) await respondStreaming(res, payload);
    else await respondJson(res, payload);
  } finally {
    releaseSlot();
  }
}

// Hermes n'accepte un proxy Anthropic que si le chemin finit par /anthropic
// (hermes_cli/runtime_provider.py::_detect_api_mode_for_url). D'ou l'alias.
app.post(['/v1/messages', '/anthropic/v1/messages'], handleMessages);

// Le serveur MCP du mode relais, servi par le proxy lui-meme : pas de process
// ni de socket supplementaires, et l'appel d'outil se suspend dans le meme
// espace memoire que la requete HTTP a qui il doit etre rendu.
toolRelay.init({ runClaude, extractText, estimateTokens, messageEnvelope });
toolRelay.monterRoute(app);

app.post(['/v1/messages/count_tokens', '/anthropic/v1/messages/count_tokens'], (req, res) => {
  const { messages = [], system } = req.body || {};
  const prompt = messages.length ? buildPrompt(messages) : '';
  res.json({ input_tokens: estimateTokens(prompt + extractText(system)) });
});

// KillMode=process : systemd ne signale que ce process. Chrome et le demon
// OpenCLI, lances depuis un outil bash et donc heritiers du meme cgroup,
// survivent au redemarrage. En contrepartie on nettoie nos enfants nous-memes.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`[arret] ${signal} : ${liveChildren.size} process claude a tuer.`);
    for (const child of liveChildren) {
      tuerArbre(child);
    }
    process.exit(0);
  });
}

if (RESUME_ACTIF) chargerSessions();

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`claude-proxy en ecoute sur http://localhost:${PORT}`);
  console.log(`POST /v1/messages et /anthropic/v1/messages  ->  ${CLAUDE_BIN} -p (stdin, stream-json)`);
  console.log(`concurrence max ${MAX_CONCURRENCY}, timeout ${TIMEOUT_MS} ms, settings ${CLAUDE_SETTINGS}`);
  console.log(`keepalive stream toutes les ${KEEPALIVE_MS} ms, silence max tolere ${KEEPALIVE_MAX_SILENCE_MS || 'illimite'}`);
});
// Un stream de 30 min ne doit pas etre coupe par le timeout de socket d'Express.
server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;
