import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MetaAnalyzer, diagnoseVerdict } from '../src/intelligence/meta.ts';
import { authorizeCommand } from '../src/server/auth.ts';
import { commandSchema } from '../src/server/schemas.ts';
import { HiveService } from '../src/service.ts';
import { Store } from '../src/store/sqlite.ts';

const KEY = 'throwaway-diagnose-key-123';
type Reply = { status: number; body: unknown; headers?: Record<string, string> };
type Seen = { method: string; url: string; auth: string; body: string };

/** Fake OpenAI-compatible provider plus an IP echo endpoint, all on 127.0.0.1. */
async function provider(routes: { models: Reply; chat: Reply; ip?: Reply }) {
  const seen: Seen[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', chunk => { body += String(chunk); });
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', auth: String(req.headers.authorization ?? ''), body });
      const reply = req.url === '/v1/models' ? routes.models : req.url === '/v1/chat/completions' ? routes.chat : req.url === '/ip' ? routes.ip ?? { status: 200, body: { ip: '203.0.113.7' } } : { status: 404, body: {} };
      res.writeHead(reply.status, { 'Content-Type': 'application/json', ...reply.headers }).end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  return { seen, server, base: `http://127.0.0.1:${port}`, port, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

function analyzer(base: string, options: Partial<ConstructorParameters<typeof MetaAnalyzer>[0]> = {}) {
  return new MetaAnalyzer({ apiKey: KEY, baseUrl: `${base}/v1`, proxyUrl: null, ipLookupUrl: `${base}/ip`, maxAttempts: 1, timeoutMs: 2000, ...options });
}
const chatOk: Reply = { status: 200, body: { model: 'muse-spark-1.3', choices: [{ message: { content: 'OK' } }], usage: { total_tokens: 6 } }, headers: { 'x-request-id': 'req-chat-1' } };
const modelsOk: Reply = { status: 200, body: { object: 'list', data: [{ id: 'muse-spark-1.3' }, { id: 'muse-mini' }] } };

test('diagnose: not configured sends nothing to the provider', async () => {
  const p = await provider({ models: modelsOk, chat: chatOk });
  try {
    const result = await analyzer(p.base, { apiKey: '' }).diagnose();
    assert.equal(result.verdict, 'not_configured');
    assert.equal(result.configured, false);
    assert.equal(result.modelsStatus, null);
    assert.equal(result.chatStatus, null);
    assert.deepEqual(p.seen.filter(s => s.url.startsWith('/v1')), [], 'no provider request without a key');
    assert.match(result.hints.join(' '), /MODEL_API_KEY/);
  } finally { await p.close(); }
});

test('diagnose: 401 is key_rejected and an echoed key never reaches the result', async () => {
  const p = await provider({ models: { status: 401, body: { error: { message: `Invalid key ${KEY}` } } }, chat: { status: 401, body: { error: { message: 'Invalid key' } } } });
  try {
    const result = await analyzer(p.base).diagnose();
    assert.equal(result.verdict, 'key_rejected');
    assert.equal(result.modelsStatus, 401);
    assert.equal(JSON.stringify(result).includes(KEY), false, 'key redacted from excerpts');
    assert.match(result.modelsExcerpt, /\[redacted\]/);
    assert.match(result.hints[0]!, /rejected the key \(HTTP 401\)/);
  } finally { await p.close(); }
});

test('diagnose: an empty model list with a 404 chat is no_models_for_host, naming the egress IP and request ids', async () => {
  const p = await provider({ models: { status: 200, body: { object: 'list', data: [] }, headers: { 'x-fb-trace-id': 'trace-abc' } },
    chat: { status: 404, body: { error: { message: 'The requested model was not found.' } }, headers: { 'x-request-id': 'req-404' } } });
  try {
    const result = await analyzer(p.base).diagnose();
    assert.equal(result.verdict, 'no_models_for_host');
    assert.equal(result.modelsCount, 0);
    assert.equal(result.modelListed, false);
    assert.equal(result.chatStatus, 404);
    assert.match(result.chatExcerpt, /requested model was not found/);
    assert.deepEqual(result.requestIds, ['models x-fb-trace-id=trace-abc', 'chat x-request-id=req-404']);
    assert.equal(result.egressIp, '203.0.113.7');
    assert.match(result.hints.join(' '), /offers no models to this host .*203\.0\.113\.7/);
    assert.match(result.hints.join(' '), /HIVE_MODEL_PROXY_URL/);
  } finally { await p.close(); }
});

test('diagnose: 429 is rate_limited with Retry-After', async () => {
  const p = await provider({ models: modelsOk, chat: { status: 429, body: { error: { message: 'slow down' } }, headers: { 'retry-after': '7' } } });
  try {
    const result = await analyzer(p.base).diagnose();
    assert.equal(result.verdict, 'rate_limited');
    assert.match(result.hints[0]!, /Retry-After 7 s/);
    assert.equal(p.seen.filter(s => s.url === '/v1/chat/completions').length, 1, 'diagnose never retries');
  } finally { await p.close(); }
});

test('diagnose: reachable uses a one-token chat completion with the hub key; egress lookup failure is null', async () => {
  const p = await provider({ models: modelsOk, chat: chatOk, ip: { status: 500, body: 'nope' } });
  try {
    const result = await analyzer(p.base).diagnose();
    assert.equal(result.verdict, 'reachable');
    assert.equal(result.modelsCount, 2);
    assert.equal(result.modelListed, true);
    assert.equal(result.egressIp, null);
    const chat = p.seen.find(s => s.url === '/v1/chat/completions')!;
    assert.equal(chat.auth, `Bearer ${KEY}`);
    const body = JSON.parse(chat.body) as { max_tokens: number; model: string };
    assert.equal(body.max_tokens, 1);
    assert.equal(body.model, 'muse-spark-1.3');
  } finally { await p.close(); }
});

test('diagnose: an unreachable provider is network_error', async () => {
  const p = await provider({ models: modelsOk, chat: chatOk });
  const dead = p.base; await p.close();
  const result = await analyzer(dead, { ipLookupUrl: null }).diagnose();
  assert.equal(result.verdict, 'network_error');
  assert.equal(result.chatStatus, null);
  assert.match(result.hints[0]!, /Could not reach 127\.0\.0\.1/);
});

test('verdict order: a rejected key wins over 404; a working chat wins over an odd model list', () => {
  assert.equal(diagnoseVerdict(404, null, 401), 'key_rejected');
  assert.equal(diagnoseVerdict(200, 0, 200), 'reachable');
  assert.equal(diagnoseVerdict(200, 3, 404), 'no_models_for_host');
  assert.equal(diagnoseVerdict(200, 3, 500), 'network_error');
});

/** Minimal CONNECT proxy: records each tunnel, optionally refuses with 407. */
async function connectProxy(options: { refuse?: boolean } = {}) {
  const tunnels: { authority: string; auth: string }[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((_req, res) => { res.writeHead(400).end('CONNECT only'); });
  server.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => {
    tunnels.push({ authority: req.url ?? '', auth: String(req.headers['proxy-authorization'] ?? '') });
    sockets.add(client);
    if (options.refuse) { client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
    const [host, port] = (req.url ?? '').split(':');
    const upstream = netConnect(Number(port), host!, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client); client.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  return { tunnels, port, close: () => new Promise<void>(resolve => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }) };
}

test('HIVE_MODEL_PROXY_URL: diagnose and analyze go through a CONNECT tunnel', async () => {
  const p = await provider({ models: modelsOk, chat: { status: 200, body: { model: 'muse-spark-1.3', choices: [{ message: { content: JSON.stringify({ summary: 'nothing', findings: [] }) } }] } } });
  const proxy = await connectProxy();
  try {
    const meta = analyzer(p.base, { proxyUrl: `http://hive:s3cret@127.0.0.1:${proxy.port}` });
    assert.equal(meta.proxy, true);
    const result = await meta.diagnose();
    assert.equal(result.verdict, 'reachable');
    assert.equal(result.proxy, true);
    assert.equal(result.egressIp, '203.0.113.7');
    // models, chat and the egress lookup each opened a tunnel to the provider's host:port.
    assert.equal(proxy.tunnels.length, 3);
    for (const t of proxy.tunnels) {
      assert.equal(t.authority, `127.0.0.1:${p.port}`);
      assert.equal(t.auth, `Basic ${Buffer.from('hive:s3cret').toString('base64')}`);
    }
    const analysis = await meta.analyze({ revision: 0, inputHash: 'x', intents: [], candidates: [], contracts: [], symbols: [], dependents: [] }, []);
    assert.equal(analysis.summary, 'nothing');
    assert.equal(proxy.tunnels.length, 4, 'analysis used the tunnel too');
    assert.equal(p.seen.filter(s => s.url === '/v1/chat/completions').length, 2);
  } finally { await proxy.close(); await p.close(); }
});

test('a proxy that refuses CONNECT is a network_error without leaking proxy credentials; analyze reports it in a human sentence', async () => {
  const p = await provider({ models: modelsOk, chat: chatOk });
  const proxy = await connectProxy({ refuse: true });
  try {
    const meta = analyzer(p.base, { proxyUrl: `http://hive:s3cret@127.0.0.1:${proxy.port}`, ipLookupUrl: null });
    const result = await meta.diagnose();
    assert.equal(result.verdict, 'network_error');
    assert.match(result.chatExcerpt, /refused CONNECT .*HTTP 407/);
    assert.equal(JSON.stringify(result).includes('s3cret'), false);
    assert.equal(p.seen.length, 0, 'nothing reached the provider');
    await assert.rejects(meta.analyze({ revision: 0, inputHash: 'x', intents: [], candidates: [], contracts: [], symbols: [], dependents: [] }, []),
      (error: Error) => /^The model provider could not be reached from this server through HIVE_MODEL_PROXY_URL\. Details: /.test(error.message) && !error.message.includes('s3cret'));
  } finally { await proxy.close(); await p.close(); }
});

const fixture = fileURLToPath(new URL('../fixtures/billing/', import.meta.url));
test('model_diagnose: admin only; the hub keeps the last result in its snapshot; a 404 analysis starts with a human sentence', async () => {
  const command = commandSchema.parse({ action: 'model_diagnose' });
  assert.throws(() => authorizeCommand({ role: 'member', member: 'sanika', tokenId: 't1' }, command, () => undefined), /admin token required/);
  assert.throws(() => authorizeCommand({ role: 'member', member: 'sanika', tokenId: 't2', kind: 'connector' }, command, () => undefined), /admin token required/);
  assert.doesNotThrow(() => authorizeCommand({ role: 'admin', member: 'operator', tokenId: null }, command, () => undefined));

  const p = await provider({ models: { status: 200, body: { data: [] } }, chat: { status: 404, body: { error: { message: 'The requested model was not found.' } } } });
  const dir = mkdtempSync(join(tmpdir(), 'hive-diag-'));
  cpSync(fixture, dir, { recursive: true });
  try {
    const service = new HiveService({ store: new Store(), root: dir, analyzer: analyzer(p.base) });
    const before = service.snapshot().model;
    assert.equal(before.lastDiagnose, null);
    assert.equal(before.baseUrlHost, `127.0.0.1:${p.port}`);
    assert.equal(before.proxy, false);
    assert.equal(JSON.stringify(before).includes(KEY), false);
    const result = await service.analysis.diagnose();
    assert.equal(result.verdict, 'no_models_for_host');
    assert.equal(service.snapshot().model.lastDiagnose?.verdict, 'no_models_for_host');
    const session = service.coordinator.register('pricing');
    const analysis = await service.analyze(session.id);
    assert.equal(analysis.status, 'unavailable');
    assert.match(analysis.error!, /^The model provider is not reachable from this server \(HTTP 404, no models offered to this host\)\. Details: Meta API HTTP 404/);
  } finally { rmSync(dir, { recursive: true, force: true }); await p.close(); }
});

test('connect setup never writes MODEL_API_KEY and removes one stored by an older setup', async () => {
  process.env.HIVE_CONNECT_NO_MAIN = '1';
  const { mergeSettings } = await import('../src/hooks/connect.ts');
  const merged = mergeSettings({ env: { MODEL_API_KEY: 'old-laptop-key', OTHER: 'kept' }, permissions: { allow: ['Bash'] } }, 'https://hub.example', 'member-token');
  assert.deepEqual(merged.env, { OTHER: 'kept', HIVE_URL: 'https://hub.example', HIVE_TOKEN: 'member-token' });
  assert.deepEqual(merged.permissions, { allow: ['Bash'] });
  assert.equal(JSON.stringify(merged).includes('old-laptop-key'), false);
});
