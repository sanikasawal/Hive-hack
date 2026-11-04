import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store/sqlite.ts';
import { CheckoutService, MAX_DIRTY_ENTRIES, isRelativeRepoPath, normalizeRepoIdentity, stripUrlCredentials } from '../src/server/checkouts.ts';
import { scrubText } from '../src/service.ts';

const ADMIN = 'throwaway-admin-token-for-checkout-tests';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

test('repo identity: ssh, scp-style, https (with or without .git, credentials, port, trailing slash) normalize to host/owner/repo', () => {
  for (const remote of ['git@github.com:a/b.git', 'https://github.com/a/b', 'https://github.com/a/b.git', 'https://x-access-token:ghp_secret@github.com/a/b.git/',
    'ssh://git@github.com:22/a/b.git', 'ssh://git@GitHub.com/a/b', 'git://github.com/a/b.git', 'github.com/a/b', '  https://github.com/a/b/  '])
    assert.equal(normalizeRepoIdentity(remote), 'github.com/a/b', remote);
  assert.equal(normalizeRepoIdentity('git@gitlab.example.org:group/sub/proj.git'), 'gitlab.example.org/group/sub/proj');
  for (const bad of ['', '/Users/me/repo', 'C:\\repo', 'file:///srv/repo.git', '../repo', 'not a url', 'https://github.com/', 'https://github.com/a/../b', null, undefined])
    assert.equal(normalizeRepoIdentity(bad), null, String(bad));
  assert.equal(stripUrlCredentials('clone https://bot:tok@github.com/a/b.git now'), 'clone https://github.com/a/b.git now');
  assert.ok(!/bot|tok@/.test(scrubText('remote https://bot:tok@github.com/a/b.git and git://u:p@h.io/x', [], 200)), 'viewer text never carries URL credentials');
  assert.ok(!scrubText('see https://bot:tok@github.com/a/b.git', [], 200).includes('tok'));
  for (const ok of ['src/a.ts', 'a b/c.ts', './src/x.ts'.slice(2)]) assert.ok(isRelativeRepoPath(ok), ok);
  for (const bad of ['/etc/passwd', '\\\\server\\share', 'C:\\x.ts', 'c:/x.ts', '~/x.ts', '../x.ts', 'a/../../b.ts', 'a\\..\\b', '', 'a\0b'])
    assert.ok(!isRelativeRepoPath(bad), bad);
});

test('checkout_report validation: absolute paths, too many entries, bad hashes and a different repository are refused', () => {
  const store = new Store(':memory:');
  let now = 5_000;
  const checkouts = new CheckoutService(store, () => now);
  const owner = { tokenId: 'tok-1', member: 'alice', boundIdentity: 'github.com/a/b', machine: 'alice-mbp' };
  const good = { repo: { name: 'b', remoteUrl: 'https://u:p@github.com/a/b.git', rootCommit: 'A'.repeat(40) }, branch: 'feature/cents', head: 'b'.repeat(40),
    dirty: [{ path: 'src/a.ts', sha256: sha('a'), status: 'modified' }, { path: './src/gone.ts', sha256: null, status: 'deleted' }, { path: 'src/a.ts', sha256: sha('a') }] };
  const saved = checkouts.report(owner, good);
  assert.deepEqual(saved, { tokenId: 'tok-1', member: 'alice', machine: 'alice-mbp', repo: { name: 'b', identity: 'github.com/a/b', rootCommit: 'a'.repeat(40) },
    branch: 'feature/cents', head: 'b'.repeat(40), baseCommit: null, reportedAt: 5_000,
    dirty: [{ path: 'src/a.ts', sha256: sha('a'), status: 'modified' }, { path: 'src/gone.ts', sha256: null, status: 'deleted' }] });
  assert.ok(!JSON.stringify(store.all('SELECT * FROM checkouts')).includes('u:p@'), 'remote URLs are never stored');

  for (const path of ['/etc/passwd', 'C:\\Users\\x\\a.ts', '~/a.ts', '../outside.ts', 'src/../../x.ts'])
    assert.throws(() => checkouts.report(owner, { ...good, dirty: [{ path, sha256: sha('x') }] }), /relative to the repository root/, path);
  const many = Array.from({ length: MAX_DIRTY_ENTRIES + 1 }, (_, i) => ({ path: `src/f${i}.ts`, sha256: sha(String(i)) }));
  assert.throws(() => checkouts.report(owner, { ...good, dirty: many }), /At most 500/);
  checkouts.report(owner, { ...good, dirty: many.slice(0, MAX_DIRTY_ENTRIES) });
  assert.throws(() => checkouts.report(owner, { ...good, dirty: [{ path: 'src/a.ts', sha256: 'abc' }] }), /sha256/);
  assert.throws(() => checkouts.report(owner, { ...good, head: 'main' }), /hex commit/);
  assert.throws(() => checkouts.report(owner, { ...good, repo: { name: 'evil', remoteUrl: 'git@github.com:evil/repo.git' } }), /bound to github.com\/a\/b, not github.com\/evil\/repo/);
  assert.throws(() => checkouts.report({ tokenId: null, member: 'operator' }, good), /operator token/);

  now = 9_000;
  assert.equal(checkouts.report(owner, { ...good, dirty: [] }).reportedAt, 9_000, 'a new report replaces the old one');
  assert.equal(checkouts.list().length, 1);
  assert.equal(checkouts.clear('tok-1'), true);
  assert.equal(checkouts.get('tok-1'), undefined);
  store.close();
});

async function unusedPort(): Promise<number> {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

test('daemon: connector checkout appears in the snapshot session, /api/view and member_list without credentials; disconnect revokes and clears', { timeout: 60_000 }, async () => {
  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  delete env.PORT; delete env.MODEL_API_KEY; delete env.HIVE_PUBLIC_URL;
  Object.assign(env, { HIVE_TOKEN: ADMIN, HIVE_PORT: String(port), HIVE_DB: ':memory:', HIVE_PROJECT_ROOT: fileURLToPath(new URL('../fixtures/billing', import.meta.url)) });
  const daemon = spawn(process.execPath, [fileURLToPath(new URL('../src/server/daemon.ts', import.meta.url))], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  const call = async (bearer: string | null, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, json: await response.json() as any };
  };
  const pair = async (approver: string, machine: string) => {
    const start = (await call(null, '/command', { action: 'pair_start', repo: { name: 'billing', remoteUrl: 'https://bot:s3cret@github.com/acme/billing.git' }, machine })).json;
    assert.equal((await call(approver, '/command', { action: 'pair_approve', userCode: start.userCode })).status, 200);
    return (await call(null, '/command', { action: 'pair_poll', pairingId: start.pairingId, pollSecret: start.pollSecret })).json as { token: string; tokenId: string };
  };
  try {
    await new Promise<void>((resolve, reject) => {
      let log = '';
      daemon.stderr!.on('data', chunk => { log += String(chunk); if (log.includes('Hive daemon listening')) resolve(); });
      daemon.once('error', reject);
      daemon.once('exit', code => reject(new Error(`Daemon exited ${code}: ${log}`)));
    });
    const alice = (await call(ADMIN, '/command', { action: 'token_create', label: 'alice browser', member: 'alice', role: 'member' })).json.token as string;
    const bob = (await call(ADMIN, '/command', { action: 'token_create', label: 'bob browser', member: 'bob', role: 'member' })).json.token as string;
    const judge = (await call(ADMIN, '/command', { action: 'token_create', label: 'judges', member: 'judges', role: 'viewer', kind: 'viewer-link' })).json.token as string;
    assert.equal((await call(ADMIN, '/command', { action: 'token_create', label: 'bad', member: 'x', role: 'admin', kind: 'connector' })).status, 400);
    const connector = await pair(alice, 'alice-mbp');

    const report = { action: 'checkout_report', repo: { name: 'billing', remoteUrl: 'https://bot:s3cret@github.com/acme/billing.git' }, branch: 'cents',
      head: 'c'.repeat(40), dirty: [{ path: 'src/pricing.ts', sha256: sha('x') }, { path: 'src/new.ts', sha256: sha('y'), status: 'untracked' }] };
    // Schema refusals (400) before any state changes.
    assert.equal((await call(connector.token, '/command', { ...report, dirty: [{ path: '/etc/passwd', sha256: sha('x') }] })).status, 400);
    const tooMany = await call(connector.token, '/command', { ...report, dirty: Array.from({ length: 501 }, (_, i) => ({ path: `f${i}.ts`, sha256: sha(String(i)) })) });
    assert.equal(tooMany.status, 400);
    assert.equal((await call(connector.token, '/command', { ...report, repo: { name: 'other', remoteUrl: 'git@github.com:evil/other.git' } })).status, 400, 'bound to the paired repository');
    assert.equal((await call(judge, '/command', report)).status, 403, 'viewers cannot report');
    assert.equal((await call(ADMIN, '/command', report)).status, 400, 'the operator token has no checkout');

    const saved = await call(connector.token, '/command', report);
    assert.equal(saved.status, 200, JSON.stringify(saved.json));
    assert.deepEqual([saved.json.machine, saved.json.repo.identity, saved.json.dirty.length], ['alice-mbp', 'github.com/acme/billing', 2]);
    const session = (await call(connector.token, '/command', { action: 'register', name: 'claude-alice', client: 'claude-code' })).json;

    const snapshot = await call(ADMIN, '/snapshot');
    const row = snapshot.json.sessions.find((s: { id: string }) => s.id === session.id);
    assert.equal(row.tokenId, connector.tokenId);
    assert.deepEqual({ ...row.connector, reportedAt: 0 }, { machine: 'alice-mbp', repoName: 'billing', branch: 'cents', headShort: 'ccccccc', dirtyCount: 2, reportedAt: 0 });

    const view = await call(judge, '/api/view');
    assert.equal(view.status, 200);
    const viewSession = view.json.sessions.find((s: { id: string }) => s.id === session.id);
    assert.deepEqual([viewSession.connector.machine, viewSession.connector.repoName, viewSession.connector.branch, viewSession.connector.headShort, viewSession.connector.dirtyCount],
      ['alice-mbp', 'billing', 'cents', 'ccccccc', 2]);
    const viewText = JSON.stringify(view.json);
    for (const forbidden of ['s3cret', 'bot:', '@github.com', 'src/new.ts', connector.token, connector.tokenId]) assert.ok(!viewText.includes(forbidden), `view leaked ${forbidden}`);

    const adminMembers = (await call(ADMIN, '/command', { action: 'member_list' })).json;
    const aliceConnectors = adminMembers.find((m: { member: string }) => m.member === 'alice').connectors;
    assert.deepEqual(aliceConnectors.map((c: any) => [c.tokenId, c.machine, c.repoIdentity, c.branch, c.headShort, c.dirtyCount]),
      [[connector.tokenId, 'alice-mbp', 'github.com/acme/billing', 'cents', 'ccccccc', 2]]);
    assert.ok(!JSON.stringify(adminMembers).includes('s3cret'));
    const aliceMembers = (await call(alice, '/command', { action: 'member_list' })).json;
    assert.ok(aliceMembers.every((m: { tokens: unknown[] }) => m.tokens.length === 0), 'members still see no token metadata');
    assert.equal(aliceMembers.find((m: { member: string }) => m.member === 'alice').connectors.length, 1, 'a member sees their own connector');
    const bobMembers = (await call(bob, '/command', { action: 'member_list' })).json;
    assert.ok(bobMembers.every((m: { connectors: unknown[] }) => m.connectors.length === 0), "bob does not see alice's connectors");
    const listed = (await call(ADMIN, '/command', { action: 'token_list' })).json.find((t: { id: string }) => t.id === connector.tokenId);
    assert.ok(listed.lastSeenAt !== null, 'a report marks the connector as seen');

    // Disconnect: bob cannot disconnect alice's connector; a connector disconnects itself (revoked + checkout cleared).
    assert.equal((await call(bob, '/command', { action: 'connector_disconnect', tokenId: connector.tokenId })).status, 403);
    const other = await pair(alice, 'alice-desktop');
    assert.equal((await call(other.token, '/command', { action: 'connector_disconnect', tokenId: connector.tokenId })).status, 403, 'a connector may only disconnect itself');
    const done = await call(connector.token, '/command', { action: 'connector_disconnect' });
    assert.equal(done.status, 200, JSON.stringify(done.json));
    assert.deepEqual([done.json.disconnected, done.json.tokenId, done.json.checkoutCleared], [true, connector.tokenId, true]);
    assert.equal((await call(connector.token, '/me')).status, 401, 'the credential no longer authenticates');
    const after = (await call(ADMIN, '/snapshot')).json.sessions.find((s: { id: string }) => s.id === session.id);
    assert.equal(after?.connector ?? null, null, 'checkout cleared from the snapshot');
    const membersAfter = (await call(ADMIN, '/command', { action: 'member_list' })).json.find((m: { member: string }) => m.member === 'alice').connectors;
    assert.deepEqual(membersAfter.map((c: { tokenId: string }) => c.tokenId), [other.tokenId]);
    // A member disconnects one of their own connectors by id.
    assert.equal((await call(alice, '/command', { action: 'connector_disconnect', tokenId: other.tokenId })).status, 200);
    assert.equal((await call(alice, '/command', { action: 'connector_disconnect' })).status, 400, 'a member must name the connector');
  } finally {
    daemon.kill('SIGTERM');
    await once(daemon, 'exit');
  }
});
