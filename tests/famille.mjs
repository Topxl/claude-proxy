// Incident du 2026-09-24 : le calcul du titre et la reponse partent ensemble,
// meme premier message, prompts systeme differents. Le tour suivant ne doit
// jamais reprendre la session du titre.
const U = 'http://127.0.0.1:8978/v1/messages';
const post = async (system, messages) => {
  const r = await fetch(U, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 100, system, messages }) });
  await r.text();
};
const titre = 'Genere un titre court en JSON {"title": ...}';
const principal = 'Tu es Hermes, assistant de VJ. '.repeat(40);
const m1 = { role: 'user', content: '[Vin] Ok, ce channel va etre un topic de plus' };
await post(titre, [m1]);
// Hermes enrichit le message courant de la reponse, pas celui du titre, puis
// ne garde que le texte nu dans son historique.
const enrichi = { role: 'user', content: `<contexte-session>${'x'.repeat(900)}</contexte-session>\n${m1.content}` };
await post(principal, [enrichi]);
await post(principal, [m1, { role: 'assistant', content: 'ok' }, { role: 'user', content: '[Vin] Comment accroitre les ventes ?' }]);
