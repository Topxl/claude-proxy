/**
 * Relais d'outils : rendre au client les appels d'outils au lieu de les
 * executer soi-meme.
 * ---------------------------------------------------------------------------
 * Le proxy normal laisse le CLI `claude` executer ses propres outils et ne
 * renvoie que du texte. Un harnais externe (Prime Agent, un SDK Anthropic, un
 * IDE) attend l'inverse : il declare ses outils dans la requete et veut
 * recevoir des blocs `tool_use` qu'il executera lui-meme.
 *
 * Le pont passe par MCP. Le proxy expose les outils du client comme un serveur
 * MCP en HTTP, et donne son adresse au CLI. Quand le modele appelle un de ces
 * outils, le serveur MCP ne repond pas tout de suite : il suspend l'appel,
 * termine la reponse HTTP en cours avec `stop_reason: "tool_use"`, et garde le
 * process claude vivant. Au tour suivant, le `tool_result` du client debloque
 * l'appel MCP suspendu et le meme process claude reprend ou il en etait.
 *
 * Consequence utile : l'historique n'est jamais rejoue. Le contexte vit dans le
 * process claude, pas dans la requete.
 *
 * Active uniquement par le suffixe de modele `-toolrelay`. Sans ce suffixe, pas
 * une ligne de ce fichier ne s'execute : le comportement des autres clients
 * (Hermes, PyRIT) est strictement inchange.
 */

import crypto from 'crypto';

const SUFFIXE = '-toolrelay';
// Fenetre de regroupement : le modele peut appeler plusieurs outils d'un coup.
// On attend brievement les suivants pour tous les rendre dans la meme reponse,
// sinon un appel parallele resterait suspendu sans jamais recevoir de resultat.
const FENETRE_GROUPAGE_MS = 200;
// Une session suspendue dont le client ne revient jamais finit par mourir.
const TTL_SESSION_MS = 15 * 60 * 1000;

let deps = null;
const sessions = new Map();     // sid -> session
const parToolUseId = new Map(); // tool_use_id -> sid

function init(d) { deps = d; }

/** Le suffixe `-toolrelay` demande-t-il le relais ? */
function detecter(model) {
  const nom = String(model || '').trim();
  if (!nom.toLowerCase().endsWith(SUFFIXE)) return { actif: false, model: nom };
  return { actif: true, model: nom.slice(0, -SUFFIXE.length) };
}

const nouvelId = (p) => `${p}_${crypto.randomBytes(12).toString('hex')}`;

/* ------------------------------------------------------------------ */
/* Serveur MCP expose au CLI                                           */
/* ------------------------------------------------------------------ */

/** Les outils du client, traduits dans le vocabulaire MCP. */
function outilsMcp(session) {
  return session.outils.map((o) => ({
    name: o.name,
    description: o.description || '',
    inputSchema: o.input_schema || { type: 'object', properties: {} },
  }));
}

function envoyerSse(res, message) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(`data: ${JSON.stringify(message)}\n\n`);
  res.end();
}

/**
 * Un appel d'outil arrive du CLI. On ne repond pas : on l'inscrit dans la file
 * des appels en attente et on reveille le tour HTTP qui dort.
 */
function suspendreAppel(session, msg, res) {
  const appel = {
    toolUseId: nouvelId('toolu'),
    nom: msg.params?.name,
    args: msg.params?.arguments || {},
    rpcId: msg.id,
    res,
  };
  session.appels.push(appel);
  parToolUseId.set(appel.toolUseId, session.sid);
  console.log(`[relais ${session.sid}] appel ${appel.nom} -> ${appel.toolUseId}`);

  // Premier appel de la salve : on laisse une courte fenetre aux suivants.
  if (!session.timerGroupage) {
    session.timerGroupage = setTimeout(() => {
      session.timerGroupage = null;
      const rendre = session.rendreLesAppels;
      session.rendreLesAppels = null;
      if (rendre) rendre(session.appels.slice());
    }, FENETRE_GROUPAGE_MS);
  }
}

function monterRoute(app) {
  app.all('/mcp/:sid', (req, res) => {
    const session = sessions.get(req.params.sid);
    if (!session) { res.status(404).end(); return; }
    if (req.method !== 'POST') { res.status(405).end(); return; }

    const msg = req.body || {};
    const { id, method } = msg;

    if (method === 'initialize') {
      envoyerSse(res, { jsonrpc: '2.0', id, result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'claude-proxy-relais', version: '1.0.0' },
      }});
      return;
    }
    if (id === undefined) { res.status(202).end(); return; } // notification
    if (method === 'tools/list') {
      envoyerSse(res, { jsonrpc: '2.0', id, result: { tools: outilsMcp(session) } });
      return;
    }
    if (method === 'tools/call') {
      suspendreAppel(session, msg, res);
      return; // volontairement sans reponse : elle viendra du client
    }
    envoyerSse(res, { jsonrpc: '2.0', id, error: {
      code: -32601, message: `methode inconnue: ${method}`,
    }});
  });
}

/* ------------------------------------------------------------------ */
/* Traduction en blocs de l'API Messages                               */
/* ------------------------------------------------------------------ */

function enveloppe(model, inputTokens) {
  // On renvoie le nom de modele tel que le client l'a demande, suffixe compris.
  return deps.messageEnvelope({ model, inputTokens });
}

function corpsToolUse(appels, texte, model, inputTokens) {
  const content = [];
  if (texte && texte.trim()) content.push({ type: 'text', text: texte });
  for (const a of appels) {
    content.push({ type: 'tool_use', id: a.toolUseId, name: a.nom, input: a.args });
  }
  return {
    ...enveloppe(model, inputTokens),
    content,
    stop_reason: 'tool_use',
    usage: {
      input_tokens: inputTokens,
      output_tokens: deps.estimateTokens(texte || '') + 50,
    },
  };
}

function corpsFinal(texte, model, inputTokens) {
  return {
    ...enveloppe(model, inputTokens),
    content: [{ type: 'text', text: texte || '' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: inputTokens, output_tokens: deps.estimateTokens(texte || '') },
  };
}

/** Meme contenu, decoupe en evenements SSE de l'API Messages. */
function ecrireSse(res, corps) {
  const envoi = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const { content, ...tete } = corps;
  envoi('message_start', { message: { ...tete, content: [] } });
  content.forEach((bloc, i) => {
    if (bloc.type === 'text') {
      envoi('content_block_start', { index: i, content_block: { type: 'text', text: '' } });
      if (bloc.text) envoi('content_block_delta', { index: i, delta: { type: 'text_delta', text: bloc.text } });
    } else {
      envoi('content_block_start', { index: i, content_block: {
        type: 'tool_use', id: bloc.id, name: bloc.name, input: {},
      }});
      envoi('content_block_delta', { index: i, delta: {
        type: 'input_json_delta', partial_json: JSON.stringify(bloc.input),
      }});
    }
    envoi('content_block_stop', { index: i });
  });
  envoi('message_delta', {
    delta: { stop_reason: corps.stop_reason, stop_sequence: null },
    usage: corps.usage,
  });
  envoi('message_stop', {});
  res.end();
}

function repondre(res, corps, stream) {
  if (stream) ecrireSse(res, corps);
  else res.json(corps);
}

/* ------------------------------------------------------------------ */
/* Cycle de vie d'une session                                          */
/* ------------------------------------------------------------------ */

function fermerSession(session, cause) {
  if (!sessions.has(session.sid)) return;
  console.log(`[relais ${session.sid}] fin (${cause})`);
  clearTimeout(session.timerGroupage);
  clearTimeout(session.timerTtl);
  for (const a of session.appels) {
    // Debloquer le CLI plutot que de le laisser pendre sur un appel mort.
    try {
      envoyerSse(a.res, { jsonrpc: '2.0', id: a.rpcId, result: {
        content: [{ type: 'text', text: `relais interrompu: ${cause}` }],
        isError: true,
      }});
    } catch { /* socket deja fermee */ }
    parToolUseId.delete(a.toolUseId);
  }
  session.appels = [];
  sessions.delete(session.sid);
}

function armerTtl(session) {
  clearTimeout(session.timerTtl);
  session.timerTtl = setTimeout(() => fermerSession(session, 'client absent'), TTL_SESSION_MS);
}

/**
 * Attendre le prochain evenement du process claude : soit il appelle des
 * outils, soit il a fini de parler.
 */
function prochainEvenement(session) {
  return new Promise((resolve) => {
    session.rendreLesAppels = (appels) => resolve({ type: 'outils', appels });
    session.promesseCli
      .then((texte) => resolve({ type: 'fin', texte }))
      .catch((erreur) => resolve({ type: 'erreur', erreur }));
    // Une salve deja groupee pendant qu'on n'ecoutait pas.
    if (session.appels.length && !session.timerGroupage) {
      session.rendreLesAppels = null;
      resolve({ type: 'outils', appels: session.appels.slice() });
    }
  });
}

/* ------------------------------------------------------------------ */
/* Point d'entree                                                      */
/* ------------------------------------------------------------------ */

/** Blocs image Anthropic (base64) d'un contenu de tool_result, au format MCP. */
function imagesMcp(contenu) {
  if (!Array.isArray(contenu)) return [];
  return contenu
    .filter((b) => b && b.type === 'image' && b.source && b.source.type === 'base64'
      && typeof b.source.data === 'string')
    .map((b) => ({ type: 'image', data: b.source.data, mimeType: b.source.media_type || 'image/png' }));
}

/** Le dernier message du client porte-t-il des resultats d'outils ? */
function resultatsDuClient(messages) {
  const dernier = messages[messages.length - 1];
  if (!dernier || dernier.role !== 'user' || !Array.isArray(dernier.content)) return [];
  return dernier.content.filter((b) => b && b.type === 'tool_result');
}

async function traiter({ req, res, model, prompt, system, spec, inputTokens, stream }) {
  const messages = req.body?.messages || [];
  const resultats = resultatsDuClient(messages);

  // --- Cas 1 : le client rend des resultats. On reprend la session suspendue.
  if (resultats.length) {
    const sid = parToolUseId.get(resultats[0].tool_use_id);
    const session = sid && sessions.get(sid);
    if (!session) {
      // Session perdue (redemarrage du proxy, TTL). Le dire franchement plutot
      // que de repartir de zero sans le contexte.
      res.status(400).json({ type: 'error', error: {
        type: 'invalid_request_error',
        message: 'Session de relais inconnue ou expiree. Relancer la tache depuis le debut.',
      }});
      return;
    }
    armerTtl(session);
    for (const r of resultats) {
      const i = session.appels.findIndex((a) => a.toolUseId === r.tool_use_id);
      if (i < 0) continue;
      const [appel] = session.appels.splice(i, 1);
      parToolUseId.delete(appel.toolUseId);
      const texte = deps.extractText(r.content);
      // Les images du resultat (attach_image, captures) passent en blocs MCP
      // image : sinon le modele ne recoit que le texte « Loaded ».
      const images = imagesMcp(r.content);
      const contenu = [];
      if (texte || !images.length) contenu.push({ type: 'text', text: texte });
      contenu.push(...images);
      envoyerSse(appel.res, { jsonrpc: '2.0', id: appel.rpcId, result: {
        content: contenu,
        isError: Boolean(r.is_error),
      }});
      console.log(`[relais ${session.sid}] resultat ${appel.nom} (${texte.length} car, ${images.length} image(s))`);
    }
    await attendreEtRepondre(session, res, model, inputTokens, stream);
    return;
  }

  // --- Cas 2 : nouveau tour. On demarre un process claude dedie.
  const outils = Array.isArray(req.body?.tools) ? req.body.tools : [];
  if (!outils.length) {
    res.status(400).json({ type: 'error', error: {
      type: 'invalid_request_error',
      message: `Le suffixe ${SUFFIXE} attend des outils declares dans la requete.`,
    }});
    return;
  }
  const sid = nouvelId('rel');
  const session = {
    sid, outils, appels: [], timerGroupage: null, timerTtl: null,
    rendreLesAppels: null, texteCumule: '',
  };
  sessions.set(sid, session);
  armerTtl(session);
  console.log(`[relais ${sid}] demarrage, ${outils.length} outils du client, modele ${model}`);

  session.promesseCli = deps.runClaude(
    {
      prompt,
      system,
      spec: { ...spec, relaisMcp: { sid, noms: outils.map((o) => o.name) } },
      images: [],
      sessionArgs: [],
    },
    (t) => { session.texteCumule += t; },
  );
  // Un echec du CLI ne doit pas remonter en rejet non gere avant qu'on l'attende.
  session.promesseCli.catch(() => {});

  await attendreEtRepondre(session, res, model, inputTokens, stream);
}

async function attendreEtRepondre(session, res, model, inputTokens, stream) {
  const avant = session.texteCumule.length;
  const ev = await prochainEvenement(session);

  if (ev.type === 'outils') {
    const nouveau = session.texteCumule.slice(avant);
    repondre(res, corpsToolUse(ev.appels, nouveau, model, inputTokens), stream);
    return;
  }
  if (ev.type === 'fin') {
    const texte = ev.texte || session.texteCumule;
    fermerSession(session, 'terminee');
    repondre(res, corpsFinal(texte, model, inputTokens), stream);
    return;
  }
  fermerSession(session, 'echec CLI');
  const message = String(ev.erreur?.message || 'Echec du CLI claude.').slice(0, 2000);
  console.error(`[relais] echec: ${message}`);
  res.status(500).json({ type: 'error', error: { type: 'api_error', message } });
}

/** Arguments a ajouter au CLI pour qu'il voie les outils du client. */
function argsCli(relaisMcp, port) {
  const url = `http://127.0.0.1:${port}/mcp/${relaisMcp.sid}`;
  const conf = { mcpServers: { relay: { type: 'http', url } } };
  return [
    '--mcp-config', JSON.stringify(conf), '--strict-mcp-config',
    // Aucun outil natif du CLI : seuls les outils du client existent, sinon le
    // modele ferait le travail lui-meme et le harnais ne verrait rien passer.
    '--tools', '',
    '--allowed-tools', relaisMcp.noms.map((n) => `mcp__relay__${n}`).join(','),
    // Pas de CLAUDE.md ni de hooks : un harnais externe apporte ses propres
    // consignes, celles de la machine n'ont rien a faire dans sa session.
    '--setting-sources', '',
  ];
}

export { init, detecter, monterRoute, traiter, argsCli, SUFFIXE, sessions };
