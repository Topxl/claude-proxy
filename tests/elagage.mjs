// Demarrage a froid : les vieux resultats d'outils (> 10 tours) sont coupes
// a 1500 car dans le prompt ; un historique court reste intact.
const U = 'http://127.0.0.1:8984/v1/messages';
const gros = 'x'.repeat(5000);
const outil = (i) => [
  { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: 'ls' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: gros }] },
];
const long = [{ role: 'user', content: 'debut' }];
for (let i = 0; i < 15; i += 1) long.push(...outil(i));
long.push({ role: 'assistant', content: 'ok' }, { role: 'user', content: 'question finale' });
const court = [{ role: 'user', content: 'debut' }, ...outil(0), { role: 'assistant', content: 'ok' }, { role: 'user', content: 'q' }];
const post = async (messages, system) => {
  const r = await fetch(U, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-opus-4-8', max_tokens: 50, system, messages }) });
  await r.text();
};
await post(long, 'Tu es Hermes, assistant de VJ. '.repeat(20));
await post(court, 'Autre systeme de test. '.repeat(20));
