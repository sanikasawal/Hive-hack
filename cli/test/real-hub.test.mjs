// Drives `hive-connect connect` against the repository's real hub (src/server/daemon.ts, in-memory database).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnv, makeRepo, runCli } from './helpers.mjs';

const ADMIN = 'cli-test-admin-token-not-production';
const daemonPath = fileURLToPath(new URL('../../src/server/daemon.ts', import.meta.url));
const fixture = fileURLToPath(new URL('../../fixtures/billing', import.meta.url));
const [major, minor] = process.versions.node.split('.').map(Number);
const canRunHub = existsSync(daemonPath) && (major > 22 || (major === 22 && minor >= 18));

async function unusedPort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('real hub: connect pairs through pair_approve, /me accepts the connector, checkout is recorded, disconnect revokes', { skip: !canRunHub && 'needs the Hive repository and Node >= 22.18' }, async () => {
  const port = await unusedPort();
  const url = `http://127.0.0.1:${port}`;
  const env = { ...process.env, HIVE_TOKEN: ADMIN, HIVE_PORT: String(port), HIVE_DB: ':memory:', HIVE_PROJECT_ROOT: fixture };
  delete env.PORT; delete env.HIVE_HOST; delete env.HIVE_URL; delete env.HIVE_PUBLIC_URL;
  const daemon = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', daemonPath], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    await new Promise((resolve, reject) => {
      let log = '';
      daemon.stderr.on('data', chunk => { log += chunk; if (log.includes('Hive daemon listening')) resolve(); });
      daemon.once('exit', code => reject(new Error(`daemon exited ${code}: ${log}`)));
    });
    const call = async (token, path, body) => {
      const response = await fetch(`${url}${path}`, { method: body ? 'POST' : 'GET', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, json: await response.json() };
    };
    const alice = (await call(ADMIN, '/command', { action: 'token_create', label: 'alice browser', member: 'alice', role: 'member' })).json.token;

    const repo = makeRepo('https://github.com/acme/billing.git');
    const { env: cliEnv, config } = isolatedEnv({ HIVE_CONNECT_POLL_MS: '100' });
    let approval = null;
    const run = await runCli(['connect', '--hub', url, '--client', 'claude', '--yes', '--no-browser', '--no-node'], { cwd: repo, env: cliEnv,
      onStdout: text => {
        const match = /Code: (\w{4})-(\w{4})/.exec(text);
        if (match && !approval) approval = call(alice, '/command', { action: 'pair_approve', userCode: match[1] + match[2] });
      } });
    assert.equal(run.code, 0, run.stderr + run.stdout);
    assert.equal((await approval).status, 200);
    assert.match(run.stdout, /Connected .* as alice\./);

    const token = Object.values(JSON.parse(readFileSync(join(config, 'credentials.json'), 'utf8')))[0];
    const me = await call(token, '/me');
    assert.equal(me.status, 200);
    assert.deepEqual([me.json.role, me.json.member, me.json.kind, me.json.connector.repoIdentity], ['member', 'alice', 'connector', 'github.com/acme/billing']);

    // The verification checkout report reached the hub (member_list carries the connector + checkout summary).
    const members = (await call(ADMIN, '/command', { action: 'member_list' })).json;
    const connector = members.find(m => m.member === 'alice').connectors.find(c => c.tokenId === me.json.tokenId);
    assert.deepEqual([connector.repoName, connector.branch, connector.repoIdentity], [repo.split('/').at(-1), 'main', 'github.com/acme/billing']);
    assert.match(connector.headShort, /^[0-9a-f]{7}$/);
    assert.ok(connector.reportedAt > 0);
    const view = await call(alice, '/api/view');
    assert.equal(view.status, 200);
    assert.ok(!JSON.stringify(view.json).includes(token), 'view never carries the credential');

    // node --once against the real hub: the dirty .ts file is synced and shows up in the dashboard view.
    writeFileSync(join(repo, 'src', 'pricing.ts'), 'export const price = 3;\n');
    const once = await runCli(['node', '--once'], { cwd: repo, env: cliEnv });
    assert.equal(once.code, 0, once.stderr);
    const synced = (await call(alice, '/api/view?fresh=1')).json.remote;
    assert.deepEqual(synced.members.find(m => m.member === 'alice').files.map(f => f.path), ['src/pricing.ts']);
    const after = (await call(ADMIN, '/command', { action: 'member_list' })).json.find(m => m.member === 'alice').connectors[0];
    assert.equal(after.dirtyCount, 1);
    const out = await runCli(['disconnect'], { cwd: repo, env: cliEnv });
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /Revoked this connector credential/);
    assert.equal((await call(token, '/me')).status, 401);
  } finally {
    daemon.kill('SIGTERM');
    await once(daemon, 'exit');
  }
});
