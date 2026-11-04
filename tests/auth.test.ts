import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store/sqlite.ts';
import { TokenService, hashToken, TOKEN_PATTERN } from '../src/server/tokens.ts';
import { AuthError, authorizeCommand, authorizeRoute, resolveAuth, type Auth } from '../src/server/auth.ts';
import { sanitizeView, scrubText, type ServiceSnapshot } from '../src/service.ts';

const ADMIN = 'throwaway-admin-token-for-tests';
const fixtureRoot = fileURLToPath(new URL('../fixtures/billing', import.meta.url));
const SESSION_A = '11111111-1111-4111-8111-111111111111';
const SESSION_B = '22222222-2222-4222-8222-222222222222';

test('tokens: shown once, only the sha256 hash is stored, revoke and rename work, last_used_at is throttled', () => {
  const store = new Store(':memory:');
  let now = 1_000_000;
  const tokens = new TokenService(store, () => now);
  const { token, record } = tokens.create({ label: 'Alice laptop', member: 'alice', role: 'member', createdBy: 'operator' });
  assert.match(token, TOKEN_PATTERN);
  assert.ok(token.startsWith('hive_mem_'));
  assert.match(tokens.create({ label: 'Judge', member: 'judges', role: 'viewer', createdBy: 'operator' }).token, /^hive_view_[0-9A-Za-z]{32}$/);
  assert.match(tokens.create({ label: 'Ops', member: 'ops', role: 'admin', createdBy: 'operator' }).token, /^hive_adm_[0-9A-Za-z]{32}$/);
  const row = store.get<Record<string, unknown>>('SELECT * FROM tokens WHERE id = ?', record.id)!;
  assert.equal(row.hash, hashToken(token));
  assert.equal(row.prefix, token.slice('hive_mem_'.length, 'hive_mem_'.length + 8));
  assert.ok(!JSON.stringify(store.all('SELECT * FROM tokens')).includes(token), 'the token value is never persisted');
  assert.ok(!('hash' in record) && !JSON.stringify(tokens.list()).includes(String(row.hash)), 'metadata never carries the hash');

  assert.equal(tokens.resolve(token)?.lastUsedAt, now);
  now += 30_000;
  assert.equal(tokens.resolve(token)?.lastUsedAt, 1_000_000, 'not touched again within a minute');
  now += 31_000;
  assert.equal(tokens.resolve(token)?.lastUsedAt, now);

  assert.equal(tokens.resolve(`${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`), undefined);
  assert.equal(tokens.resolve('not-a-token'), undefined);
  assert.equal(tokens.rename(record.id, 'Alice desktop').label, 'Alice desktop');
  assert.throws(() => tokens.rename(record.id, '   '), /label/);
  assert.throws(() => tokens.revoke('00000000-0000-4000-8000-000000000000'), /Unknown token/);
  assert.ok(tokens.revoke(record.id).revokedAt);
  assert.equal(tokens.resolve(token), undefined, 'revoked tokens no longer authenticate');
  store.close();
});

test('auth: admin bootstrap, unknown bearer is 401, viewer routes and member session ownership', () => {
  const store = new Store(':memory:');
  const tokens = new TokenService(store);
  const viewer = tokens.create({ label: 'J', member: 'judges', role: 'viewer', createdBy: 'operator' });
  assert.deepEqual(resolveAuth(`Bearer ${ADMIN}`, { adminToken: ADMIN, tokens }), { role: 'admin', member: 'operator', tokenId: null });
  assert.equal(resolveAuth(`Bearer ${viewer.token}`, { adminToken: ADMIN, tokens }).role, 'viewer');
  for (const header of [undefined, '', 'Bearer', `Basic ${ADMIN}`, `Bearer ${ADMIN}x`]) {
    assert.throws(() => resolveAuth(header, { adminToken: ADMIN, tokens }), (error: unknown) => error instanceof AuthError && error.status === 401);
  }
  const viewerAuth: Auth = { role: 'viewer', member: 'judges', tokenId: viewer.record.id };
  for (const path of ['/api/view', '/me', '/events', '/healthz']) authorizeRoute(viewerAuth, 'GET', path);
  for (const [method, path] of [['GET', '/snapshot'], ['POST', '/command'], ['POST', '/api/view']] as const)
    assert.throws(() => authorizeRoute(viewerAuth, method, path), (error: unknown) => error instanceof AuthError && error.status === 403);
  assert.throws(() => authorizeCommand(viewerAuth, { action: 'sync' }, () => undefined), /read-only/);

  const alice: Auth = { role: 'member', member: 'alice', tokenId: 'tok-a' };
  const owners: Record<string, { tokenId: string | null }> = { [SESSION_A]: { tokenId: 'tok-a' }, [SESSION_B]: { tokenId: 'tok-b' } };
  authorizeCommand(alice, { action: 'heartbeat', sessionId: SESSION_A }, id => owners[id]);
  assert.throws(() => authorizeCommand(alice, { action: 'heartbeat', sessionId: SESSION_B }, id => owners[id]), /another member/);
  assert.throws(() => authorizeCommand(alice, { action: 'token_list' }, () => undefined), /admin/);
  authorizeCommand({ role: 'admin', member: 'operator', tokenId: null }, { action: 'heartbeat', sessionId: SESSION_B }, id => owners[id]);
  store.close();
});

test('viewer projection drops absolute paths, payloads, assumptions, diffs and token strings', () => {
  const root = '/srv/private/acme-repo';
  const leaked = 'hive_mem_ABCDEFGHabcdefgh0123456789ABCDEF';
  const snapshot = {
    repository: { id: 'r', canonicalRoot: root, revision: 7 },
    workspaces: [{ id: 'w', repositoryId: 'r', realRoot: root, baseCommit: null }],
    sessions: [{ id: SESSION_A, name: 'claude-a', workspaceId: 'w', client: null, expiresAt: 0, status: 'active', member: 'alice', tokenId: 'tok-a' }],
    intents: [{ sessionId: SESSION_A, revision: 1, task: `Fix ${root}/src/pricing.ts ${'x'.repeat(300)}`, files: ['src/pricing.ts', '/etc/passwd'], symbols: [],
      assumptions: [{ key: 'secret-assumption', value: 'cents' }], at: 1 }],
    contracts: [{ id: 'c1', version: 2, title: 'Price in cents', ownerSessionId: SESSION_A, producerSymbol: 'src/pricing.ts#getPrice:function',
      declaration: 'export function getPrice(): number', behaviorNotes: 'private notes', participants: [SESSION_A, SESSION_B], acknowledgements: [SESSION_A],
      acknowledgementDetails: [{ sessionId: SESSION_A, version: 2, intentRevision: 1, at: 5 }], intentRevisions: {}, status: 'proposed',
      evidence: { staleReason: `edited ${root}/src/x.ts`, verification: { id: 'v1', contractId: 'c1', version: 1, command: 'npm test', status: 'failed', exitCode: 1,
        passed: false, overlay: false, revision: 6, sourceHashes: { 'src/pricing.ts': 'abc' }, output: `FAIL at ${root}/src/x.ts`, reasons: [], at: 4, finishedAt: 5 } },
      history: [{ version: 1, declaration: 'export function getPrice(): string', behaviorNotes: '', participants: [], at: 2 },
        { version: 2, declaration: 'export function getPrice(): number', behaviorNotes: '', participants: [], at: 3 }], createdAt: 1, updatedAt: 5 }],
    findings: [{ kind: 'assumption_mismatch', severity: 'error', sessions: [SESSION_A], source: 'deterministic', evidence: `see ${root}/src/a.ts and /home/u/b.ts token ${leaked}`,
      files: ['src/a.ts', `${root}/src/a.ts`], symbols: ['src/a.ts#a:function'] }],
    events: [{ seq: 1, at: 1, type: 'direct_edit', detail: `changed ${root}/src/a.ts`, payload: { files: ['secret-payload'] } }],
    graph: { workspaceId: 'w', indexed: true, symbols: 3, edges: 1, files: 2, lastSync: null },
    proposals: [{ id: 'p', preview: { diff: 'DIFF-CONTENT' } }], claims: [], model: { configured: false, model: 'muse-spark-1.3' },
    analysis: { id: 'a', status: 'ok', summary: 'All good', findings: [{ explanation: 'EXCERPT' }], model: 'muse-spark-1.3', latencyMs: 900, at: 9 },
  } as unknown as ServiceSnapshot;
  const view = sanitizeView(snapshot, { sessionsById: { [SESSION_A]: { name: 'claude-a', member: 'alice' }, [SESSION_B]: { name: 'claude-b', member: 'bob' } },
    signatures: { c1: [{ version: 1, sessionId: SESSION_B, at: 2 }, { version: 2, sessionId: SESSION_A, at: 5 }] }, runs: {} });
  const json = JSON.stringify(view);
  for (const forbidden of [root, '/home/u', '/etc/passwd', leaked, 'secret-assumption', 'secret-payload', 'DIFF-CONTENT', 'EXCERPT', 'private notes', 'FAIL at', 'abc'])
    assert.ok(!json.includes(forbidden), `view leaked ${forbidden}`);
  assert.equal(view.workspace.name, 'acme-repo');
  // connector: null because this session's token has no checkout report (Hive Connect, spec section 2).
  assert.deepEqual(view.sessions[0], { id: SESSION_A, member: 'alice', agent: 'claude-a', task: view.sessions[0]!.task, step: 'agreement proposed', connector: null });
  assert.ok(view.sessions[0]!.task!.length <= 120 && view.sessions[0]!.task!.startsWith('Fix src/pricing.ts'));
  assert.ok(view.findings[0]!.evidence.length <= 300);
  assert.deepEqual(view.findings[0]!.files, ['src/a.ts']);
  const contract = view.contracts[0]!;
  assert.deepEqual(contract.versions.map(v => v.signedBy.map(s => s.member)), [['bob'], ['alice']]);
  assert.deepEqual(contract.participants.map(p => [p.member, p.signedCurrent]), [['alice', true], ['bob', false]]);
  assert.deepEqual(contract.verification.map(v => [v.command, v.exitCode, v.revision, v.passed, v.status]), [['npm test', 1, 6, false, 'failed']]);
  assert.deepEqual(view.events, [{ seq: 1, at: 1, type: 'direct_edit', detail: 'changed src/a.ts' }]);
  assert.deepEqual(view.analysis, { status: 'ok', summary: 'All good', model: 'muse-spark-1.3', latencyMs: 900, findings: 1, at: 9 });
  assert.equal(scrubText('C:\\Users\\x\\a.ts and ~/b', [], 100), '[path] and [path]');
});

async function unusedPort(): Promise<number> {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

test('daemon: roles over HTTP (viewer read-only, member owns its sessions, admin manages tokens, /me shape)', { timeout: 30_000 }, async () => {
  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  delete env.MODEL_API_KEY;
  Object.assign(env, { HIVE_TOKEN: ADMIN, HIVE_PORT: String(port), HIVE_DB: ':memory:', HIVE_PROJECT_ROOT: fixtureRoot, HIVE_PUBLIC_URL: 'https://hive.example.test' });
  const daemon = spawn(process.execPath, [fileURLToPath(new URL('../src/server/daemon.ts', import.meta.url))], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  const call = async (bearer: string | null, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, json: await response.json() as any };
  };
  try {
    await new Promise<void>((resolve, reject) => {
      let log = '';
      daemon.stderr!.on('data', chunk => { log += String(chunk); if (log.includes('Hive daemon listening')) resolve(); });
      daemon.once('error', reject);
      daemon.once('exit', code => reject(new Error(`Daemon exited ${code}: ${log}`)));
    });
    assert.equal((await call(null, '/me')).status, 401);
    assert.equal((await call('hive_mem_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', '/me')).status, 401);

    // Admin bootstrap via HIVE_TOKEN.
    const adminMe = await call(ADMIN, '/me');
    assert.equal(adminMe.status, 200);
    assert.equal(adminMe.json.role, 'admin');
    assert.equal(adminMe.json.member, 'operator');
    assert.equal(adminMe.json.tokenId, null);
    assert.equal(adminMe.json.workspace.name, 'billing');
    assert.equal(typeof adminMe.json.workspace.id, 'string');
    assert.equal(typeof adminMe.json.workspace.root, 'string');
    assert.equal(adminMe.json.publicUrl, 'https://hive.example.test');
    assert.equal(adminMe.json.model.configured, false);
    assert.equal(adminMe.json.version, '0.1.0');

    const created: Record<string, { token: string; record: { id: string; role: string } }> = {};
    for (const [member, role] of [['alice', 'member'], ['bob', 'member'], ['judges', 'viewer']] as const) {
      const result = await call(ADMIN, '/command', { action: 'token_create', label: `${member} token`, member, role });
      assert.equal(result.status, 200, JSON.stringify(result.json));
      assert.match(result.json.token, TOKEN_PATTERN);
      assert.equal(result.json.record.role, role);
      created[member] = result.json;
    }
    const listed = await call(ADMIN, '/command', { action: 'token_list' });
    assert.equal(listed.json.length, 3);
    const listedText = JSON.stringify(listed.json);
    for (const { token } of Object.values(created)) assert.ok(!listedText.includes(token) && !listedText.includes(hashToken(token)), 'token_list never returns values or hashes');
    assert.equal((await call(ADMIN, '/command', { action: 'token_create', label: 'x', member: 'x', role: 'owner' })).status, 400);

    // Viewer: read-only surface.
    const judge = created.judges!.token;
    const viewerMe = await call(judge, '/me');
    assert.equal(viewerMe.json.role, 'viewer');
    assert.equal(viewerMe.json.member, 'judges');
    assert.equal(viewerMe.json.tokenId, created.judges!.record.id);
    assert.equal('root' in viewerMe.json.workspace, false);
    assert.equal((await call(judge, '/snapshot')).status, 403);
    assert.equal((await call(judge, '/command', { action: 'register', name: 'sneaky' })).status, 403);
    assert.equal((await call(judge, '/command', { action: 'sync' })).status, 403);

    // Members own their sessions.
    const alice = created.alice!.token;
    const bob = created.bob!.token;
    const aliceSession = await call(alice, '/command', { action: 'register', name: 'claude-a' });
    assert.equal(aliceSession.status, 200);
    assert.equal(aliceSession.json.member, 'alice');
    assert.equal(aliceSession.json.tokenId, created.alice!.record.id);
    const bobSession = await call(bob, '/command', { action: 'register', name: 'claude-b' });
    const intent = await call(alice, '/command', { action: 'intent', sessionId: aliceSession.json.id,
      intent: { task: 'Return prices in cents', files: ['src/pricing.ts'], symbols: [], assumptions: [{ key: 'getPrice:unit', value: 'cents' }] } });
    assert.equal(intent.status, 200, JSON.stringify(intent.json));
    const hijack = await call(alice, '/command', { action: 'heartbeat', sessionId: bobSession.json.id });
    assert.equal(hijack.status, 403);
    assert.match(hijack.json.error, /another member/);
    assert.equal((await call(alice, '/command', { action: 'finish', sessionId: bobSession.json.id })).status, 403);
    assert.equal((await call(ADMIN, '/command', { action: 'heartbeat', sessionId: bobSession.json.id })).status, 200, 'admin may act on any session');
    assert.equal((await call(alice, '/command', { action: 'token_list' })).status, 403);
    assert.equal((await call(alice, '/command', { action: 'token_create', label: 'x', member: 'alice', role: 'admin' })).status, 403);
    const aliceMembers = await call(alice, '/command', { action: 'member_list' });
    assert.equal(aliceMembers.status, 200);
    assert.ok(aliceMembers.json.every((m: { tokens: unknown[] }) => m.tokens.length === 0), 'members see no token metadata');
    const adminMembers = await call(ADMIN, '/command', { action: 'member_list' });
    assert.deepEqual(adminMembers.json.find((m: { member: string }) => m.member === 'alice').sessions.map((s: { agent: string; task: string }) => [s.agent, s.task]), [['claude-a', 'Return prices in cents']]);

    const snapshot = await call(ADMIN, '/snapshot');
    assert.deepEqual(snapshot.json.sessions.map((s: { name: string; member: string }) => `${s.member} · ${s.name}`), ['alice · claude-a', 'bob · claude-b']);

    const view = await call(judge, '/api/view');
    assert.equal(view.status, 200);
    assert.deepEqual(view.json.sessions.map((s: { member: string; agent: string; task: string | null; step: string }) => [s.member, s.agent, s.task, s.step]),
      [['alice', 'claude-a', 'Return prices in cents', 'declared intent'], ['bob', 'claude-b', null, 'joined']]);
    const viewText = JSON.stringify(view.json);
    for (const forbidden of [fixtureRoot, ADMIN, alice, bob, judge, 'realRoot', 'assumptions', 'payload', 'proposals'])
      assert.ok(!viewText.includes(forbidden), `view leaked ${forbidden}`);
    const events = await call(judge, '/events');
    assert.equal(events.status, 200);
    assert.ok(events.json.length > 0 && events.json.every((e: Record<string, unknown>) => !('payload' in e) && !JSON.stringify(e).includes(fixtureRoot)));

    // Rename and revoke.
    assert.equal((await call(ADMIN, '/command', { action: 'token_rename', tokenId: created.bob!.record.id, label: 'Bob desktop' })).json.label, 'Bob desktop');
    assert.ok((await call(ADMIN, '/command', { action: 'token_revoke', tokenId: created.alice!.record.id })).json.revokedAt);
    assert.equal((await call(alice, '/me')).status, 401, 'revoked token is refused');
    assert.equal((await call(bob, '/me')).status, 200);
  } finally {
    const exited = once(daemon, 'exit'); daemon.kill();
    if (daemon.exitCode === null) await exited;
  }
});
