import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

let root, home, port, server, fake;
let logs = '';
const fixtureSystem = 'Instruction métier du client, conservée exactement.';

async function startServer() {
  server = spawn(process.execPath, [path.resolve('server.js')], { cwd: root, env: {
    ...process.env, HOME: home, CLAUDE_BIN: fake, PORT: String(port), RECORDS: path.join(root, 'records.jsonl'),
    CLAUDE_PROXY_DEBUG: '', CLAUDE_RESUME: '1', PRIME_MODELE: '', PROXY_STEER: '0',
    CLAUDE_PROXY_DUMP_PAYLOADS: '', CLAUDE_PROXY_DUMP_DIR: path.join(root, 'payload-dumps'),
    CLAUDE_SESSIONS_FICHIER: path.join(root, 'sessions.json'), PROXY_USAGE_LOG: path.join(root, 'usage.jsonl'),
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', d => { logs += String(d); });
  server.stderr.on('data', d => { logs += String(d); });
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    if (server.exitCode !== null) throw new Error(`proxy exited ${server.exitCode}: ${logs.slice(-800)}`);
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`proxy readiness timeout: ${logs.slice(-800)}`);
}
async function stopServer() {
  if (server && server.exitCode === null) { const exit = once(server, 'exit'); server.kill('SIGTERM'); await exit; }
}

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'proxy-fix-'));
  home = path.join(root, 'home');
  await mkdir(path.join(home, '.claude'), { recursive: true });
  await mkdir(path.join(home, '.hermes'), { recursive: true });
  await mkdir(path.join(root, 'payload-dumps'));
  await writeFile(path.join(home, '.claude', 'lecons-refus.md'), 'NE PAS INJECTER LEÇONS TEST');
  const sock = net.createServer();
  await new Promise(resolve => sock.listen(0, '127.0.0.1', resolve));
  port = sock.address().port; await new Promise(resolve => sock.close(resolve));
  fake = path.join(root, 'fake-claude');
  await writeFile(fake, `#!/usr/bin/env node
const fs=require('fs');let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{
const args=process.argv.slice(2);fs.appendFileSync(process.env.RECORDS,JSON.stringify({args,stdin:s,credentialIsFixtureAccount:process.env.CLAUDE_CODE_OAUTH_TOKEN==='fixture-only-not-real'})+'\\n');
const p=args.indexOf('--session-id'),r=args.indexOf('--resume');const sid=p>=0?args[p+1]:r>=0?args[r+1]:'mock';
console.log(JSON.stringify({type:'assistant',message:{role:'assistant',content:[{type:'text',text:'ok'}]}}));
console.log(JSON.stringify({type:'result',subtype:'success',result:'ok',session_id:sid,usage:{input_tokens:1,output_tokens:1}}));});
`);
  await chmod(fake, 0o755);
  await startServer();
});
after(async () => { await stopServer(); if (root) await rm(root, { recursive: true, force: true }); });

async function request(model, system = fixtureSystem, messages = [{ role: 'user', content: 'Une opération de test local sans appel externe.' }], extra = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, system, messages, ...extra }) });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { response, data };
}
async function latest() { return JSON.parse((await readFile(path.join(root, 'records.jsonl'), 'utf8')).trim().split('\n').at(-1)); }

test('preserves client system prompt without automatic extra instructions', async () => {
  const { response, data } = await request('claude-sonnet-5-5');
  assert.equal(response.status, 200, JSON.stringify(data));
  const got = await latest();
  assert.ok(!got.args.includes('--append-system-prompt'));
  assert.equal(got.args[got.args.indexOf('--system-prompt') + 1], fixtureSystem);
  assert.equal(got.args[got.args.indexOf('--system-prompt-snapshot') + 1], 'off');
});

test('preserves a requested legacy model instead of silently upgrading it', async () => {
  const { response, data } = await request('claude-opus-4-7');
  assert.equal(response.status, 200, JSON.stringify(data));
  const got = await latest();
  assert.equal(got.args[got.args.indexOf('--model') + 1], 'claude-opus-4-7');
  assert.equal(response.headers.get('x-proxy-resolved-model'), 'claude-opus-4-7');
  assert.equal(data.model, 'claude-opus-4-7');
});

test('health and response honestly disclose CLI cache_control limitation', async () => {
  const data = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(data.cacheControl.endToEnd, false);
  assert.match(data.cacheControl.warning, /CLI/);
  const marker = { type: 'ephemeral' };
  const { response } = await request('claude-sonnet-5-5', fixtureSystem,
    [{ role: 'user', content: [{ type: 'text', text: 'Marqueur de cache test.', cache_control: marker }] }], { cache_control: marker });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-proxy-cache-control'), 'cli-managed-not-forwarded');
});

test('payload dumps are disabled by default in the configured isolated directory', async () => {
  const { response } = await request('claude-sonnet-5-5');
  assert.equal(response.status, 200);
  assert.deepEqual(await readdir(path.join(root, 'payload-dumps')), []);
});

test('resumes a conversation after a graceful server restart', async () => {
  const messages = [{ role: 'user', content: 'Continuité unique : message initial du test de redémarrage.' }];
  for (let turn = 0; turn < 3; turn++) {
    const { response, data } = await request('claude-sonnet-5-5', fixtureSystem, messages);
    assert.equal(response.status, 200, JSON.stringify(data));
    messages.push({ role: 'assistant', content: data.content }, { role: 'user', content: `Continuité unique : suite ${turn}.` });
  }
  assert.ok((await latest()).args.includes('--resume'), 'continuity before restart');
  await stopServer();
  const stored = JSON.parse(await readFile(path.join(root, 'sessions.json'), 'utf8'));
  assert.ok(stored.length > 0);
  await startServer();
  const { response, data } = await request('claude-sonnet-5-5', fixtureSystem, messages);
  assert.equal(response.status, 200, JSON.stringify(data));
  assert.ok((await latest()).args.includes('--resume'), 'continuity after restart');
});

test('tool relay keeps the client system prompt and exact model', async () => {
  const { response, data } = await request('claude-opus-4-7-toolrelay', fixtureSystem,
    [{ role: 'user', content: [{ type: 'text', text: 'Relais local sans outil exécuté.', cache_control: { type: 'ephemeral' } }] }],
    { tools: [{ name: 'outil_test', description: 'fixture', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } }] });
  assert.equal(response.status, 200, JSON.stringify(data));
  const got = await latest();
  assert.equal(got.args[got.args.indexOf('--model') + 1], 'claude-opus-4-7');
  assert.equal(got.args[got.args.indexOf('--system-prompt') + 1], fixtureSystem);
  assert.equal(response.headers.get('x-proxy-cache-control'), 'cli-managed-not-forwarded');
  const messages = [{ role: 'user', content: 'Continuité du relais avant et après redémarrage.' }];
  const tools = [{ name: 'outil_test', input_schema: { type: 'object' } }];
  const first = await request('claude-sonnet-5-5-toolrelay', fixtureSystem, messages, { tools });
  assert.equal(first.response.status, 200);
  messages.push({ role: 'assistant', content: first.data.content }, { role: 'user', content: 'Suite du relais après redémarrage.' });
  await stopServer();
  await startServer();
  const next = await request('claude-sonnet-5-5-toolrelay', fixtureSystem, messages, { tools });
  assert.equal(next.response.status, 200, JSON.stringify(next.data));
  assert.ok((await latest()).args.includes('--resume'), 'tool relay continuity after restart');
});

test('anonymous short auxiliary call runs text-only, named or -tools callers keep tools', async () => {
  const outils = async () => { const a = (await latest()).args; return a[a.indexOf('--tools') + 1]; };
  const msg = [{ role: 'user', content: 'Appel anonyme court, sans famille connue.' }];
  assert.equal((await request('claude-sonnet-5-5', fixtureSystem, msg)).response.status, 200);
  assert.equal(await outils(), '', 'anonyme court : texte seul');
  assert.ok((await latest()).args.includes('--setting-sources'));
  const journal = (await readFile(path.join(root, 'usage.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  assert.equal(journal.at(-1).famille, 'anonyme-court');
  await request('claude-sonnet-5-5', fixtureSystem, msg, { metadata: { user_id: 'systemd:essai-nomme' } });
  assert.notEqual(await outils(), '', 'appelant nomme : outils gardes');
  await request('claude-sonnet-5-5-tools', fixtureSystem, msg);
  assert.notEqual(await outils(), '', 'suffixe -tools : outils gardes');
  assert.equal((await latest()).args[(await latest()).args.indexOf('--model') + 1], 'claude-sonnet-5-5');
  await request('claude-sonnet-5-5', 'x'.repeat(2500), msg);
  assert.notEqual(await outils(), '', 'consigne longue : outils gardes');
});

test('tool relay uses the configured current account instead of the unit token', async () => {
  await stopServer();
  const dir = path.join(home, '.config', 'claude-proxy');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'oauth.env'), 'CLAUDE_CODE_OAUTH_TOKEN=fixture-only-not-real\n');
  await writeFile(path.join(dir, 'comptes.json'), JSON.stringify({ comptes: [{ nom: 'fixture', fichier: 'oauth.env' }] }));
  await startServer();
  const { response, data } = await request('claude-sonnet-5-5-toolrelay', fixtureSystem,
    [{ role: 'user', content: 'Compte du relais : test isolé.' }],
    { tools: [{ name: 'outil_test', input_schema: { type: 'object' } }] });
  assert.equal(response.status, 200, JSON.stringify(data));
  assert.equal((await latest()).credentialIsFixtureAccount, true);
});

test('exhausted account stops a new tool relay with HTTP 429 before launching CLI', async () => {
  await stopServer();
  const dir = path.join(home, '.config', 'claude-proxy');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'oauth.env'), 'CLAUDE_CODE_OAUTH_TOKEN=fixture-only-not-real\n');
  await writeFile(path.join(dir, 'comptes.json'), JSON.stringify({ comptes: [{ nom: 'fixture', fichier: 'oauth.env' }] }));
  await writeFile(path.join(dir, 'comptes-etat.json'), JSON.stringify({ fixture: { jusqua: Date.now() + 3600000 } }));
  await startServer();
  const before = (await readFile(path.join(root, 'records.jsonl'), 'utf8')).trim().split('\n').length;
  const { response, data } = await request('claude-sonnet-5-5-toolrelay', fixtureSystem,
    [{ role: 'user', content: 'Nouveau relais pendant quota épuisé.' }],
    { stream: true, tools: [{ name: 'outil_test', input_schema: { type: 'object' } }] });
  assert.equal(response.status, 429, JSON.stringify(data));
  assert.equal(data.error.type, 'rate_limit_error');
  const after = (await readFile(path.join(root, 'records.jsonl'), 'utf8')).trim().split('\n').length;
  assert.equal(after, before, 'no CLI launch while all accounts are exhausted');
});
