// Acceptance (spec section 6): one hub, two users on separate "laptops" (separate HOME / XDG_CONFIG_HOME and separate
// git clones of hive-playground), each connected with the real CLI (cli/dist), pairing approved through that user's
// browser token. Two MCP clients talk to the hub only through the CLI's stdio bridge. No network beyond 127.0.0.1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ADMIN = 'acceptance-admin-token-not-production';
const CLI = fileURLToPath(new URL('../cli/dist/main.js', import.meta.url));
const daemonPath = fileURLToPath(new URL('../src/server/daemon.ts', import.meta.url));
const PLAYGROUND = process.env.HIVE_PLAYGROUND ?? fileURLToPath(new URL('../../hive-playground', import.meta.url));
const PLAYGROUND_REMOTE = 'https://github.com/sanikasawal/hive-playground.git';
const UNIT_KEY = 'src/pricing.ts#getPrice:unit';
const skip = !existsSync(CLI) ? 'cli/dist is missing (npm run build:cli)' : !existsSync(join(PLAYGROUND, '.git')) ? `hive-playground clone not found at ${PLAYGROUND}` : false;

async function unusedPort(): Promise<number> {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}
const temp = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}
function clonePlayground(prefix: string): string {
  const dir = temp(prefix);
  git(dir, 'clone', '-q', PLAYGROUND, 'hive-playground');
  const repo = join(dir, 'hive-playground');
  git(repo, 'remote', 'set-url', 'origin', PLAYGROUND_REMOTE);
  return repo;
}
function baseEnv(): Record<string, string> {
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  for (const name of ['PORT', 'HIVE_HOST', 'HIVE_URL', 'HIVE_TOKEN', 'HIVE_PUBLIC_URL', 'HIVE_REPO_URL', 'HIVE_CONNECT_COMMAND', 'MUSE_SESSION_ID',
    'MODEL_API_KEY', 'HIVE_MODEL_BASE_URL', 'HIVE_MODEL_PROXY_URL', 'CLAUDE_PROJECT_DIR']) delete env[name];
  return env;
}

interface User { name: string; home: string; config: string; repo: string; env: Record<string, string>; browserToken: string }
function makeUser(name: string, browserToken: string): User {
  const home = temp(`hive-acc-home-${name}-`);
  const config = join(home, '.config', 'hive');
  const env = { ...baseEnv(), HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config'), HIVE_CONNECT_NO_KEYCHAIN: '1', HIVE_CONNECT_POLL_MS: '100' };
  return { name, home, config, repo: clonePlayground(`hive-acc-${name}-`), env, browserToken };
}

function run(args: string[], user: User, options: { input?: string; onStdout?: (text: string) => void } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: user.repo, env: user.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', chunk => { stdout += String(chunk); options.onStdout?.(stdout); });
    child.stderr!.on('data', chunk => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin!.end(options.input ?? '');
  });
}

function payload(result: Awaited<ReturnType<Client['callTool']>>): any {
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
}

test('acceptance: two users connect with the CLI, collide through the stdio bridge, see the finding, resolve it, disconnect', { skip, timeout: 90_000 }, async () => {
  const port = await unusedPort();
  const url = `http://127.0.0.1:${port}`;
  const hubRepo = clonePlayground('hive-acc-hub-');
  const dataDir = temp('hive-acc-data-');
  const daemon: ChildProcess = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', daemonPath], {
    env: { ...baseEnv(), HIVE_TOKEN: ADMIN, HIVE_PORT: String(port), HIVE_PROJECT_ROOT: hubRepo, HIVE_DATA_DIR: dataDir }, stdio: ['ignore', 'ignore', 'pipe'] });
  const clients: Client[] = [];
  const users: User[] = [];
  const cleanupDirs = [hubRepo, dataDir];
  try {
    await new Promise<void>((resolve, reject) => {
      let log = '';
      daemon.stderr!.on('data', chunk => { log += String(chunk); if (log.includes('Hive daemon listening')) resolve(); });
      daemon.once('exit', code => reject(new Error(`daemon exited ${code}: ${log}`)));
    });
    assert.ok(existsSync(join(dataDir, 'hive.db')), 'the hub uses a file database');
    const call = async (token: string | null, path: string, body?: unknown): Promise<{ status: number; json: any }> => {
      const response = await fetch(`${url}${path}`, { method: body ? 'POST' : 'GET',
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, json: await response.json() };
    };

    // Admin invites both teammates: member-role browser tokens (what the invite link carries).
    for (const name of ['ana', 'ben']) {
      const invite = await call(ADMIN, '/command', { action: 'token_create', label: `${name} browser`, member: name, role: 'member' });
      assert.equal(invite.status, 200, JSON.stringify(invite.json));
      const user = makeUser(name, invite.json.token as string);
      users.push(user);
      cleanupDirs.push(user.home, join(user.repo, '..'));
    }
    const [ana, ben] = users as [User, User];

    // Each user runs `hive-connect connect`; the pairing is approved with that user's browser token.
    const connectArgs = ['connect', '--hub', url, '--no-browser', '--yes', '--client', 'claude'];
    const tokens = new Map<string, string>();
    const configs = new Map<string, { mcp: string; settings: string }>();
    await Promise.all(users.map(async user => {
      const pending: { approval?: Promise<{ status: number; json: any }> } = {};
      const out = await run(connectArgs, user, { onStdout: text => {
        const match = /Code: (\w{4})-(\w{4})/.exec(text);
        if (match && !pending.approval) pending.approval = call(user.browserToken, '/command', { action: 'pair_approve', userCode: match[1]! + match[2]! });
      } });
      assert.equal(out.code, 0, out.stderr + out.stdout);
      assert.ok(pending.approval, 'the CLI printed a pairing code');
      assert.equal((await pending.approval).status, 200);
      assert.match(out.stdout, new RegExp(`Connected hive-playground to Hive workspace "hive-playground" at .* as ${user.name}\\.`));
      assert.match(out.stdout, /Credential stored in a protected file \(0600\)/);

      // Fallback credential store: mode 0600, exactly one credential, and it is a connector for this user.
      const credPath = join(user.config, 'credentials.json');
      assert.equal(statSync(credPath).mode & 0o777, 0o600);
      const stored = Object.values(JSON.parse(readFileSync(credPath, 'utf8')) as Record<string, string>);
      assert.equal(stored.length, 1);
      tokens.set(user.name, stored[0]!);
      const me = await call(stored[0]!, '/me');
      assert.deepEqual([me.status, me.json.member, me.json.kind, me.json.connector.repoIdentity], [200, user.name, 'connector', 'github.com/sanikasawal/hive-playground']);

      // Client config: token-free stdio MCP server + hook commands calling the CLI.
      const mcp = readFileSync(join(user.repo, '.mcp.json'), 'utf8');
      const settings = readFileSync(join(user.repo, '.claude', 'settings.local.json'), 'utf8');
      assert.deepEqual(JSON.parse(mcp).mcpServers.hive, { command: CLI, args: ['mcp'] });
      assert.match(settings, /hook prompt --client claude/);
      for (const text of [mcp, settings]) assert.ok(!text.includes(stored[0]!) && !text.includes('hive_mem_'), 'no credential in client config files');
      assert.equal(git(user.repo, 'status', '--porcelain'), '', 'local config is excluded from git');
      configs.set(user.name, { mcp, settings });
    }));

    // Reconnect is idempotent: same credential, no pairing, byte-identical config files.
    const again = await run(connectArgs, ana);
    assert.equal(again.code, 0, again.stderr);
    assert.match(again.stdout, /Reconnected hive-playground/);
    assert.doesNotMatch(again.stdout, /Code: /);
    assert.equal(readFileSync(join(ana.repo, '.mcp.json'), 'utf8'), configs.get('ana')!.mcp);
    assert.equal(readFileSync(join(ana.repo, '.claude', 'settings.local.json'), 'utf8'), configs.get('ana')!.settings);
    assert.equal(Object.values(JSON.parse(readFileSync(join(ana.config, 'credentials.json'), 'utf8'))).length, 1);

    // Both connectors reported their checkout (admin's member list).
    const head = git(ana.repo, 'rev-parse', 'HEAD');
    const branch = git(ana.repo, 'branch', '--show-current');
    const members = (await call(ADMIN, '/command', { action: 'member_list' })).json as { member: string; connectors?: { branch: string; headShort: string; reportedAt: number }[] }[];
    for (const name of ['ana', 'ben']) {
      const connectors = members.find(m => m.member === name)?.connectors ?? [];
      assert.equal(connectors.length, 1, `${name} has one connector`);
      assert.deepEqual([connectors[0]!.branch, connectors[0]!.headShort], [branch, head.slice(0, 7)]);
      assert.ok(connectors[0]!.reportedAt > 0);
    }

    // Two MCP clients, each through its user's stdio bridge (the command .mcp.json names).
    const connectClient = async (user: User): Promise<Client> => {
      const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp'], cwd: user.repo, env: user.env, stderr: 'pipe' });
      const client = new Client({ name: `acceptance-${user.name}`, version: '1.0.0' });
      await client.connect(transport);
      clients.push(client);
      return client;
    };
    const [a, b] = await Promise.all([connectClient(ana), connectClient(ben)]);
    assert.ok((await a.listTools()).tools.some(t => t.name === 'hive_context'));
    const sessionA = payload(await a.callTool({ name: 'hive_register', arguments: { name: 'pricing agent' } }));
    const sessionB = payload(await b.callTool({ name: 'hive_register', arguments: { name: 'invoice agent' } }));
    assert.deepEqual([sessionA.member, sessionB.member], ['ana', 'ben']);

    // Dashboard view: both members, each agent with its checkout as branch@head.
    const view = (await call(ana.browserToken, '/api/view?fresh=1')).json as { members: { member: string }[]; sessions: { member: string; agent: string; connector: { branch: string; headShort: string } | null }[] };
    assert.deepEqual(view.members.map(m => m.member).sort(), ['ana', 'ben']);
    for (const name of ['ana', 'ben']) {
      const session = view.sessions.find(s => s.member === name)!;
      assert.equal(`${session.connector?.branch}@${session.connector?.headShort}`, `${branch}@${head.slice(0, 7)}`);
    }
    for (const token of tokens.values()) assert.ok(!JSON.stringify(view).includes(token), 'view never carries a credential');

    // Colliding intents: pricing switches getPrice to cents, invoice keeps dollars.
    payload(await a.callTool({ name: 'hive_set_intent', arguments: { task: 'Make getPrice return integer cents', files: ['src/pricing.ts', 'src/catalog.ts'],
      symbols: ['src/pricing.ts#getPrice:function'], assumptions: [{ key: UNIT_KEY, value: 'cents' }] } }));
    payload(await b.callTool({ name: 'hive_set_intent', arguments: { task: 'Add buildReceipt with totals in dollars', files: ['src/invoice.ts'],
      symbols: ['src/invoice.ts#invoiceTotal:function'], assumptions: [{ key: UNIT_KEY, value: 'dollars' }] } }));
    for (const client of [a, b]) {
      const context = JSON.stringify(payload(await client.callTool({ name: 'hive_context', arguments: {} })));
      assert.match(context, /assumption_mismatch/);
      assert.match(context, /cents/);
    }

    // Ben's prompt hook (as Claude Code would call it, with JSON on stdin) delivers the finding as additionalContext.
    const hook = await run(['hook', 'prompt', '--client', 'claude'], ben, { input: JSON.stringify({ session_id: 'claude-ben', prompt: 'continue', cwd: ben.repo }) });
    assert.equal(hook.code, 0, hook.stderr);
    const hookOut = JSON.parse(hook.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    assert.equal(hookOut.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(hookOut.hookSpecificOutput.additionalContext, /\[assumption_mismatch\] pricing agent vs invoice agent/);

    // The scripted agent reads the finding and changes its work: the receipt now converts getPrice cents.
    payload(await b.callTool({ name: 'hive_set_intent', arguments: { task: 'Add buildReceipt; convert getPrice cents to dollars for display', files: ['src/invoice.ts'],
      symbols: ['src/invoice.ts#invoiceTotal:function', 'src/pricing.ts#getPrice:function'], assumptions: [{ key: UNIT_KEY, value: 'cents' }] } }));
    for (const client of [a, b]) {
      const context = JSON.stringify(payload(await client.callTool({ name: 'hive_context', arguments: {} })));
      assert.doesNotMatch(context, /assumption_mismatch/, 'the mismatch is gone once both agree on cents');
    }

    // Ana disconnects: bridge closed, credential revoked on the hub, Hive's config entries and credential removed.
    await a.close();
    const out = await run(['disconnect'], ana);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, /Revoked this connector credential/);
    assert.equal((await call(tokens.get('ana')!, '/me')).status, 401);
    assert.equal((await call(tokens.get('ben')!, '/me')).status, 200, "ben's credential is untouched");
    assert.ok(!existsSync(join(ana.repo, '.mcp.json')), '.mcp.json (created by connect) removed');
    assert.ok(!existsSync(join(ana.repo, '.claude', 'settings.local.json')), 'settings.local.json (created by connect) removed');
    assert.deepEqual(JSON.parse(readFileSync(join(ana.config, 'credentials.json'), 'utf8')), {});
    assert.ok(!(ana.repo in JSON.parse(readFileSync(join(ana.config, 'connections.json'), 'utf8'))));
    const after = (await call(ADMIN, '/command', { action: 'member_list' })).json as { member: string; connectors?: unknown[] }[];
    assert.equal(after.find(m => m.member === 'ana')?.connectors?.length ?? 0, 0);
  } finally {
    for (const client of clients) await client.close().catch(() => {});
    // Stop any background connector still running (ben's; ana's was stopped by disconnect).
    for (const user of users) if (existsSync(join(user.config, 'connections.json'))) await run(['disconnect'], user).catch(() => {});
    daemon.kill('SIGTERM');
    if (daemon.exitCode === null) await once(daemon, 'exit');
    for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
  }
});
