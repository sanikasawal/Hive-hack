import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CLI, isolatedEnv, makeRepo, runCli, startFakeHub } from './helpers.mjs';

const read = path => readFileSync(path, 'utf8');
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('connect (Claude Code): pairs, stores 0600 credential, merges config, starts connector; reconnect is byte-identical; disconnect removes only Hive', async () => {
  const hub = await startFakeHub({ approveAfter: 3 });
  const repo = makeRepo();
  const { env, config } = isolatedEnv();
  let nodePid = null;
  try {
    // Existing user configuration that must survive.
    mkdirSync(join(repo, '.claude'));
    const userSettings = { permissions: { allow: ['Bash(ls)'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }] } };
    writeFileSync(join(repo, '.claude', 'settings.local.json'), JSON.stringify(userSettings, null, 2));
    writeFileSync(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'other-server', args: ['--x'] } } }));

    const first = await runCli(['connect', '--hub', `${hub.url}/`, '--client', 'claude', '--yes', '--no-browser'], { cwd: repo, env });
    assert.equal(first.code, 0, first.stderr + first.stdout);
    assert.match(first.stdout, /Code: ABCD-EFGH/);
    assert.match(first.stdout, new RegExp(`${hub.url}/ui/pair/ABCDEFGH`));
    const lines = first.stdout.trim().split('\n');
    assert.equal(lines.at(-1), `Start or restart Claude Code in this folder. Your agent will appear at ${hub.url}/ui.`, 'exactly one next step, last');
    assert.equal(lines.filter(l => l.startsWith('Start or restart')).length, 1);

    // pair_start carried the normalized identity, never the raw remote.
    const start = hub.calls.find(c => c.action === 'pair_start').body;
    assert.deepEqual([start.repo.name.startsWith('hive-cli-repo-'), start.repo.identity, start.repo.rootCommit.length, start.client], [true, 'github.com/Acme/Widgets', 40, 'claude-code']);
    assert.ok(!JSON.stringify(start).includes('git@'));
    assert.ok(hub.calls.filter(c => c.action === 'pair_poll').length >= 3);

    // Credential: file store with mode 0600 and nothing secret elsewhere.
    const credFile = join(config, 'credentials.json');
    assert.equal(statSync(credFile).mode & 0o777, 0o600);
    const creds = JSON.parse(read(credFile));
    const [[account, token]] = Object.entries(creds);
    assert.equal(account, `${new URL(hub.url).host}|github.com/Acme/Widgets`);
    assert.ok(hub.tokens.has(token));
    const connections = JSON.parse(read(join(config, 'connections.json')));
    assert.deepEqual(Object.keys(connections), [repo]);
    assert.deepEqual([connections[repo].hub, connections[repo].repoIdentity, connections[repo].member, connections[repo].client], [hub.url, 'github.com/Acme/Widgets', 'alice', 'claude']);
    assert.ok(!read(join(config, 'connections.json')).includes(token), 'connections.json holds no secret');

    // Claude Code configuration.
    const settings = JSON.parse(read(join(repo, '.claude', 'settings.local.json')));
    assert.deepEqual(settings.permissions, userSettings.permissions);
    assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, 'echo mine');
    assert.equal(settings.hooks.PreToolUse[1].matcher, 'Edit|Write|MultiEdit');
    assert.equal(settings.hooks.PreToolUse[1].hooks[0].command, `${CLI} hook pre-write --client claude`);
    assert.equal(settings.hooks.PostToolUse[0].matcher, 'Edit|Write|MultiEdit|Bash');
    assert.equal(settings.hooks.UserPromptSubmit[0].hooks[0].command, `${CLI} hook prompt --client claude`);
    assert.equal(settings.hooks.SessionStart[0].hooks[0].command, `${CLI} hook session-start --client claude`);
    assert.deepEqual(settings.enabledMcpjsonServers, ['hive']);
    assert.equal(settings.env, undefined, 'no env (and no secrets) written');
    const mcp = JSON.parse(read(join(repo, '.mcp.json')));
    assert.deepEqual(mcp.mcpServers, { other: { command: 'other-server', args: ['--x'] }, hive: { command: CLI, args: ['mcp'] } });
    for (const file of ['.claude/settings.local.json', '.mcp.json']) assert.ok(!read(join(repo, file)).includes(token), `${file} holds no token`);
    const exclude = read(join(repo, '.git', 'info', 'exclude')).split('\n');
    assert.ok(exclude.includes('.claude/settings.local.json'));

    // Verification report and the background connector.
    assert.ok(hub.calls.some(c => c.action === 'checkout_report' && c.token === token));
    const pidFile = readdirSync(join(config, 'nodes')).find(f => f.endsWith('.pid'));
    nodePid = Number(read(join(config, 'nodes', pidFile)).trim());
    assert.ok(alive(nodePid), 'connector process is running');

    const status = await runCli(['status'], { cwd: repo, env });
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /Credential:\s+valid/);
    assert.match(status.stdout, new RegExp(`Connector:\\s+running \\(pid ${nodePid}\\)`));
    assert.match(status.stdout, /Member:\s+alice/);

    // Reconnect: no new pairing, byte-identical files.
    const snapshot = () => ['.claude/settings.local.json', '.mcp.json', '.git/info/exclude'].map(f => read(join(repo, f))).concat(read(join(config, 'connections.json')), read(credFile));
    const before = snapshot();
    const pairStarts = hub.calls.filter(c => c.action === 'pair_start').length;
    const second = await runCli(['connect', '--yes', '--no-browser'], { cwd: repo, env });
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /^Reconnected /m);
    assert.equal(hub.calls.filter(c => c.action === 'pair_start').length, pairStarts, 'reconnect does not pair again');
    assert.deepEqual(snapshot(), before, 'running connect twice leaves byte-identical files');
    const newPid = Number(read(join(config, 'nodes', pidFile)).trim());
    assert.ok(!alive(nodePid) || newPid === nodePid, 'old connector replaced');
    nodePid = newPid;

    // Disconnect.
    const out = await runCli(['disconnect'], { cwd: repo, env });
    assert.equal(out.code, 0, out.stderr);
    assert.ok(hub.calls.some(c => c.action === 'connector_disconnect' && c.token === token), 'token revoke called');
    assert.equal(hub.tokens.get(token).revoked, true);
    for (let i = 0; i < 20 && alive(nodePid); i++) await new Promise(r => setTimeout(r, 100));
    assert.ok(!alive(nodePid), 'connector stopped');
    assert.deepEqual(JSON.parse(read(join(repo, '.claude', 'settings.local.json'))), userSettings, 'only Hive entries removed from settings');
    assert.deepEqual(JSON.parse(read(join(repo, '.mcp.json'))), { mcpServers: { other: { command: 'other-server', args: ['--x'] } } });
    assert.deepEqual(JSON.parse(read(credFile)), {}, 'credential gone');
    assert.deepEqual(JSON.parse(read(join(config, 'connections.json'))), {});
    const after = await runCli(['status'], { cwd: repo, env });
    assert.equal(after.code, 2);
    assert.match(after.stdout, /not connected/);
  } finally {
    if (nodePid && alive(nodePid)) process.kill(nodePid, 'SIGKILL');
    await hub.close();
  }
});

test('connect with files it created: disconnect deletes them again; denied/invalid input exits 2', async () => {
  const hub = await startFakeHub({ approveAfter: 1 });
  const repo = makeRepo('https://github.com/acme/fresh.git');
  const { env } = isolatedEnv();
  try {
    const run = await runCli(['connect', '--hub', hub.url, '--client', 'claude', '--yes', '--no-browser', '--no-node'], { cwd: repo, env });
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /--no-node/);
    assert.ok(existsSync(join(repo, '.mcp.json')));
    const exclude = read(join(repo, '.git', 'info', 'exclude')).split('\n');
    assert.ok(exclude.includes('.mcp.json'), 'an untracked .mcp.json with a machine path is excluded from git');
    assert.equal((await runCli(['disconnect'], { cwd: repo, env })).code, 0);
    assert.ok(!existsSync(join(repo, '.mcp.json')) && !existsSync(join(repo, '.claude', 'settings.local.json')), 'files Hive created are removed when only Hive entries were in them');

    const bad = await runCli(['connect', '--hub', 'ftp://nope', '--yes'], { cwd: repo, env });
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /https:\/\//);
    const noTty = await runCli(['connect', '--hub', hub.url], { cwd: repo, env });
    assert.equal(noTty.code, 2, 'asking without a terminal is a user problem');
    assert.match(noTty.stderr, /--yes/);
    const outside = await runCli(['connect', '--hub', hub.url, '--yes'], { cwd: env.HOME, env });
    assert.equal(outside.code, 2);
    assert.match(outside.stderr, /not inside a git repository/);
  } finally { await hub.close(); }
});

test('connect (Muse Code): merges ~/.config/muse/settings.json with one backup and .muse/hooks.json; idempotent; disconnect restores', async () => {
  const hub = await startFakeHub({ approveAfter: 1 });
  const repo = makeRepo();
  const { env, home } = isolatedEnv();
  try {
    const museDir = join(home, '.config', 'muse');
    mkdirSync(museDir, { recursive: true });
    const userMuse = { theme: 'dark', mcp_servers: { mine: { transport: 'stdio', command: 'mine' } } };
    writeFileSync(join(museDir, 'settings.json'), JSON.stringify(userMuse));
    mkdirSync(join(repo, '.muse'));
    writeFileSync(join(repo, '.muse', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ command: 'my-linter' }] } }));

    const run = await runCli(['connect', '--hub', hub.url, '--client', 'muse', '--yes', '--no-browser', '--no-node'], { cwd: repo, env });
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout.trim().split('\n').at(-1), /^Start or restart Muse Code in this folder\. Your agent will appear at /);
    const settings = JSON.parse(read(join(museDir, 'settings.json')));
    assert.deepEqual(settings.mcp_servers.hive, { transport: 'stdio', command: CLI, args: ['mcp'], mode: 'optional' });
    assert.deepEqual(settings.mcp_servers.mine, userMuse.mcp_servers.mine);
    assert.equal(settings.theme, 'dark');
    const backups = readdirSync(museDir).filter(f => f.startsWith('settings.json.bak-'));
    assert.equal(backups.length, 1);
    assert.deepEqual(JSON.parse(read(join(museDir, backups[0]))), userMuse);
    const hooks = JSON.parse(read(join(repo, '.muse', 'hooks.json')));
    assert.match(hooks._comment, /best guess/);
    assert.equal(hooks.hooks.PreToolUse[0].command, 'my-linter');
    assert.equal(hooks.hooks.PreToolUse[1].command, `${CLI} hook pre-write --client muse`);

    const before = [read(join(museDir, 'settings.json')), read(join(repo, '.muse', 'hooks.json'))];
    assert.equal((await runCli(['connect', '--yes', '--no-browser', '--no-node'], { cwd: repo, env })).code, 0);
    assert.deepEqual([read(join(museDir, 'settings.json')), read(join(repo, '.muse', 'hooks.json'))], before);
    assert.equal(readdirSync(museDir).filter(f => f.startsWith('settings.json.bak-')).length, 1, 'still one backup');

    assert.equal((await runCli(['disconnect'], { cwd: repo, env })).code, 0);
    assert.deepEqual(JSON.parse(read(join(museDir, 'settings.json'))), userMuse);
    assert.deepEqual(JSON.parse(read(join(repo, '.muse', 'hooks.json'))).hooks, { PreToolUse: [{ command: 'my-linter' }] });
  } finally { await hub.close(); }
});
