const U = 'http://127.0.0.1:8977/v1/messages';
const enrichi = (n) => `<contexte-session>${'x'.repeat(900)}</contexte-session>\nmessage ${n}`;
const nu = (n) => `message ${n}`;
const post = async (messages) => {
  const r = await fetch(U, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 100, system: 'sys', messages }) });
  await r.text();
};
const a = { role: 'assistant', content: 'ok' };
const outils = (i) => [{ role: 'assistant', content: `outil ${i}` }, { role: 'user', content: `resultat ${i}` }];
await post([{ role: 'user', content: enrichi(1) }]);
await post([{ role: 'user', content: nu(1) }, a, { role: 'user', content: enrichi(2) }]);
await post([{ role: 'user', content: nu(1) }, a, { role: 'user', content: nu(2) }, ...outils(1), ...outils(2), a, { role: 'user', content: enrichi(3) }]);
await post([{ role: 'user', content: nu(1) }, a, { role: 'user', content: nu(2) }, ...outils(1), ...outils(2), a, { role: 'user', content: nu(3) }, ...outils(3), a, { role: 'user', content: enrichi(4) }]);
