import express from 'express';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 8000;
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const CLAUDE_SETTINGS = process.env.CLAUDE_SETTINGS || path.join(HERE, 'claude-settings.json');
const TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS) || 300_000;
// Concurrence : dimensionnee sur la machine, pas sur une constante.
// Chaque requete = un process `claude` complet. Le facteur limitant est la RAM,
// pas le CPU : mesure sur vj-1, un process tient ~0,3 Go au repos et pointe
// vers 0,7 Go sur une tache longue. On garde RESERVE_GB pour le systeme et le
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
// average : mesure sur vj-1, load 55 pour 24 coeurs alors que rien n'etait
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

  // Volontairement pas de plafond par coeurs : mesure sur vj-1, un process
  // `claude` tient 2-3 % de CPU parce qu'il passe son temps a attendre l'API,
  // pas a calculer. Brider sur les coeurs limitait a 22 une machine dont la
  // RAM en autorise 35, sans rien proteger. Les vrais garde-fous sont la RAM
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

// MAX_CONCURRENCY est calcule au demarrage sur la RAM totale. Mais la RAM
// *disponible* bouge : Jellyfin qui transcode, un bounce DJ, une session
// Claude Code. Ce garde relit MemAvailable avant chaque octroi, pour que la
// limite suive la machine au lieu d'une photo prise au boot. Sans lui, un pic
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
function buildPrompt(messages) {
  const parts = [];
  const history = messages.slice(0, -1);
  if (history.length) {
    const rendered = history
      .map((m) => {
        const text = extractText(m?.content);
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
 * Mesure du 2026-08-26, meme conversation de 3 tours, modele haiku :
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
  process.on(sig, () => { try { sauverSessions(); } catch (_) {} process.exit(0); });
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


function empreinteAvec(messages, mode) {
  const h = createHash('sha1');
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

function empreinte(messages) {
  return empreinteAvec(messages, 'exact');
}

function clesDe(messages) {
  if (!messages.length) return [];
  return [
    empreinteAvec(messages, 'exact'),
    empreinteAvec(messages, 'suffixe'),
    empreinteAvec(messages, 'prefixe'),
  ];
}

/*
 * Le dernier message utilisateur est volatil.
 *
 * Mesure du 27/08 : une session stockee avec un dernier message de 1159
 * caracteres se representait au tour suivant avec 185 caracteres pour ce meme
 * message. Hermes enrichit le message courant au moment de l'envoi (contexte de
 * session, rappels) puis n'en garde que le texte nu dans son historique. Toute
 * cle calculee sur ce message casse donc systematiquement au tour suivant.
 *
 * On indexe chaque session sous deux jeux de cles : l'historique complet, et
 * l'historique prive de son dernier message. La recherche par prefixe attrape
 * le second des que le premier a bouge, sans rien perdre du contexte.
 */
function clesEtendues(messages) {
  const cles = clesDe(messages);
  if (messages.length > 1) cles.push(...clesDe(messages.slice(0, -1)));
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

function chercherSession(messages) {
  for (const cle of clesDe(messages)) {
    const e = sessions.get(cle);
    if (e) return { cle, entry: e };
  }
  return null;
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
function planifierSession(messages, promptAplati, imagesAplati) {
  if (!RESUME_ACTIF) return null;
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
    const c = chercherSession(messages.slice(0, -k));
    if (c) { trouve = c; saut = k - 2; break; }
  }
  const entry = trouve ? trouve.entry : null;
  const texte = extractText(dernier && dernier.content);
  const imagesDernier = extractImages([dernier]);

  const reprenable = Boolean(
    entry && !entry.busy
    && entry.tours < SESSION_TOURS_MAX
    && avantDernier && avantDernier.role === 'assistant'
    && (texte || imagesDernier.length),
  );

  if (reprenable) {
    const clesDepart = [...sessions].filter(([, e]) => e === entry).map(([c]) => c);
    oublierSession(entry);
    enCours.set(entry, clesDepart);
    entry.busy = true;
    console.log(`[sess] reprise ${entry.id} tour ${entry.tours + 1} : ${texte.length} car au lieu de ${promptAplati.length}${saut ? ` (saut=${saut} msgs d'outils du CLI)` : ''}`);
    return {
      entry,
      args: ['--resume', entry.id],
      prompt: texte,
      images: imagesDernier,
      cles: clesEtendues(messages),
      sig: signature(messages),
    };
  }

  const neuve = { id: randomUUID(), tours: 0, busy: true, ts: Date.now() };
  let motif;
  if (messages.length < 3) motif = 'debut-conversation';
  else if (!entry) {
    const essais = [];
    for (let k = 2; k <= profondeurMax; k += 1) {
      const cs = clesDe(messages.slice(0, -k));
      essais.push(`${k}:${cs.map((c) => (sessions.has(c) ? '1' : '0')).join('')}`);
    }
    motif = `chaine-introuvable ${diagnostiquerRupture(signature(messages.slice(0, -2)))} cles=${sessions.size} essais=${essais.slice(0, 6).join(',')}`;
  }
  else if (entry.busy) motif = 'session-occupee';
  else if (entry.tours >= SESSION_TOURS_MAX) motif = 'plafond-tours';
  else if (!avantDernier || avantDernier.role !== 'assistant') motif = `avant-dernier=${avantDernier ? avantDernier.role : 'absent'}`;
  else motif = 'dernier-message-vide';
  console.log(`[sess] neuve ${neuve.id} motif=${motif} msgs=${messages.length}`);
  return {
    entry: neuve,
    args: ['--session-id', neuve.id],
    prompt: promptAplati,
    images: imagesAplati,
    cles: clesEtendues(messages),
    sig: signature(messages),
  };
}

function validerSession(sess) {
  if (!sess) return;
  enCours.delete(sess.entry);
  sess.entry.busy = false;
  sess.entry.tours += 1;
  sess.entry.ts = Date.now();
  if (Array.isArray(sess.sig)) sess.entry.sig = sess.sig;
  for (const cle of sess.cles) sessions.set(cle, sess.entry);
  planifierSauvegarde();
}

/**
 * Le tour a echoue : on jette la session. Le CLI a peut-etre deja ecrit le
 * message utilisateur dans son journal, reprendre dessus le dupliquerait.
 */
function abandonnerSession(sess) {
  if (!sess) return;
  enCours.delete(sess.entry);
  sess.entry.busy = false;
  oublierSession(sess.entry);
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil((text || '').length / 4));
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const MODEL_OK = /^(claude-[a-z0-9.-]+|opus|sonnet|haiku|fable)(\[1m\])?$/i;

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
  let name = String(model || '').trim();
  let suffixEffort = '';

  // Suffixe `-notools` : la cible repond en texte seul, sans aucun outil.
  // Utilise par PyRIT pour que la cible ne modifie pas la machine.
  let noTools = false;
  if (name.toLowerCase().endsWith('-notools')) {
    noTools = true;
    name = name.slice(0, -'-notools'.length);
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

  return {
    model: MODEL_OK.test(name) ? name : '',
    effort,
    noTools,
  };
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
 * Mesure du 2026-08-26 sur 4 721 allers-retours API reels : 93,1 % ne portent
 * qu'UN seul appel d'outil, moyenne 1,07. Or chaque aller-retour relit tout le
 * contexte du tour (median 53 k de socle + prompt, avant accumulation). Le
 * nombre de boucles est donc le multiplicateur de toute la facture : 6 568
 * appels d'outils ont coute 6 132 boucles la ou 3 300 auraient suffi.
 *
 * Deux appels independants dans le MEME message ne coutent qu'une boucle.
 */
const DIRECTIVE_GROUPAGE = [
  '',
  '## Economie de contexte (imperatif)',
  '',
  "Chaque aller-retour d'outil relit l'integralite du contexte. Le nombre",
  "d'allers-retours est donc le premier poste de cout, avant la longueur des",
  'reponses.',
  '',
  "- Emets TOUS les appels d'outils independants dans un seul et meme message.",
  '  Deux `Bash` qui ne dependent pas l\'un de l\'autre partent ensemble, jamais',
  "  l'un apres l'autre.",
  "- Prefere une commande composee (`a; b; c` ou `a && b`) a trois appels Bash",
  "  successifs, et une seule commande large a une cascade de commandes etroites.",
  "- Ne relis pas un fichier que tu viens d'ecrire ou de modifier pour verifier :",
  "  l'outil aurait echoue.",
  "- **Ne fais jamais `Read` sur une image brute** (capture .png, photo).",
  "  Anthropic redimensionne toute image a 1456x819 au maximum, soit 1560",
  "  tokens quelle que soit sa taille d'origine. A 1100 px on tombe a 960",
  "  tokens, -39 %, sans rien perdre en lisibilite. Passe donc par",
  "  `~/Bureau/Projets/contexte/bin/img-lisible.sh <image>` puis lis CE fichier.",
  "- Ne relis pas deux fois la meme capture : elle reste dans le contexte et",
  "  se relit a chaque aller-retour du tour.",
  '- Delegue une exploration large a un sous-agent : son contexte est neuf et',
  "  seul son resultat revient ici.",
  "- **Tout appel du tool `Agent` porte `model: \"sonnet\"`.** Mesure du 2026-08-26 :",
  "  les sous-agents tournaient tous en opus-5 et pesaient 59 % de la depense du",
  "  jour. Une exploration, une lecture, un audit, une recherche : `sonnet`.",
  "  N'ecris `model: \"opus\"` que si la tache exige un raisonnement long, et",
  "  dis alors pourquoi dans le champ `description`.",
].join('\n');

function runClaude({ prompt, system, spec, images, sessionArgs }, onText, hooks = {}) {
  const onActivity = typeof hooks.onActivity === 'function' ? hooks.onActivity : () => {};
  // Mode PARTIEL (temps reel) : present seulement pour le stream. Emet les deltas
  // texte/raisonnement + les outils token par token, via les events partiels du CLI.
  const onDelta = typeof hooks.onDelta === 'function' ? hooks.onDelta : null;
  // Relais NATIF (stream) : renvoyer les vrais events SSE du CLI tels quels.
  const onEvent = typeof hooks.onEvent === 'function' ? hooks.onEvent : null;
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    // Continuite : --session-id ouvre un journal CLI nomme, --resume le
    // reprend. C'est le CLI qui tient alors l'historique et ses points de
    // cache ; le proxy ne lui passe plus que le dernier message.
    if (Array.isArray(sessionArgs) && sessionArgs.length) args.push(...sessionArgs);
    // Une image ne passe pas par stdin texte : il faut le format d'entree
    // structure, seul moyen de donner des blocs `image` au CLI.
    const avecImages = Array.isArray(images) && images.length > 0;
    if (avecImages) args.push('--input-format', 'stream-json');
    if (onDelta || onEvent) args.push('--include-partial-messages');
    if (CLAUDE_SETTINGS) args.push('--settings', CLAUDE_SETTINGS);
    if (spec?.model) args.push('--model', spec.model);
    if (spec?.effort) args.push('--effort', spec.effort);
    // Cible « texte seul » : ni outils integres, ni serveurs MCP.
    if (spec?.noTools) {
      args.push('--tools', '');
      args.push('--mcp-config', '{"mcpServers":{}}', '--strict-mcp-config');
    } else {
      // Socle reduit. Mesure du 2026-08-26 : le toolset complet du CLI coute
      // 38 255 tokens de contexte AVANT le premier mot, relus a chaque appel.
      // Sur 14 jours et 8 974 appels d'outils reels, Hermes n'a utilise que
      // Bash (90,4 %), Read (3,2 %), Agent (2,1 %), Edit (1,2 %),
      // ToolSearch (0,8 %), Write (0,5 %), Skill (0,4 %), WebSearch, WebFetch.
      // Tout le reste (Glob, Grep, TodoWrite, NotebookEdit, BashOutput...) et
      // les 102 outils MCP (0,4 % des appels) n'ont jamais servi ou presque.
      // Restreindre ramene le socle a 24 476 tokens : -13 779 par appel.
      args.push('--tools', OUTILS_HERMES);
      args.push('--mcp-config', '{"mcpServers":{}}', '--strict-mcp-config');
    }
    if (system) {
      // Diagnostic cache : le system prompt est le PREMIER bloc mis en cache par
      // le CLI. S'il change d'un tour a l'autre, tout ce qui suit est invalide,
      // meme avec une session --resume qui reprend correctement. Hermes
      // recalcule a chaque tour un bloc "ephemeral" (contexte de session) qu'il
      // colle au prompt systeme stable : on trace donc separement l'empreinte
      // du tout et celle des 4 premiers kilo-octets.
      const hTout = createHash('sha1').update(system).digest('hex').slice(0, 8);
      const hTete = createHash('sha1').update(system.slice(0, 4000)).digest('hex').slice(0, 8);
      console.log(`[sys] len=${system.length} tout=${hTout} tete4k=${hTete}`);
      args.push('--system-prompt', `${system}\n${DIRECTIVE_GROUPAGE}`);
    }

    const child = spawn(CLAUDE_BIN, args, { cwd: HERE, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    // L'unite tourne en KillMode=process pour epargner Chrome et le demon
    // OpenCLI, qui vivent dans le meme cgroup. C'est donc au proxy de tuer
    // ses propres enfants a l'arret, sinon ils survivent en orphelins.
    liveChildren.add(child);
    child.once('close', () => liveChildren.delete(child));

    let buffer = '';
    let stderr = '';
    let full = '';
    let failure = null;
    let timedOut = false;
    // Journal d'outils compact (une ligne par appel, dedupe).
    let toolEnCours = null;
    let dernierOutil = '';

    // Timeout d'INACTIVITE, pas de mur d'horloge. Un tour qui travaille encore
    // (appels d'outils, texte qui sort) ne doit jamais etre tue : c'est ce qui
    // faisait disparaitre en silence les taches longues mais bien vivantes.
    let timer = null;
    const armerTimeout = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, TIMEOUT_MS);
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
        } else if (e.type === 'content_block_delta') {
          const d = e.delta || {};
          if (d.type === 'text_delta' && d.text) { full += d.text; onDelta(d.text); }
          else if (d.type === 'input_json_delta' && toolEnCours && d.partial_json) {
            toolEnCours.input += d.partial_json;
          }
        } else if (e.type === 'content_block_stop' && toolEnCours && STREAM_TRACE) {
          const ligne = ligneOutil(toolEnCours.name, toolEnCours.input);
          if (ligne && ligne !== dernierOutil) { dernierOutil = ligne; onDelta(`${ligne}\n`); }
          toolEnCours = null;
        }
        return;
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
          onText(text);
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
      if (timedOut) {
        // Du texte a deja ete produit : le rendre vaut mieux que le silence.
        if (full.trim()) {
          resolve(`${full}\n\n_(coupe : ${Math.round(TIMEOUT_MS / 1000)} s sans activite du CLI)_`);
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
      resolve(full);
    });

    child.stdin.on('error', () => {});
    if (avecImages) {
      const blocs = [];
      if (prompt) blocs.push({ type: 'text', text: prompt });
      blocs.push(...images);
      child.stdin.end(`${JSON.stringify({ type: 'user', message: { role: 'user', content: blocs } })}\n`);
    } else {
      child.stdin.end(prompt);
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
async function runClaudeWithRetry(payload, onText, label, hooks = {}) {
  health.totalCalls += 1;
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let emitted = false;
    const guarded = (text) => { emitted = true; onText(text); };
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
    const sess = attempt === 1 ? payload.sess : null;
    const essai = sess
      ? { ...payload, prompt: sess.prompt, images: sess.images, sessionArgs: sess.args }
      : { ...payload, sessionArgs: null };

    try {
      const text = await runClaude(essai, guarded, guardedHooks);
      health.lastSuccessAt = new Date().toISOString();
      health.consecutiveFailures = 0;
      if (sess) validerSession(sess);
      else abandonnerSession(payload.sess);
      return text;
    } catch (error) {
      lastError = error;
      onText.child = guarded.child || null;

      const retryable = !emitted && !error.aborted && !isFatal(error.message) && !isFatal(error.stderr);
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
  // Porte-cle du process fils. runClaudeWithRetry y pose .child au spawn, qui peut
  // arriver bien apres cet appel si la requete passe par la file d'attente.
  const emit = () => {};
  const onClose = () => {
    aborted = true;
    // emit.child est la source de verite : la variable child peut encore etre nulle.
    const vise = child || emit.child || null;
    console.warn(`[coupure] client parti apres ${Date.now() - started} ms, `
      + `silence CLI ${Date.now() - lastCliActivity} ms, ${outputText.length} car emis, `
      + `keepalive x${keepaliveSent}, fils ${vise ? 'tue' : 'absent'}`);
    if (vise) vise.kill('SIGKILL');
  };
  res.on('close', onClose);

  try {
    // Temps reel : texte + journal d'outils, token par token, dans le bloc 0.
    const onDelta = (text) => {
      if (!text) return;
      outputText += text;
      lastCliActivity = Date.now();
      send('content_block_delta', {
        type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text },
      });
    };
    const promise = runClaudeWithRetry({ prompt, system, spec, images, sess }, emit, 'stream', {
      onActivity: () => { lastCliActivity = Date.now(); },
      onDelta,
    });
    child = emit.child || null;
    await promise;

    send('content_block_stop', { type: 'content_block_stop', index: 0 });
    send('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: estimateTokens(outputText) },
    });
    send('message_stop', { type: 'message_stop' });
    console.log(`[stream] ${spec.model || 'defaut'}/${spec.effort || 'defaut'} ${prompt.length} car -> ${outputText.length} car en ${Date.now() - started} ms (keepalive x${keepaliveSent})`);
  } catch (error) {
    if (aborted) {
      console.warn(`[stream] client parti apres ${Date.now() - started} ms`);
      return;
    }
    console.error(`[stream] echec en ${Date.now() - started} ms: ${error.message}`);
    // Le stream a deja un statut 200 : l'erreur passe par un event, pas par le code HTTP.
    send('error', {
      type: 'error',
      error: {
        type: error.timedOut ? 'timeout_error' : 'api_error',
        message: (error.stderr || error.message || 'Echec du CLI claude.').trim().slice(0, 2000),
      },
    });
  } finally {
    clearInterval(ping);
    clearInterval(keepalive);
    res.off('close', onClose);
    if (!res.writableEnded) res.end();
  }
}

async function respondJson(res, { prompt, system, spec, images, sess, model, inputTokens, started, queueNotice }) {
  try {
    const collect = () => {};
    const raw = await runClaudeWithRetry({ prompt, system, spec, images, sess }, collect, 'json');
    const text = queueNotice ? queueNotice + raw : raw;
    console.log(`[json] ${prompt.length} car -> ${text.length} car en ${Date.now() - started} ms`);
    res.json({
      ...messageEnvelope({ model, inputTokens }),
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      usage: { input_tokens: inputTokens, output_tokens: estimateTokens(text) },
    });
  } catch (error) {
    console.error(`[json] echec en ${Date.now() - started} ms: ${error.message}`);
    res.status(error.timedOut ? 504 : 500).json({
      type: 'error',
      error: {
        type: error.timedOut ? 'timeout_error' : 'api_error',
        message: (error.stderr || error.message || 'Echec du CLI claude.').trim().slice(0, 2000),
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
    ...health,
  });
});

let __dumpRestants = 6;
function __dumpPayload(messages) {
  if (__dumpRestants <= 0) return;
  __dumpRestants -= 1;
  try {
    mkdirSync('/tmp/proxy-payloads', { recursive: true });
    const compact = messages.map((m) => ({
      role: m && m.role,
      content: typeof m?.content === 'string'
        ? m.content.slice(0, 400)
        : Array.isArray(m?.content)
          ? m.content.map((b) => ({ type: b?.type, apercu: JSON.stringify(b).slice(0, 400) }))
          : m?.content,
    }));
    writeFileSync(`/tmp/proxy-payloads/${Date.now()}.json`, JSON.stringify(compact, null, 1));
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
    const sess = planifierSession(messages, prompt, images);
    const payload = {
      prompt, system: systemText, spec, images, sess, model, inputTokens, started, queueNotice,
    };
    if (stream) await respondStreaming(res, payload);
    else await respondJson(res, payload);
  } finally {
    releaseSlot();
  }
}

// Hermes n'accepte un proxy Anthropic que si le chemin finit par /anthropic
// (hermes_cli/runtime_provider.py::_detect_api_mode_for_url). D'ou l'alias.
app.post(['/v1/messages', '/anthropic/v1/messages'], handleMessages);

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
      try { child.kill('SIGKILL'); } catch { /* deja mort */ }
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
