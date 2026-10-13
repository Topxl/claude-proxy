// Scenario du 2026-10-07 (topic 635) : apres un tour, Hermes lance en fond une
// revue memoire avec le meme historique. Elle doit partir sur une copie
// (--fork-session) et le vrai message suivant doit reprendre la MEME session.
const U = 'http://127.0.0.1:8979/v1/messages';
const enrichi = (n) => `<contexte-session>${'x'.repeat(900)}</contexte-session>\nmessage ${n}`;
const nu = (n) => `message ${n}`;
const sys = 'tete\nthread: 9101';
const post = async (messages) => {
  const r = await fetch(U, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 100, system: sys, messages }) });
  await r.text();
};
const a = { role: 'assistant', content: 'ok' };
const u = (t) => ({ role: 'user', content: t });
await post([u(enrichi(1))]);
await post([u(nu(1)), a, u(enrichi(2))]);
await post([u(nu(1)), a, u(nu(2)), a, u(enrichi(3))]);
console.log('--- revue memoire : copie attendue');
await post([u(nu(1)), a, u(nu(2)), a, u(nu(3)), a, u('Review the conversation above and consider saving to memory if appropriate.')]);
console.log('--- message suivant : reprise de la meme session attendue');
await post([u(nu(1)), a, u(nu(2)), a, u(nu(3)), a, u(enrichi(4))]);
