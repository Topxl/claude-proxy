// Plusieurs comptes Claude derriere le proxy (2026-10-30).
//
// Ne le 2026-10-30 : un seul jeton, limite des 5 h atteinte, Hermes en panne
// jusqu'au reset. Chaque compte est un jeton `claude setup-token` dans son
// propre fichier env (mode 600), liste par ordre de priorite dans
// ~/.config/claude-proxy/comptes.json :
//
//   { "comptes": [
//       { "nom": "contact", "fichier": "oauth.env", "note": "contact@..." },
//       { "nom": "secours", "fichier": "oauth.env.secours" } ] }
//
// Chaque fichier porte une ligne CLAUDE_CODE_OAUTH_TOKEN=... Le chemin est
// relatif au dossier de comptes.json. La liste est relue a chaque tour :
// ajouter un compte ne demande aucun redemarrage.
//
// Choix du compte : suffixe `@nom` du modele (`/model claude-opus-5-5@secours`
// dans Hermes), sinon le premier compte disponible. Un compte qui renvoie
// « hit your limit » est mis de cote jusqu'a l'heure de reset annoncee, le
// tour repart aussitot sur le suivant et le QG est prevenu.
// Sans comptes.json, rien ne change : le CLI garde le jeton de l'unite.

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DOSSIER = process.env.PROXY_COMPTES_DIR
  || path.join(os.homedir(), '.config', 'claude-proxy');
const FICHIER = path.join(DOSSIER, 'comptes.json');
const FICHIER_ETAT = path.join(DOSSIER, 'comptes-etat.json');
const NOM_OK = /^[a-z0-9]{1,24}$/;

// Quota du compte epuise : le seul cas ou changer de compte guerit le tour.
const LIMITE = [
  /hit your [^.\n]*limit/i,
  /usage limit reached/i,
  /limit reached\|\d{10}/i,
  /out of extra usage/i,
];
// Reset illisible : on retente ce compte dans 30 min.
const REPLI_MS = 30 * 60 * 1000;

export function estLimite(message) {
  const t = String(message || '');
  return LIMITE.some((re) => re.test(t));
}

const MOIS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// « resets 10:40pm (Asia/Bangkok) », « resets Nov 3, 5am », « |1730000000 ».
// Heure lue en heure locale du proxy (Asia/Bangkok sur vj-1).
export function heureReset(message, maintenant = Date.now()) {
  const t = String(message || '');
  const epoch = /\|(\d{10})\b/.exec(t);
  if (epoch) return Number(epoch[1]) * 1000;
  const m = /resets\s+(?:(?:at\s+)?([a-z]{3})[a-z]*\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(t);
  if (!m) return maintenant + REPLI_MS;
  let h = Number(m[3]) % 12;
  if (m[5].toLowerCase() === 'pm') h += 12;
  const d = new Date(maintenant);
  if (m[1]) {
    const mois = MOIS.indexOf(m[1].toLowerCase());
    if (mois >= 0) d.setMonth(mois, Number(m[2]));
  }
  d.setHours(h, Number(m[4] || 0), 0, 0);
  // Heure deja passee aujourd'hui : c'est demain (ou l'an prochain).
  if (d.getTime() <= maintenant) {
    if (m[1]) d.setFullYear(d.getFullYear() + 1); else d.setDate(d.getDate() + 1);
  }
  return d.getTime();
}

function lireJson(fichier, defaut) {
  try { return JSON.parse(readFileSync(fichier, 'utf8')); } catch { return defaut; }
}

function lireJeton(fichier) {
  try {
    const ligne = readFileSync(path.resolve(DOSSIER, fichier), 'utf8')
      .split('\n').find((l) => l.startsWith('CLAUDE_CODE_OAUTH_TOKEN='));
    return ligne ? ligne.slice('CLAUDE_CODE_OAUTH_TOKEN='.length).trim().replace(/^"|"$/g, '') : '';
  } catch { return ''; }
}

// Comptes valides, dans l'ordre. Un fichier illisible ou vide est ignore.
export function liste() {
  const brut = lireJson(FICHIER, null);
  if (!brut || !Array.isArray(brut.comptes)) return [];
  const vus = new Set();
  const out = [];
  for (const c of brut.comptes) {
    const nom = String(c?.nom || '').toLowerCase();
    if (!NOM_OK.test(nom) || vus.has(nom) || !c.fichier) continue;
    const jeton = lireJeton(c.fichier);
    if (!jeton) continue;
    vus.add(nom);
    out.push({ nom, jeton, note: c.note || '' });
  }
  return out;
}

// Etat persistant : un redemarrage du proxy n'oublie pas un compte epuise.
let etat = lireJson(FICHIER_ETAT, {});
function sauver() {
  try {
    mkdirSync(DOSSIER, { recursive: true });
    const tmp = `${FICHIER_ETAT}.tmp`;
    writeFileSync(tmp, JSON.stringify(etat, null, 1), { mode: 0o600 });
    renameSync(tmp, FICHIER_ETAT);
  } catch (e) { console.warn('[comptes] etat non ecrit:', e.message); }
}

export function disponible(nom, maintenant = Date.now()) {
  return !(etat[nom]?.jusqua > maintenant);
}

// Retire le suffixe `@nom` du modele. Rend { model, compte }.
export function separer(model) {
  const s = String(model || '').trim();
  const i = s.lastIndexOf('@');
  if (i <= 0) return { model: s, compte: '' };
  const nom = s.slice(i + 1).toLowerCase();
  return NOM_OK.test(nom) ? { model: s.slice(0, i), compte: nom } : { model: s, compte: '' };
}

// Compte du tour : celui demande s'il est disponible, sinon le premier
// disponible dans l'ordre, hors `exclus`. null = aucun compte configure
// (le CLI garde le jeton de l'unite) ou tous epuises (voir `tousEpuises`).
export function choisir(demande = '', exclus = new Set()) {
  const comptes = liste();
  if (!comptes.length) return null;
  const libres = comptes.filter((c) => !exclus.has(c.nom) && disponible(c.nom));
  if (demande) {
    const voulu = libres.find((c) => c.nom === demande);
    if (voulu) return voulu;
  }
  return libres[0] || null;
}

export function configure() {
  return liste().length > 0;
}

// Marque le compte epuise jusqu'au reset. Rend true si c'est nouveau
// (premier echec de cette periode) : seul celui-la merite une alerte.
export function marquerEpuise(nom, message, maintenant = Date.now()) {
  const jusqua = heureReset(message, maintenant);
  const nouveau = !(etat[nom]?.jusqua > maintenant);
  etat[nom] = { jusqua, depuis: nouveau ? maintenant : etat[nom].depuis, motif: String(message || '').slice(0, 160) };
  sauver();
  return nouveau;
}

// Remet un compte en service a la main (sortie de `scripts/comptes.mjs`).
export function reactiver(nom) {
  delete etat[nom];
  sauver();
}

// Prochain reset parmi les comptes epuises, pour le message d'erreur final.
export function prochainReset(maintenant = Date.now()) {
  const t = liste().map((c) => etat[c.nom]?.jusqua || 0).filter((j) => j > maintenant);
  return t.length ? Math.min(...t) : 0;
}

// Vue sans jeton, pour /health.
export function resume(maintenant = Date.now()) {
  return liste().map((c) => ({
    nom: c.nom,
    note: c.note,
    disponible: disponible(c.nom, maintenant),
    jusqua: etat[c.nom]?.jusqua > maintenant ? new Date(etat[c.nom].jusqua).toISOString() : null,
  }));
}

export function relire() { etat = lireJson(FICHIER_ETAT, {}); }

// Quota lu dans le `rate_limit_event` du CLI (gratuit, un par tour), pour les
// boutons de /model dans Hermes. Fichier a part : l'etat ci-dessus n'est pas touche.
const FICHIER_QUOTA = path.join(DOSSIER, 'comptes-quota.json');
export function noterQuota(nom, info, maintenant = Date.now()) {
  const f = info?.unifiedWindows;
  if (!NOM_OK.test(nom || '') || !f) return;
  try {
    const tout = lireJson(FICHIER_QUOTA, {});
    tout[nom] = {
      h5: f.five_hour?.utilization ?? null,
      j7: f.seven_day?.utilization ?? null,
      j7_reset: f.seven_day?.resetsAt ?? null,
      le: maintenant,
    };
    mkdirSync(DOSSIER, { recursive: true });
    const tmp = `${FICHIER_QUOTA}.tmp`;
    writeFileSync(tmp, JSON.stringify(tout, null, 1), { mode: 0o600 });
    renameSync(tmp, FICHIER_QUOTA);
  } catch (e) { console.warn('[comptes] quota non ecrit:', e.message); }
}

/* ------------------------------------------------------------------ */
/* Alerte au QG                                                        */
/* ------------------------------------------------------------------ */

function envHermes(cle) {
  try {
    const l = readFileSync(path.join(os.homedir(), '.hermes', '.env'), 'utf8')
      .split('\n').find((x) => x.startsWith(`${cle}=`));
    return l ? l.slice(cle.length + 1).trim().replace(/^"|"$/g, '') : '';
  } catch { return ''; }
}

export function heureLocale(ms) {
  return new Date(ms).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

// Message au topic QG d'Hermes (meme adresse que alerte-panne.py).
// Jamais bloquant : une alerte perdue ne doit pas faire echouer le tour.
export async function alerterQg(texte) {
  if (process.env.PROXY_COMPTES_SANS_ALERTE === '1') {
    console.log(`[comptes] alerte (coupee) : ${texte}`);
    return;
  }
  try {
    const a = lireJson(path.join(os.homedir(), '.hermes', 'qg-adresse.json'), {});
    const chat = process.env.QG_CHAT || a.chat;
    const thread = process.env.QG_THREAD || a.thread;
    const tok = envHermes('TELEGRAM_BOT_TOKEN');
    if (!chat || !thread || !tok) { console.warn('[comptes] QG injoignable : adresse ou jeton absent'); return; }
    const r = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, message_thread_id: Number(thread), text: texte }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) console.warn(`[comptes] alerte QG refusee : HTTP ${r.status}`);
  } catch (e) { console.warn('[comptes] alerte QG echouee:', e.message); }
}
