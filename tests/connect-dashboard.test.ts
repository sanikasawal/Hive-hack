// Dashboard side of Hive Connect (spec 2026-11-03, sections 1-3): the Connect screen's waiting logic, invite-link
// parsing on the approval page, the model banner's sentence split, connector data surviving the viewer adapter and
// the Members model, and the web client's pairing calls against a real daemon (pending, approve once, refusals).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { viewToSnapshot } from '../web/src/api/adapt.ts';
import { ApiError, HiveClient, memoryTokenStore } from '../web/src/api/client.ts';
import type { PairingInfo, TokenRecord, ViewResponse } from '../web/src/api/types.ts';
import { connectCommand, connectProgress, safeNextPath, tokenFromInvite, type ConnectorLike } from '../web/src/screens/connect/logic.ts';
import { buildAccess } from '../web/src/screens/members/access.ts';
import { splitUnavailable, verdictText } from '../web/src/shell/modelText.ts';
import { providerSentence } from '../src/intelligence/meta.ts';

const ADMIN = 'throwaway-admin-token-for-connect-dashboard-tests';
const T = 1_800_000_000_000;

function connector(tokenId: string, member: string, extra: Partial<ConnectorLike> = {}): ConnectorLike {
  return { tokenId, member, machine: 'alice-mbp', repoName: 'hive-playground', branch: null, headShort: null, dirtyCount: 0, reportedAt: null, createdAt: T, ...extra };
}

test('waiting step: approval, checkout report and first agent tick in order; older and other members\' items do not count', () => {
  const base = { member: 'Alice', baselineConnectorIds: ['old'], baselineSessionIds: ['s-old'] };
  const old = connector('old', 'Alice', { reportedAt: T - 5000 });
  assert.deepEqual(connectProgress({ ...base, connectors: [old], sessions: [{ id: 's-old', member: 'Alice', tokenId: 'old', connector: {} }] }),
    { connector: null, reported: false, sessionId: null, done: 0 }, 'what existed when the page opened is ignored');

  const bob = connector('c-bob', 'Bob', { reportedAt: T });
  assert.equal(connectProgress({ ...base, connectors: [old, bob], sessions: [] }).done, 0, 'another member\'s new connector does not tick Alice\'s flow');
  assert.equal(connectProgress({ ...base, member: null, connectors: [old, bob], sessions: [] }).connector?.tokenId, 'c-bob', 'an admin without an invite follows anyone');

  const fresh = connector('c-new', 'Alice', { createdAt: T + 1 });
  assert.equal(connectProgress({ ...base, connectors: [old, fresh], sessions: [] }).done, 1, 'approved: a new connector exists');
  const reported = { ...fresh, branch: 'main', headShort: '1a2b3c4', dirtyCount: 2, reportedAt: T + 2 };
  assert.equal(connectProgress({ ...base, connectors: [old, reported], sessions: [] }).done, 2);
  // A plain member-token session (not through a connector) is not the agent this flow waits for.
  assert.equal(connectProgress({ ...base, connectors: [reported], sessions: [{ id: 's-browser', member: 'Alice', tokenId: 'browser' }] }).done, 2);
  const done = connectProgress({ ...base, connectors: [reported], sessions: [{ id: 's-new', member: 'Alice', tokenId: 'c-new', connector: { machine: 'alice-mbp' } }] });
  assert.deepEqual([done.done, done.sessionId, done.connector?.tokenId], [3, 's-new', 'c-new']);
});

test('waiting step: a reconnect that reuses an existing credential still ticks when its new session registers', () => {
  const reused = connector('c-1', 'Alice', { reportedAt: T });
  const progress = connectProgress({ member: 'Alice', baselineConnectorIds: ['c-1'], baselineSessionIds: [], connectors: [reused],
    sessions: [{ id: 's-2', member: 'Alice', tokenId: 'c-1', connector: { machine: 'alice-mbp' } }] });
  assert.deepEqual([progress.done, progress.connector?.tokenId, progress.reported], [3, 'c-1', true]);
});

test('approval page: invite links and pasted tokens sign in; anything else is refused; next paths stay inside the app', () => {
  assert.equal(tokenFromInvite('https://hive.example.test/ui/join#token=hive_mem_abc%2Bdef'), 'hive_mem_abc+def');
  assert.equal(tokenFromInvite('  Bearer "hive_mem_xyz" '), 'hive_mem_xyz');
  assert.equal(tokenFromInvite('https://hive.example.test/ui/join#next=/pair/X&token=hive_mem_q'), 'hive_mem_q');
  assert.equal(tokenFromInvite('https://hive.example.test/ui/join#nothing'), '', 'a link without a token gives nothing to sign in with');
  assert.equal(tokenFromInvite('   '), '');
  assert.equal(safeNextPath('/pair/ABCD2345'), '/pair/ABCD2345');
  for (const bad of ['//evil.example', 'https://evil.example/', '/pair/<x>', '/a?b=c', 'pair/ABCD', null, '']) assert.equal(safeNextPath(bad), null, String(bad));
  assert.equal(connectCommand('https://hive.example.test/'), 'npx hive-connect connect --hub https://hive.example.test');
});

test('model banner: the hub\'s first sentence is the headline and the details stay separate', () => {
  const error = `${providerSentence(404)} Details: Meta API HTTP 404: model not found after 1 attempt(s). An admin can run model_diagnose for the cause.`;
  const split = splitUnavailable(error);
  assert.equal(split.sentence, providerSentence(404));
  assert.match(split.details!, /^Meta API HTTP 404/);
  assert.deepEqual(splitUnavailable('Older error without details'), { sentence: 'Older error without details', details: null });
  assert.match(splitUnavailable(null).sentence, /did not answer/);
  assert.equal(verdictText('no_models_for_host').tone, 'warning');
  assert.equal(verdictText('something_new').title, 'Verdict: something_new', 'unknown verdicts are shown, not hidden');
});

test('viewer adapter keeps each session\'s connector checkout and the relayed label', () => {
  const view = {
    workspace: { name: 'hive-playground' }, revision: 3, graph: { indexed: true, symbols: 10, files: 4 }, model: { configured: true, model: 'muse-spark-1.3' },
    sessions: [{ id: 's1', member: 'Alice', agent: 'pricing agent', task: null, step: 'joined',
      connector: { machine: 'alice-mbp', repoName: 'hive-playground', branch: 'main', headShort: '1a2b3c4', dirtyCount: 2, reportedAt: T } }],
    members: [{ member: 'Alice', sessions: 1 }], findings: [], contracts: [], events: [],
    analysis: { status: 'ok', summary: 'fine', model: 'muse-spark-1.3', latencyMs: 900, findings: 0, at: T, relayedBy: 'Alice' }, cacheAgeMs: 0,
  } satisfies ViewResponse;
  const snapshot = viewToSnapshot(view, [], T);
  assert.deepEqual(snapshot.sessions[0]!.connector, view.sessions[0]!.connector);
  assert.equal(snapshot.analysis?.relayedBy, 'Alice');
});

test('Members: connector credentials are listed as machines, not tokens, and their agents still count', () => {
  const token = (id: string, member: string, kind: TokenRecord['kind']): TokenRecord => ({ id, label: id, member, role: 'member', kind, prefix: 'abcd1234',
    createdBy: 'operator', createdAt: T, lastUsedAt: T, revokedAt: null });
  const tokens = [token('browser', 'Alice', 'member'), token('conn', 'Alice', 'connector')];
  const sessions = [{ id: 's1', name: 'Alice · agent', client: 'claude-code', member: 'Alice', tokenId: 'conn' }];
  const admin = buildAccess({ me: { role: 'admin', member: 'operator', tokenId: null }, tokens, sessions, now: T });
  const alice = admin.rows.find(r => r.name === 'Alice')!;
  assert.deepEqual(alice.tokens.map(t => t.id), ['browser']);
  assert.equal(alice.activeTokenCount, 1);
  assert.equal(admin.activeTokens, 1);
  assert.deepEqual(alice.agents.map(a => a.id), ['s1']);

  const own = buildAccess({ me: { role: 'member', member: 'Alice', tokenId: 'browser' }, tokens: [], sessions, now: T, connectorTokenIds: ['conn'] });
  assert.deepEqual(own.rows[0]!.agents.map(a => a.id), ['s1'], 'a member sees the agent their own connector registered');
  const without = buildAccess({ me: { role: 'member', member: 'Alice', tokenId: 'browser' }, tokens: [], sessions, now: T });
  assert.equal(without.rows[0]!.agents.length, 0);
});

// ---- against a real daemon ---------------------------------------------------------------------------

async function unusedPort(): Promise<number> {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function startDaemon(): Promise<{ base: string; daemon: ChildProcess }> {
  const port = await unusedPort();
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  delete env.PORT; delete env.MODEL_API_KEY; delete env.HIVE_PUBLIC_URL;
  Object.assign(env, { HIVE_TOKEN: ADMIN, HIVE_PORT: String(port), HIVE_DB: ':memory:', HIVE_PROJECT_ROOT: fileURLToPath(new URL('../fixtures/billing', import.meta.url)) });
  const daemon = spawn(process.execPath, [fileURLToPath(new URL('../src/server/daemon.ts', import.meta.url))], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  await new Promise<void>((resolve, reject) => {
    let log = '';
    daemon.stderr!.on('data', chunk => { log += String(chunk); if (log.includes('Hive daemon listening')) resolve(); });
    daemon.once('error', reject);
    daemon.once('exit', code => reject(new Error(`Daemon exited ${code}: ${log}`)));
  });
  return { base: `http://127.0.0.1:${port}`, daemon };
}

test('approval page calls against a real daemon: info, approve once, viewers and unknown codes refused, disconnect', { timeout: 60_000 }, async () => {
  const { base, daemon } = await startDaemon();
  try {
    const admin = new HiveClient({ baseUrl: base, tokens: memoryTokenStore(ADMIN) });
    const me = await admin.me();
    assert.equal(me.kind, 'operator');
    assert.equal(me.connect?.cliCommand, connectCommand(me.hubUrl!), 'the dashboard shows the command the hub sends');

    const invite = await admin.tokenCreate({ label: 'Alice · invite link', member: 'Alice', role: 'member', kind: 'member' });
    const alice = new HiveClient({ baseUrl: base, tokens: memoryTokenStore(tokenFromInvite(`${base}/ui/join#token=${encodeURIComponent(invite.token)}`)) });
    const viewer = new HiveClient({ baseUrl: base, tokens: memoryTokenStore((await admin.tokenCreate({ label: 'judge', member: 'Judge', role: 'viewer' })).token) });

    // The CLI side: unauthenticated pair_start with a remote URL that carries credentials.
    const anonymous = new HiveClient({ baseUrl: base, tokens: memoryTokenStore(null) });
    const started = await anonymous.command<{ userCode: string; pairingId: string; pollSecret: string; verifyUrl: string }>({ action: 'pair_start',
      repo: { name: 'hive-playground', remoteUrl: 'https://bob:s3cret@github.com/acme/hive-playground.git' }, machine: 'alice-mbp', client: 'claude-code' });
    assert.ok(started.verifyUrl.endsWith(`/ui/pair/${started.userCode}`), 'the CLI opens the dashboard route this build adds');

    const info: PairingInfo = await alice.pairInfo(started.userCode);
    assert.deepEqual([info.status, info.repo.name, info.machine, info.client], ['pending', 'hive-playground', 'alice-mbp', 'claude-code']);
    assert.equal(info.repo.identity, 'github.com/acme/hive-playground');
    assert.ok(!JSON.stringify(info).includes('s3cret'), 'the approval page never receives remote credentials');

    await assert.rejects(viewer.pairInfo(started.userCode), (e: unknown) => e instanceof ApiError && e.status === 403, 'viewers are told to sign in with an invite link');
    await assert.rejects(viewer.pairApprove(started.userCode), (e: unknown) => e instanceof ApiError && e.status === 403);
    await assert.rejects(alice.pairInfo('ZZZZ-ZZZZ'), (e: unknown) => e instanceof ApiError && e.status === 400 && /unknown pairing code/i.test(e.message));

    const approved = await alice.pairApprove(started.userCode.toLowerCase());
    assert.deepEqual([approved.status, approved.member], ['approved', 'Alice']);
    assert.match(approved.label, /Alice · alice-mbp · hive-playground/);
    await assert.rejects(alice.pairApprove(started.userCode), (e: unknown) => e instanceof ApiError && /Pairing is approved/.test(e.message), 'a second approval is refused');
    await assert.rejects(alice.pairDeny(started.userCode), (e: unknown) => e instanceof ApiError && /Pairing is approved/.test(e.message));

    // The CLI collects the credential; the page then shows "consumed" and Members lists the connector.
    const polled = await anonymous.command<{ status: string; tokenId: string }>({ action: 'pair_poll', pairingId: started.pairingId, pollSecret: started.pollSecret });
    assert.equal(polled.status, 'approved');
    assert.equal((await alice.pairInfo(started.userCode)).status, 'consumed');
    const own = (await alice.memberList()).find(m => m.member === 'Alice')!;
    assert.deepEqual(own.connectors?.map(c => c.tokenId), [polled.tokenId]);
    assert.equal(own.tokens.length, 0, 'members still get no token metadata');

    // Disconnect from Members: another member is refused, the owner succeeds, and the connector disappears.
    const bob = new HiveClient({ baseUrl: base, tokens: memoryTokenStore((await admin.tokenCreate({ label: 'bob', member: 'Bob', role: 'member' })).token) });
    await assert.rejects(bob.connectorDisconnect(polled.tokenId), (e: unknown) => e instanceof ApiError && e.status === 403);
    const gone = await alice.connectorDisconnect(polled.tokenId);
    assert.equal(gone.disconnected, true);
    assert.equal((await admin.memberList()).find(m => m.member === 'Alice')?.connectors?.length ?? 0, 0);
  } finally {
    daemon.kill('SIGTERM');
    await once(daemon, 'exit');
  }
});
