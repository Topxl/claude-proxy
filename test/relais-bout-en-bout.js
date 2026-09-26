/**
 * Test du mode relais : un client qui parle l'API Messages d'Anthropic doit
 * recevoir un vrai bloc `tool_use`, executer l'outil lui-meme, rendre le
 * resultat, et obtenir une reponse finale qui en tient compte.
 *
 * Usage : node test/relais-bout-en-bout.js [port] [--stream]
 */
import { execFileSync } from 'child_process';

const PORT = Number(process.argv[2]) || 8000;
const STREAM = process.argv.includes('--stream');
const URL = `http://127.0.0.1:${PORT}/v1/messages`;

const OUTIL = {
  name: 'executer_python',
  description: 'Execute du code Python et renvoie ce que stdout a produit.',
  input_schema: {
    type: 'object',
    properties: { code: { type: 'string', description: 'Le code a executer.' } },
    required: ['code'],
  },
};

// L'outil vit ici, chez le client : si le proxy repond sans passer par lui, le
// test echoue. C'est tout l'objet de la verification.
function executerChezLeClient(code) {
  try {
    return execFileSync('python3', ['-c', code], { encoding: 'utf8', timeout: 20000 });
  } catch (e) {
    return `erreur: ${e.stderr || e.message}`;
  }
}

async function appeler(messages) {
  const reponse = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': 'test' },
    body: JSON.stringify({
      model: 'claude-opus-5-toolrelay',
      max_tokens: 4096,
      stream: STREAM,
      tools: [OUTIL],
      system: 'Tu utilises toujours l outil executer_python pour calculer. Jamais de calcul mental.',
      messages,
    }),
  });
  if (!reponse.ok) throw new Error(`HTTP ${reponse.status}: ${await reponse.text()}`);
  return STREAM ? await recomposerSse(reponse) : await reponse.json();
}

/** Recoller les evenements SSE en un corps de message classique. */
async function recomposerSse(reponse) {
  const texte = await reponse.text();
  const corps = { content: [], stop_reason: null };
  const blocs = [];
  for (const ligne of texte.split('\n')) {
    if (!ligne.startsWith('data: ')) continue;
    const ev = JSON.parse(ligne.slice(6));
    if (ev.type === 'content_block_start') blocs[ev.index] = { ...ev.content_block, _json: '' };
    if (ev.type === 'content_block_delta') {
      const b = blocs[ev.index];
      if (ev.delta.type === 'text_delta') b.text = (b.text || '') + ev.delta.text;
      if (ev.delta.type === 'input_json_delta') b._json += ev.delta.partial_json;
    }
    if (ev.type === 'message_delta') corps.stop_reason = ev.delta.stop_reason;
  }
  corps.content = blocs.map(({ _json, ...b }) => (b.type === 'tool_use' ? { ...b, input: JSON.parse(_json) } : b));
  return corps;
}

(async () => {
  const messages = [{
    role: 'user',
    content: 'Calcule la somme des 500 premiers nombres premiers. Donne le resultat final en une phrase.',
  }];

  console.log(`--- tour 1 (${STREAM ? 'stream' : 'json'}, port ${PORT})`);
  let r = await appeler(messages);
  console.log(`stop_reason: ${r.stop_reason}`);
  let tours = 0;

  while (r.stop_reason === 'tool_use' && tours < 6) {
    tours += 1;
    const appels = r.content.filter((b) => b.type === 'tool_use');
    messages.push({ role: 'assistant', content: r.content });
    const resultats = [];
    for (const a of appels) {
      console.log(`outil demande: ${a.name}`);
      console.log(`code recu:\n${String(a.input.code).split('\n').slice(0, 6).join('\n')}`);
      const sortie = executerChezLeClient(a.input.code);
      console.log(`execute CHEZ LE CLIENT -> ${sortie.trim().slice(0, 120)}`);
      resultats.push({ type: 'tool_result', tool_use_id: a.id, content: sortie });
    }
    messages.push({ role: 'user', content: resultats });
    console.log(`--- tour ${tours + 1}`);
    r = await appeler(messages);
    console.log(`stop_reason: ${r.stop_reason}`);
  }

  const texte = r.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  console.log(`\nreponse finale: ${texte.trim().slice(0, 400)}`);
  const attendu = '824693';
  console.log(`\n${tours} appel(s) d outil relaye(s) au client`);
  // Le modele ecrit volontiers « 824 693 » : on compare les chiffres seuls.
  const chiffres = texte.replace(/[\s\u00a0\u202f,.]/g, '');
  console.log(chiffres.includes(attendu) && tours > 0
    ? `REUSSI: la valeur ${attendu} vient de l outil du client`
    : `ECHEC: valeur ${attendu} absente, ou aucun outil relaye`);
})().catch((e) => { console.error('ECHEC:', e.message); process.exit(1); });
