import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store/sqlite.ts';
import { TOKEN_PATTERN, TokenService } from '../src/server/tokens.ts';
import { PAIRING_TTL_MS, PairingService, RateLimitError, USER_CODE_ALPHABET, connectorLabel } from '../src/server/pairing.ts';
import { AuthError, authorizeCommand, type Auth } from '../src/server/auth.ts';

const ADMIN = 'throwaway-admin-token-for-pairing-tests';
const REPO = { name: 'acme', remoteUrl: 'git@github.com:Acme/Acme-App.git', rootCommit: 'a'.repeat(40) };
const CTX = { ip: '203.0.113.7', hub: 'https://hive.example.test/' };

function setup(options: { maxPendingPerIp?: number; maxPerHour?: number } = {}) {
  const store = new Store(':memory:');
  let now = 1_700_000_000_000;
  const clock = () => now;
  const tokens = new TokenService(store, clock);
  const pairing = new PairingService({ store, tokens, clock, ...options });
  return { store, tokens, pairing, advance: (ms: number) => { now += ms; }, now: () => now };
}

test('pairing lifecycle: start -> pending -> approve -> token returned exactly once -> consumed', () => {
  const { store, tokens, pairing, now } = setup();
  const started = pairing.start({ repo: REPO, machine: 'alice-mbp', client: 'claude-code' }, CTX);
  assert.match(started.userCode, new RegExp(`^[${USER_CODE_ALPHABET}]{8}$`));
  assert.doesNotMatch(started.userCode, /[01OI]/);
  assert.equal(started.verifyUrl, `https://hive.example.test/ui/pair/${started.userCode}`);
  assert.equal(started.expiresAt, now() + PAIRING_TTL_MS);
  assert.ok(started.pollSecret.length >= 32);
  const stored = JSON.stringify(store.all('SELECT * FROM pairings'));
  assert.ok(!stored.includes(started.pollSecret), 'poll secret is stored only as a hash');
  assert.ok(!stored.includes(CTX.ip), 'requester IP is stored only as a hash');
  assert.ok(!stored.includes('git@github.com'), 'the raw remote URL is not stored');

  const info = pairing.info(started.userCode.toLowerCase().replace(/^(.{4})/, '$1-'));
  assert.deepEqual([info.status, info.machine, info.client, info.repo], ['pending', 'alice-mbp', 'claude-code', { name: 'acme', identity: 'github.com/Acme/Acme-App', rootCommit: 'a'.repeat(40) }]);
  assert.equal(pairing.poll(started.pairingId, started.pollSecret).status, 'pending');
  assert.equal(tokens.list().length, 0, 'no credential exists before approval');

  const approved = pairing.approve(started.userCode, { member: 'alice', tokenId: 'browser-token-id' });
  assert.equal(approved.status, 'approved');
  assert.equal(approved.label, 'alice · alice-mbp · acme');

  const first = pairing.poll(started.pairingId, started.pollSecret);
  assert.equal(first.status, 'approved');
  if (first.status !== 'approved') return;
  assert.match(first.token, TOKEN_PATTERN);
  const record = tokens.resolve(first.token)!;
  assert.deepEqual([record.id, record.role, record.kind, record.member, record.repoIdentity, record.machine, record.label, record.createdBy],
    [first.tokenId, 'member', 'connector', 'alice', 'github.com/Acme/Acme-App', 'alice-mbp', 'alice · alice-mbp · acme', 'browser-token-id']);
  assert.equal(pairing.token(started.pairingId)?.id, record.id);
  assert.ok(!JSON.stringify(store.all('SELECT * FROM tokens')).includes(first.token) && !JSON.stringify(store.all('SELECT * FROM pairings')).includes(first.token),
    'the token value is never persisted');

  assert.deepEqual(pairing.poll(started.pairingId, started.pollSecret), { status: 'consumed' });
  assert.deepEqual(pairing.poll(started.pairingId, started.pollSecret), { status: 'consumed' }, 'still consumed on every later poll');
  assert.equal(tokens.list().length, 1, 'later polls mint nothing');
  assert.throws(() => pairing.approve(started.userCode, { member: 'mallory', tokenId: null }), /Pairing is consumed/);
  assert.throws(() => pairing.deny(started.userCode), /Pairing is consumed/);
  store.close();
});

test('pairing: wrong secret and unknown id fail identically; deny; expiry before and after approval', () => {
  const { store, tokens, pairing, advance } = setup();
  const a = pairing.start({ repo: REPO, machine: 'm1' }, CTX);
  assert.throws(() => pairing.poll(a.pairingId, `${a.pollSecret}x`), /Unknown pairing or wrong poll secret/);
  assert.throws(() => pairing.poll('00000000-0000-4000-8000-000000000000', a.pollSecret), /Unknown pairing or wrong poll secret/);
  assert.throws(() => pairing.approve('ZZZZZZZZ', { member: 'alice', tokenId: null }), /Unknown pairing code/);

  pairing.deny(a.userCode);
  assert.deepEqual(pairing.poll(a.pairingId, a.pollSecret), { status: 'denied' });
  assert.throws(() => pairing.approve(a.userCode, { member: 'alice', tokenId: null }), /Pairing is denied/);

  const b = pairing.start({ repo: REPO, machine: 'm2' }, CTX);
  const c = pairing.start({ repo: REPO, machine: 'm3' }, CTX);
  pairing.approve(c.userCode, { member: 'alice', tokenId: null });
  advance(PAIRING_TTL_MS);
  assert.deepEqual(pairing.poll(b.pairingId, b.pollSecret), { status: 'expired' });
  assert.throws(() => pairing.approve(b.userCode, { member: 'alice', tokenId: null }), /Pairing is expired/);
  assert.deepEqual(pairing.poll(c.pairingId, c.pollSecret), { status: 'expired' }, 'an approval not collected in time expires too');
  assert.equal(tokens.list().length, 0, 'denied and expired pairings never mint a credential');
  assert.throws(() => pairing.start({ repo: { name: '' }, machine: 'm' }, CTX), /repo.name/);
  assert.throws(() => pairing.start({ repo: REPO, machine: ' ' }, CTX), /machine/);
  store.close();
});

test('pairing rate limits: 5 pending per IP, a global hourly cap, both recover', () => {
  const { store, pairing, advance } = setup({ maxPerHour: 8 });
  const fromA = Array.from({ length: 5 }, (_, i) => pairing.start({ repo: REPO, machine: `a${i}` }, { ...CTX, ip: '198.51.100.1' }));
  assert.throws(() => pairing.start({ repo: REPO, machine: 'a5' }, { ...CTX, ip: '198.51.100.1' }), (error: unknown) => error instanceof RateLimitError && error.status === 429 && /pending/.test(error.message));
  pairing.start({ repo: REPO, machine: 'b0' }, { ...CTX, ip: '198.51.100.2' });
  pairing.deny(fromA[0]!.userCode);
  pairing.start({ repo: REPO, machine: 'a5' }, { ...CTX, ip: '198.51.100.1' });
  pairing.start({ repo: REPO, machine: 'c0' }, { ...CTX, ip: '198.51.100.3' });
  assert.throws(() => pairing.start({ repo: REPO, machine: 'd0' }, { ...CTX, ip: '198.51.100.4' }), (error: unknown) => error instanceof RateLimitError && /hub/.test(error.message));
  advance(60 * 60_000 + 1);
  pairing.start({ repo: REPO, machine: 'd0' }, { ...CTX, ip: '198.51.100.4' });
  store.close();
});

test('auth gates for pairing commands: connectors cannot approve; only admins approve for another member', () => {
  const connector: Auth = { role: 'member', member: 'alice', tokenId: 'tok-c', kind: 'connector' };
  const member: Auth = { role: 'member', member: 'alice', tokenId: 'tok-m', kind: 'member' };
  const viewer: Auth = { role: 'viewer', member: 'judges', tokenId: 'tok-v', kind: 'member' };
  const forbidden = (error: unknown) => error instanceof AuthError && error.status === 403;
  authorizeCommand(member, { action: 'pair_approve', userCode: 'ABCDEFGH' }, () => undefined);
  authorizeCommand(member, { action: 'pair_approve', userCode: 'ABCDEFGH', member: 'alice' }, () => undefined);
  assert.throws(() => authorizeCommand(member, { action: 'pair_approve', userCode: 'ABCDEFGH', member: 'bob' }, () => undefined), forbidden);
  authorizeCommand({ role: 'admin', member: 'operator', tokenId: null }, { action: 'pair_approve', userCode: 'ABCDEFGH', member: 'bob' }, () => undefined);
  for (const action of ['pair_approve', 'pair_deny', 'pair_info'] as const)
    assert.throws(() => authorizeCommand(connector, { action, userCode: 'ABCDEFGH' }, () => undefined), forbidden);
  authorizeCommand(connector, { action: 'checkout_report', repo: { name: 'x' }, dirty: [] }, () => undefined);
  authorizeCommand(connector, { action: 'connector_disconnect' }, () => undefined);
  authorizeCommand(connector, { action: 'remote_push', files: [] }, () => undefined);
  assert.throws(() => authorizeCommand(connector, { action: 'token_create', label: 'x', member: 'alice', role: 'member' }, () => undefined), forbidden);
  assert.throws(() => authorizeCommand(viewer, { action: 'pair_approve', userCode: 'ABCDEFGH' }, () => undefined), forbidden);
  assert.equal(connectorLabel('a'.repeat(30), 'm'.repeat(60), 'r'.repeat(60)).length <= 80, true);
});

async function unusedPort(): Promise<number> {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

test('daemon: unauthenticated pairing, member and admin approval, connector token powers, /me fields, 429', { timeout: 60_000 }, async () => {
  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  delete env.PORT; delete env.MODEL_API_KEY; delete env.HIVE_PUBLIC_URL;
  Object.assign(env, { HIVE_TOKEN: ADMIN, HIVE_PORT: String(port), HIVE_DB: ':memory:', HIVE_PROJECT_ROOT: fileURLToPath(new URL('../fixtures/billing', import.meta.url)) });
  const daemon = spawn(process.execPath, [fileURLToPath(new URL('../src/server/daemon.ts', import.meta.url))], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  const call = async (bearer: string | null, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, json: await response.json() as any };
  };
  try {
    await new Promise<void>((resolve, reject) => {
      let log = '';
      daemon.stderr!.on('data', chunk => { log += String(chunk); if (log.includes('Hive daemon listening')) resolve(); });
      daemon.once('error', reject);
      daemon.once('exit', code => reject(new Error(`Daemon exited ${code}: ${log}`)));
    });
    // Without a bearer only pair_start / pair_poll get through.
    assert.equal((await call(null, '/command', { action: 'sync' })).status, 401);
    assert.equal((await call(null, '/command', { action: 'pair_approve', userCode: 'ABCDEFGH' })).status, 401);
    assert.equal((await call(null, '/command', { action: 'pair_start', repo: { name: 'x' } })).status, 400, 'schema still applies');
    const big = await fetch(`${base}/command`, { method: 'POST', body: JSON.stringify({ action: 'pair_start', pad: 'x'.repeat(20_000) }) });
    assert.equal(big.status, 400, 'unauthenticated bodies are capped');

    const alice = (await call(ADMIN, '/command', { action: 'token_create', label: 'alice browser', member: 'alice', role: 'member' })).json as { token: string; record: { id: string; kind: string } };
    assert.equal(alice.record.kind, 'member');
    const start = await call(null, '/command', { action: 'pair_start', repo: { name: 'billing', remoteUrl: 'https://bot:s3cret@github.com/acme/billing.git' }, machine: 'alice-mbp', client: 'claude-code' },
      { 'X-Forwarded-Proto': 'https' });
    assert.equal(start.status, 200, JSON.stringify(start.json));
    assert.equal(start.json.verifyUrl, `https://127.0.0.1:${port}/ui/pair/${start.json.userCode}`, 'verifyUrl uses the hub URL as the client sees it');
    assert.equal((await call(null, '/command', { action: 'pair_poll', pairingId: start.json.pairingId, pollSecret: start.json.pollSecret })).json.status, 'pending');
    assert.equal((await call(null, '/command', { action: 'pair_poll', pairingId: start.json.pairingId, pollSecret: 'wrong' })).status, 400);

    const info = await call(alice.token, '/command', { action: 'pair_info', userCode: start.json.userCode });
    assert.deepEqual([info.json.machine, info.json.repo.name, info.json.repo.identity], ['alice-mbp', 'billing', 'github.com/acme/billing']);
    assert.ok(!JSON.stringify(info.json).includes('s3cret'));
    assert.equal((await call(alice.token, '/command', { action: 'pair_approve', userCode: start.json.userCode, member: 'bob' })).status, 403);
    const approved = await call(alice.token, '/command', { action: 'pair_approve', userCode: start.json.userCode });
    assert.equal(approved.status, 200, JSON.stringify(approved.json));
    const polled = await call(null, '/command', { action: 'pair_poll', pairingId: start.json.pairingId, pollSecret: start.json.pollSecret });
    assert.equal(polled.json.status, 'approved');
    assert.equal(polled.json.member, 'alice');
    const connector = polled.json.token as string;
    assert.equal((await call(null, '/command', { action: 'pair_poll', pairingId: start.json.pairingId, pollSecret: start.json.pollSecret })).json.status, 'consumed');
    const listed = (await call(ADMIN, '/command', { action: 'token_list' })).json.find((t: { id: string }) => t.id === polled.json.tokenId);
    assert.deepEqual([listed.kind, listed.member, listed.role, listed.createdBy, listed.repoIdentity], ['connector', 'alice', 'member', alice.record.id, 'github.com/acme/billing']);

    // /me carries what the CLI needs.
    const me = await call(connector, '/me', undefined, { 'X-Forwarded-Proto': 'https' });
    assert.deepEqual([me.json.role, me.json.member, me.json.kind, me.json.tokenId, me.json.workspace.name, me.json.publicUrl, me.json.hubUrl, me.json.connect.cliCommand],
      ['member', 'alice', 'connector', polled.json.tokenId, 'billing', null, `https://127.0.0.1:${port}`, `npx hive-connect connect --hub https://127.0.0.1:${port}`]);
    assert.equal(me.json.workspace.root, undefined);
    assert.equal((await call(ADMIN, '/me')).json.kind, 'operator');

    // A connector acts as its member: registers, pushes, but cannot mint tokens or approve pairings.
    const session = await call(connector, '/command', { action: 'register', name: 'claude-alice', client: 'claude-code' });
    assert.equal(session.status, 200, JSON.stringify(session.json));
    assert.equal((await call(connector, '/command', { action: 'heartbeat', sessionId: session.json.id })).status, 200);
    const pushed = await call(connector, '/command', { action: 'remote_push', files: [{ path: 'src/ok.ts', content: 'export const ok = 1;\n' }] });
    assert.equal(pushed.status, 200, JSON.stringify(pushed.json));
    assert.deepEqual(pushed.json.stored, ['src/ok.ts']);
    assert.equal((await call(connector, '/command', { action: 'token_create', label: 'x', member: 'alice', role: 'member' })).status, 403);
    const second = await call(null, '/command', { action: 'pair_start', repo: { name: 'billing' }, machine: 'mallory' });
    assert.equal((await call(connector, '/command', { action: 'pair_approve', userCode: second.json.userCode })).status, 403);

    // Admin approves for a named member.
    const adminApproved = await call(ADMIN, '/command', { action: 'pair_approve', userCode: second.json.userCode, member: 'bob' });
    assert.equal(adminApproved.status, 200, JSON.stringify(adminApproved.json));
    const bobPoll = await call(null, '/command', { action: 'pair_poll', pairingId: second.json.pairingId, pollSecret: second.json.pollSecret });
    assert.deepEqual([bobPoll.json.status, bobPoll.json.member], ['approved', 'bob']);
    assert.equal((await call(bobPoll.json.token, '/command', { action: 'heartbeat', sessionId: session.json.id })).status, 403, "bob's connector cannot touch alice's session");

    // Denied over HTTP.
    const third = await call(null, '/command', { action: 'pair_start', repo: { name: 'billing' }, machine: 'm3' });
    assert.equal((await call(alice.token, '/command', { action: 'pair_deny', userCode: third.json.userCode })).status, 200);
    assert.equal((await call(null, '/command', { action: 'pair_poll', pairingId: third.json.pairingId, pollSecret: third.json.pollSecret })).json.status, 'denied');

    // Five pending from this address are allowed; the sixth is 429.
    let status = 0;
    for (let i = 0; i < 6 && status !== 429; i++) status = (await call(null, '/command', { action: 'pair_start', repo: { name: 'billing' }, machine: `spam${i}` })).status;
    assert.equal(status, 429);
  } finally {
    daemon.kill('SIGTERM');
    await once(daemon, 'exit');
  }
});
