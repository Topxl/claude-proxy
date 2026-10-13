// Scenario du 2026-10-05 (topic 8164) : apres un /stop, Hermes renvoie le meme
// historique, mais la tete de son prompt systeme a change. Le tour suivant doit
// reprendre la session coupee, pas repartir neuf avec l'historique aplati.
const U = 'http://127.0.0.1:8978/v1/messages';
const enrichi = (n) => `<contexte-session>${'x'.repeat(900)}</contexte-session>\nmessage ${n}`;
const nu = (n) => `message ${n}`;
const post = async (system, messages) => {
  const r = await fetch(U, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 100, system, messages }) });
  await r.text();
};
const sys1 = 'tete A\nthread: 9001';
const sys2 = 'tete B, changee apres le stop\nthread: 9001';
const a = { role: 'assistant', content: 'ok' };
const partiel = { role: 'assistant', content: 'Je remplis l adresse, 5 min.' };
const u = (t) => ({ role: 'user', content: t });
const base = [u(nu(1)), a, u(nu(2)), a];
await post(sys1, [u(enrichi(1))]);
await post(sys1, [u(nu(1)), a, u(enrichi(2))]);
console.log('--- 3 : tour coupe par /stop, tete changee : reprise attendue');
await post(sys2, [...base, u(nu(3)), partiel, u(enrichi(4))]);
console.log('--- 4 : autre topic, meme historique : neuve attendue');
await post('tete B, changee apres le stop\nthread: 9002', [...base, u(nu(3)), partiel, u(nu(4)), a, u(enrichi(5))]);
console.log('--- 5 : /undo puis nouveau message : neuve attendue');
await post('tete C\nthread: 9001', [u(nu(1)), a, u(enrichi(9))]);
